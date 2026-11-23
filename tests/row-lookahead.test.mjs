import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { JSDOM } from "jsdom";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { createRoot } from "react-dom/client";

// Rows as the browser runs them while they are near but still off screen: it skips their contents
// (content-visibility), so the observers of their cells, their container and their track report
// nothing. Only the row itself is laid out.
async function withRows(run, { saved = null } = {}) {
  const dom = new JSDOM("<div id='app'></div>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    getComputedStyle: globalThis.getComputedStyle,
  };
  let frames = [];
  const timers = new Map();
  let id = 0;
  dom.window.setTimeout = (task, ms) => (timers.set(++id, { task, ms }), id);
  dom.window.clearTimeout = (timer) => timers.delete(timer);
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (task) => (frames.push({ id: ++id, task }), id),
    cancelAnimationFrame: (frame) => (frames = frames.filter((entry) => entry.id !== frame)),
  });
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    clientWidth: { configurable: true, get: () => 1000 },
    scrollWidth: { configurable: true, get: () => Math.max(1000, 170 * (cellsIn(0)?.length ?? 0)) },
  });
  const page = { column: undefined, isRendered: false };
  dom.window.getComputedStyle = () => ({ gridAutoColumns: page.column });
  globalThis.getComputedStyle = dom.window.getComputedStyle;
  dom.window.HTMLElement.prototype.checkVisibility = (options) =>
    !options?.contentVisibilityAuto || page.isRendered;
  const near = [];
  const seen = [];
  const cells = [];
  const widths = [];
  const renders = [];
  const settings = {
    posterScale: 1,
    rowTitleScale: 1,
    rowCardStyle: "poster",
    posterBackdropExpansion: false,
    posterDockMagnification: false,
  };
  const view = { rememberRowScroll: () => {}, recallRowScroll: () => saved };
  const mocks = {
    react: React,
    "react/jsx-runtime": jsx,
    "@/lib/poster-dock": { resetPosterDock: () => {}, updatePosterDock: () => {} },
    "@/lib/visibility": {
      observeResize: (el, callback) => {
        widths.push({ el, callback });
        return () => {};
      },
      observeWithin: (el, margin, callback) => {
        const row = el.classList.contains("harbor-row-shell");
        const list = !row ? cells : margin === "0px" ? seen : near;
        const entry = { el, callback };
        list.push(entry);
        return () => list.splice(list.indexOf(entry), 1);
      },
    },
    "@/lib/scroll-activity": { isScrollActive: () => false },
    "@/lib/settings": { useSettings: () => ({ settings }) },
    "@/lib/i18n": { useT: () => (s) => s, useUiLanguage: () => "en", isRtl: () => false },
    "@/lib/view": { useViewActions: () => view },
    "lucide-react": { ChevronLeft: () => null, ChevronRight: () => null },
    "./nav-arrow": { NavChevron: () => null },
  };
  const code = ts.transpileModule(
    readFileSync(new URL("../src/components/row.tsx", import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  const exports = {};
  new Function("require", "exports", code)((name) => mocks[name] ?? {}, exports);
  const root = createRoot(document.querySelector("#app"));
  const Card = React.memo(({ name }) => {
    renders.push(name);
    const width = React.useContext(exports.RowCardWidthContext);
    return React.createElement("button", { "data-width": width ?? undefined }, name);
  });
  const cards = (name, count) =>
    Array.from({ length: count }, (_, i) =>
      React.createElement(Card, { key: i, name: `${name}${i}` }),
    );
  const buttons = () => [...document.querySelectorAll("main button:not([aria-label])")];
  const cellsIn = (row) => {
    const track = document.querySelectorAll(".harbor-row-track")[row];
    return track && [...track.children].map((el) => cells.find((entry) => entry.el === el));
  };
  // The test's screen is 768 high and a row 300.
  const place = (top) => ({ top, bottom: top + 300 });
  const api = {
    Row: exports.Row,
    cards,
    renders,
    column: (value) => (page.column = value),
    browserRenders: (value) => (page.isRendered = value),
    skips: (name) =>
      !!buttons()
        .find((button) => button.textContent === name)
        ?.closest("[data-tv-skip]"),
    offset: () => document.querySelector(".harbor-row-track").scrollLeft,
    render: (...elements) =>
      React.act(() => root.render(React.createElement("main", null, ...elements))),
    row: (name, count = 20, props = {}) =>
      React.createElement(exports.Row, { key: name, ...props }, ...cards(name, count)),
    // The row's own box is measured even while its contents are skipped.
    measure: (width = 1000) =>
      React.act(async () => {
        for (const { el, callback } of widths)
          if (el.classList.contains("harbor-row-shell")) callback({ width, height: 300 });
        await Promise.resolve();
      }),
    // The container only reports while the browser renders the row.
    container: (width) =>
      React.act(async () => {
        for (const { el, callback } of widths)
          if (el.classList.contains("group/row")) callback({ width, height: 300 });
        await Promise.resolve();
      }),
    near: (...tops) =>
      React.act(() =>
        tops.forEach((top, i) =>
          near[i].callback({ isIntersecting: true, boundingClientRect: place(top) }),
        ),
      ),
    far: () =>
      React.act(() =>
        near.forEach(({ callback }) =>
          callback({ isIntersecting: false, boundingClientRect: place(3000) }),
        ),
      ),
    seen: (...rows) =>
      React.act(() => rows.forEach((isIntersecting, i) => seen[i]?.callback({ isIntersecting }))),
    // The observers of cells report in a row the browser renders; in one it skips they say no.
    rendered: (from, to) =>
      React.act(() =>
        cellsIn(0)
          .slice(from, to + 1)
          .forEach(({ callback }) =>
            callback({ isIntersecting: true, boundingClientRect: place(600) }),
          ),
      ),
    beside: (from, to) =>
      React.act(() =>
        cellsIn(0)
          .slice(from, to + 1)
          .forEach(({ callback }) =>
            callback({ isIntersecting: false, boundingClientRect: place(600) }),
          ),
      ),
    skipped: (row = 0) =>
      React.act(() =>
        cellsIn(row).forEach(({ callback }) =>
          callback({ isIntersecting: false, boundingClientRect: place(0) }),
        ),
      ),
    push: (offset) =>
      React.act(() => {
        const track = document.querySelector(".harbor-row-track");
        track.scrollLeft = offset;
        track.dispatchEvent(new dom.window.Event("scroll"));
      }),
    frame: () =>
      React.act(async () => {
        const due = frames;
        frames = [];
        due.forEach(({ task }) => task(0));
        await Promise.resolve();
      }),
    settle: async () => {
      for (let i = 0; i < 12; i++) await api.frame();
    },
    framesWanted: () => frames.length,
    after: (ms) =>
      React.act(() => {
        for (const [timer, entry] of Array.from(timers))
          if (entry.ms <= ms && timers.delete(timer)) entry.task();
      }),
    built: (name = "") =>
      buttons()
        .map((button) => button.textContent)
        .filter((text) => text.startsWith(name)),
    width: (name) => buttons().find((button) => button.textContent === name)?.dataset.width,
  };
  try {
    await run(api);
  } finally {
    await React.act(() => root.unmount());
    dom.window.close();
    Object.assign(globalThis, previous);
  }
}
const names = (from, to, name = "card") =>
  Array.from({ length: to - from + 1 }, (_, i) => `${name}${from + i}`);

// 1000 px hold six cards of 150 px with a gap of 20 px.
test("a near row builds the cards it will show although the browser still skips it", async () => {
  await withRows(async (page) => {
    await page.render(page.row("card"));
    await page.measure();
    await page.settle();
    assert.deepEqual(page.built(), [], "nothing is built for a row that is far away");
    await page.near(1400);
    await page.settle();
    assert.deepEqual(page.built(), names(0, 5));
  });
});

test("cards that were built ahead stay while their row is near and skipped, and go with it", async () => {
  await withRows(async (page) => {
    await page.render(page.row("card"));
    await page.measure();
    await page.near(1400);
    await page.settle();
    await page.skipped();
    await page.after(60_000);
    assert.deepEqual(
      page.built(),
      names(0, 5),
      "an observer in a skipped row says nothing about its cards",
    );
    await page.far();
    await page.settle();
    await page.after(60_000);
    assert.deepEqual(page.built(), []);
  });
});

test("what is on screen is built first, wherever the rows were when their cards were queued", async () => {
  await withRows(async (page) => {
    await page.render(page.row("passed", 6), page.row("seen", 6));
    await page.measure();
    await page.settle();
    await page.near(700, 1040);
    await page.seen(false, true);
    await page.frame();
    assert.deepEqual(page.renders, names(0, 5, "seen"), "and nothing else in the same frame");
    await page.frame();
    assert.deepEqual(page.built("passed"), names(0, 0, "passed"), "the rest one by one");
    await page.settle();
    assert.deepEqual(page.built("passed"), names(0, 5, "passed"));
  });
});

test("a row that has left the screen gives way to the rows that are still to come", async () => {
  await withRows(async (page) => {
    await page.render(page.row("passed", 6), page.row("next", 6));
    await page.measure();
    await page.settle();
    await page.near(700, 1040);
    await page.skipped(0);
    await page.settle();
    assert.deepEqual(page.renders.slice(0, 6), names(0, 5, "next"));
    assert.deepEqual(page.built("passed"), names(0, 5, "passed"));
  });
});

test("the cards a row shows are built before the ones next to them", async () => {
  await withRows(async (page) => {
    await page.render(page.row("card"));
    await page.measure();
    await page.settle();
    await page.near(1400);
    await page.settle();
    await page.far();
    await page.after(60_000);
    await page.near(600);
    await page.seen(true);
    await page.rendered(6, 7);
    await page.frame();
    assert.deepEqual(page.built(), names(0, 5));
    await page.settle();
    assert.deepEqual(page.built(), names(0, 7));
  });
});

test("a row tells the cards it shows their width, and only those", async () => {
  await withRows(async (page) => {
    await page.render(page.row("card"));
    await page.measure();
    await page.near(1400);
    await page.settle();
    await page.rendered(6, 6);
    await page.settle();
    assert.equal(page.width("card0"), "150.015625");
    assert.deepEqual(page.built(), names(0, 6));
    assert.equal(page.width("card6"), undefined, "its picture waits until it comes closer");
  });
});

test("a row that changes its width does not render its cards again", async () => {
  await withRows(async (page) => {
    await page.render(page.row("card"));
    await page.measure();
    await page.near(1400);
    await page.settle();
    const before = page.renders.length;
    await page.measure(1180);
    await page.after(200);
    await page.settle();
    assert.equal(page.renders.length, before);
  });
});

test("a row that is far away is not measured", async () => {
  await withRows(async (page) => {
    await page.render(page.row("card"));
    await page.settle();
    assert.equal(page.framesWanted(), 0);
    await page.measure();
    assert.equal(page.framesWanted(), 0, "its width is kept for later");
    await page.near(1400);
    await page.settle();
    assert.equal(page.width("card0"), "150.015625");
    await page.measure();
    assert.equal(page.framesWanted(), 0, "only its height changed");
  });
});

test("a row that opens at a saved sideways position prepares the cards it shows there", async () => {
  await withRows(
    async (page) => {
      await page.render(page.row("card", 40, { scrollKey: "row" }));
      // Offsets are whole pixels: ten cards and gaps are 1700.16.
      await page.near(1400);
      await page.measure();
      await page.settle();
      assert.deepEqual(page.built(), names(10, 15));
    },
    { saved: 1700 },
  );
});

test("a row that was pushed sideways keeps the cards it shows, not the ones it showed first", async () => {
  await withRows(async (page) => {
    await page.render(page.row("card", 40));
    await page.measure();
    await page.near(1400);
    await page.settle();
    await page.push(1700);
    await page.rendered(10, 15);
    await page.settle();
    await page.skipped();
    await page.after(60_000);
    assert.deepEqual(page.built(), names(10, 15));
  });
});

test("a cell that takes several columns counts with all of them", async () => {
  await withRows(async (page) => {
    const wide = React.createElement(
      "div",
      { key: "wide", style: { gridColumn: "span 4" } },
      page.cards("wide", 1),
    );
    await page.render(
      React.createElement(page.Row, { key: "row" }, wide, ...page.cards("card", 9)),
    );
    await page.measure();
    await page.settle();
    await page.near(1400);
    await page.settle();
    assert.deepEqual(page.built(), ["wide0", "card0", "card1"]);
    assert.equal(page.width("wide0"), "660.0625");
  });
});

test("a row that is near while it still shows placeholders keeps its saved position for its cards", async () => {
  await withRows(
    async (page) => {
      const row = (props, ...children) =>
        React.createElement(page.Row, { key: "row", scrollKey: "row", ...props }, ...children);
      const placeholders = Array.from({ length: 6 }, (_, i) =>
        React.createElement("div", { key: `empty${i}` }),
      );
      await page.render(row({ alwaysActive: true }, ...placeholders));
      await page.measure();
      await page.near(1400);
      await page.settle();
      await page.render(row({ alwaysActive: false }, ...page.cards("card", 40)));
      await page.settle();
      assert.equal(page.offset(), 1700);
      assert.deepEqual(page.built(), names(10, 15));
    },
    { saved: 1700 },
  );
});

test("a near row follows a new width once it has settled", async () => {
  await withRows(async (page) => {
    await page.render(page.row("card"));
    await page.measure();
    await page.near(1400);
    await page.settle();
    for (const width of [1040, 1120, 1200]) await page.measure(width);
    assert.equal(page.framesWanted(), 0, "nothing while it still changes");
    await page.after(200);
    await page.settle();
    await page.far();
    await page.after(60_000);
    await page.near(1400);
    await page.settle();
    // 1200 px hold seven cards.
    assert.deepEqual(page.built(), names(0, 6));
  });
});

test("a row that was on screen before follows the new width too", async () => {
  await withRows(async (page) => {
    await page.render(page.row("card"));
    await page.measure();
    await page.near(100);
    await page.container(1000);
    await page.settle();
    await page.far();
    await page.after(60_000);
    await page.measure(1200);
    await page.after(200);
    await page.settle();
    await page.near(1400);
    await page.settle();
    assert.deepEqual(page.built(), names(0, 6));
  });
});

test("a theme that gives the track its own columns decides what is shown and how wide it is", async () => {
  await withRows(async (page) => {
    page.column("280px");
    await page.render(page.row("card"));
    await page.measure();
    await page.near(1400);
    await page.settle();
    // 1000 px show four columns of 280 px with a gap of 20 px.
    assert.deepEqual(page.built(), names(0, 3));
    assert.equal(page.width("card0"), "280");
  });
});

test("a track whose columns have no fixed width prepares nothing", async () => {
  await withRows(async (page) => {
    page.column("minmax(0px, 1fr)");
    await page.render(page.row("card"));
    await page.measure();
    await page.near(1400);
    await page.settle();
    assert.deepEqual(page.built(), []);
    await page.rendered(0, 2);
    await page.settle();
    assert.deepEqual(page.built(), names(0, 2), "its observers still do");
    assert.equal(page.width("card0"), undefined);
  });
});

test("arrow keys do not see a prepared card before its row is rendered", async () => {
  await withRows(async (page) => {
    await page.render(page.row("card"));
    await page.measure();
    await page.near(1400);
    await page.settle();
    assert.equal(page.skips("card0"), true);
    await page.rendered(0, 5);
    assert.equal(page.skips("card0"), false);
  });
});

test("arrow keys see the cards of a row that was rendered before they were built", async () => {
  await withRows(async (page) => {
    await page.render(page.row("card"));
    await page.measure();
    await page.near(600);
    await page.rendered(0, 5);
    await page.settle();
    assert.deepEqual(page.built(), names(0, 5));
    assert.equal(page.skips("card0"), false);
  });
});

test("a manga row says that it shows placeholders, as the Discover and Music rails do", () => {
  const source = readFileSync(
    new URL("../src/views/manga/manga-poster-row.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /alwaysActive=\{alwaysActive \|\| items === null\}/);
});

test("a near row that the browser renders leaves its cards to their observers", async () => {
  await withRows(async (page) => {
    page.browserRenders(true);
    await page.render(page.row("card"));
    await page.measure();
    await page.near(1400);
    await page.settle();
    assert.deepEqual(page.built(), []);
    await page.rendered(0, 6);
    await page.settle();
    assert.deepEqual(page.built(), names(0, 6));
  });
});

test("a rendered row reads the columns of its theme when it builds a card", async () => {
  await withRows(async (page) => {
    await page.render(page.row("card"));
    await page.measure();
    await page.near(1400);
    await page.settle();
    assert.equal(page.width("card5"), "150.015625");
    // On screen the theme's script has made the columns narrower: eight of them are in view.
    page.browserRenders(true);
    page.column("100px");
    await page.rendered(0, 8);
    await page.settle();
    assert.equal(page.width("card7"), "100");
    assert.equal(page.width("card0"), "150.015625", "a card that is built keeps what it was told");
  });
});

test("a rendered row gives up cells that the columns of its theme push out of view", async () => {
  await withRows(async (page) => {
    page.browserRenders(true);
    await page.render(page.row("card"));
    await page.measure();
    await page.near(1400);
    await page.settle();
    await page.beside(0, 19);
    await page.rendered(0, 7);
    // The theme's script widens the track: four cards are in view, a fifth is next to them.
    page.column("280px");
    await page.beside(5, 7);
    await page.settle();
    assert.deepEqual(page.built(), names(0, 4));
  });
});

test("a row that was on screen when it came near keeps its cards when the browser skips it later", async () => {
  await withRows(async (page) => {
    page.browserRenders(true);
    await page.render(page.row("card"));
    await page.measure();
    await page.near(100);
    await page.settle();
    await page.rendered(0, 5);
    await page.settle();
    page.browserRenders(false);
    await page.skipped();
    await page.after(60_000);
    assert.deepEqual(page.built(), names(0, 5));
  });
});
