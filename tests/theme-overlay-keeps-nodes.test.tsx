import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { createRoot } from "react-dom/client";
import ts from "typescript";

function load(file: string, dependencies: Record<string, unknown>) {
  const output = ts.transpileModule(
    readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", output)((name: string) => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}

type Look = { id: string; css: string; js: string; html: string };

async function fixture(looks: Look[]) {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://fixture.invalid" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const state = {
    settings: {
      theme: { preset: looks[0].id },
      customCss: "",
      customJs: "",
      customHtml: "",
      unrelated: 0,
    },
    player: null as object | null,
    topKind: "home",
  };
  const libraryListeners = new Set<() => void>();
  // Look scripts note here what they heard.
  const heard: string[] = [];
  Object.assign(dom.window, { heard });
  const { CustomCodeMount } = load("components/custom-code-mount.tsx", {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "@/lib/settings": { useSettings: () => ({ settings: state.settings }) },
    "@/lib/theme": { getThemeById: (id: string) => looks.find((look) => look.id === id) ?? null },
    "@/lib/view": { useView: () => ({ player: state.player, topKind: state.topKind }) },
    "@/lib/theme-scan": { scanTheme: () => ({ verdict: "ok", findings: [] }) },
    "@/lib/custom-themes": {
      subscribeCustomThemes: (listener: () => void) => {
        libraryListeners.add(listener);
        return () => libraryListeners.delete(listener);
      },
    },
  }) as { CustomCodeMount: React.ComponentType };
  const root = createRoot(document.getElementById("root")!);
  const render = () => React.act(() => root.render(React.createElement(CustomCodeMount)));
  await render();
  const overlay = () => document.getElementById("harbor-custom-overlay")!;
  return {
    state,
    render,
    overlay,
    // What a store update of a saved theme does: same id, new content, subscribers told.
    libraryChanged: () => React.act(() => libraryListeners.forEach((listener) => listener())),
    heard,
    switchTo(id: string) {
      state.settings = { ...state.settings, theme: { preset: id } };
      return render();
    },
    highlighted: () =>
      [...overlay().querySelectorAll("[data-harbor-nav][data-active]")].map((el) =>
        el.getAttribute("data-harbor-nav"),
      ),
    async close() {
      await React.act(() => root.unmount());
      dom.window.close();
    },
  };
}

const railHtml =
  '<nav id="look-rail"><button data-harbor-nav="home">Home</button><button data-harbor-nav="library">Library</button></nav>';
const rail = (): Look => ({ id: "user:rail", css: "", js: "", html: railHtml });
const dock = (): Look => ({
  id: "user:dock",
  css: "",
  js: "",
  html: '<nav id="look-dock"><button data-harbor-nav="home">Home</button></nav>',
});

test("a look's own HTML is kept while the shell re-renders", async () => {
  const f = await fixture([rail(), dock()]);
  try {
    const home = f.overlay().querySelector<HTMLElement>('[data-harbor-nav="home"]')!;
    // What a look's script does to its buttons.
    let clicks = 0;
    home.addEventListener("click", () => {
      clicks += 1;
    });
    home.setAttribute("data-set-by-the-look", "");

    // Re-renders that leave the look's HTML as it is: another setting changes, the player opens.
    f.state.settings = { ...f.state.settings, unrelated: 1 };
    await f.render();
    f.state.player = { meta: { id: "tt0000001" } };
    await f.render();
    f.state.player = null;
    await f.render();

    assert.equal(
      f.overlay().querySelector('[data-harbor-nav="home"]'),
      home,
      "the button must be the same node, not a rebuilt copy",
    );
    assert.ok(home.hasAttribute("data-set-by-the-look"), "state the look put on it must survive");
    home.click();
    assert.equal(clicks, 1, "a listener the look attached must survive");
  } finally {
    await f.close();
  }
});

test("the look's HTML is replaced when the HTML itself changes", async () => {
  const f = await fixture([rail(), dock()]);
  try {
    assert.ok(f.overlay().querySelector("#look-rail"));

    f.state.settings = { ...f.state.settings, theme: { preset: "user:dock" } };
    await f.render();
    assert.equal(f.overlay().querySelector("#look-rail"), null);
    assert.ok(f.overlay().querySelector("#look-dock"));

    f.state.settings = { ...f.state.settings, customHtml: '<i id="own-html"></i>' };
    await f.render();
    assert.ok(f.overlay().querySelector("#own-html"), "Settings > Custom code HTML comes first");
    assert.ok(f.overlay().querySelector("#look-dock"));
  } finally {
    await f.close();
  }
});

test("the current view is marked in the look's navigation, and the mark follows the view", async () => {
  const f = await fixture([rail(), dock()]);
  try {
    assert.deepEqual(f.highlighted(), ["home"]);
    f.state.topKind = "library";
    await f.render();
    assert.deepEqual(f.highlighted(), ["library"]);
    // A view the look has no entry for: nothing stays highlighted.
    f.state.topKind = "meta";
    await f.render();
    assert.deepEqual(f.highlighted(), []);
  } finally {
    await f.close();
  }
});

test("markup that is swapped in is marked at once, whatever swapped it", async () => {
  const saved = rail();
  const f = await fixture([saved, dock()]);
  try {
    // Another look.
    f.state.settings = { ...f.state.settings, theme: { preset: "user:dock" } };
    await f.render();
    assert.deepEqual(f.highlighted(), ["home"]);

    // Custom HTML edited in Settings: the whole markup is rebuilt around it.
    f.state.settings = { ...f.state.settings, customHtml: "<i></i>" };
    await f.render();
    assert.deepEqual(f.highlighted(), ["home"]);

    // A store update of the active look: same id, no setting changes, only the library tells.
    f.state.settings = { ...f.state.settings, theme: { preset: "user:rail" }, customHtml: "" };
    await f.render();
    const before = f.overlay().querySelector("#look-rail");
    saved.html = railHtml.replace("Library", "My library");
    await f.libraryChanged();
    assert.notEqual(
      f.overlay().querySelector("#look-rail"),
      before,
      "the update swapped the markup",
    );
    assert.deepEqual(f.highlighted(), ["home"]);
  } finally {
    await f.close();
  }
});

test("a look's script finds the mark when it starts", async () => {
  const seen: string[][] = [];
  (globalThis as unknown as { recordHighlighted: () => void }).recordHighlighted = () => {
    seen.push(
      [...document.querySelectorAll("[data-harbor-nav][data-active]")].map(
        (el) => el.getAttribute("data-harbor-nav") ?? "",
      ),
    );
  };
  const scripted: Look = { ...rail(), id: "user:scripted", js: "recordHighlighted()" };
  const f = await fixture([scripted]);
  try {
    assert.deepEqual(seen, [["home"]]);
  } finally {
    await f.close();
    delete (globalThis as unknown as { recordHighlighted?: () => void }).recordHighlighted;
  }
});

test("the overlay is hidden, not rebuilt, while the player is open", async () => {
  const f = await fixture([rail()]);
  try {
    const node = f.overlay().firstElementChild;
    f.state.player = { meta: { id: "tt0000001" } };
    await f.render();
    assert.ok(f.overlay().classList.contains("hidden"));
    assert.equal(f.overlay().firstElementChild, node);
    f.state.player = null;
    await f.render();
    assert.ok(!f.overlay().classList.contains("hidden"));
    assert.equal(f.overlay().firstElementChild, node);
  } finally {
    await f.close();
  }
});

// Two things a look's script can do with the look's own nodes: listen on them, or take them out of
// the overlay and remove them again when it ends.
const listens = (name: string) => `
  document
    .querySelector('#look-rail [data-harbor-nav="home"]')
    .addEventListener("click", () => window.heard.push("${name}"));`;
const movesRail = (version: string) => `
  const rail = document.querySelector("#harbor-custom-overlay #look-rail");
  if (rail) document.body.append(rail);
  window.__harborThemeCleanup = () => rail?.remove(); // ${version}`;

const homeButton = () =>
  document.querySelector<HTMLElement>('#look-rail [data-harbor-nav="home"]')!;
const railParents = () =>
  [...document.querySelectorAll("#look-rail")].map((el) => el.parentElement!.tagName);

test("another look starts on new nodes even when its HTML is the same", async () => {
  // A look and a saved copy of it, without the script.
  const f = await fixture([
    { ...rail(), id: "user:first", js: listens("first") },
    { ...rail(), id: "user:copy" },
  ]);
  try {
    const overlay = f.overlay();
    const before = homeButton();
    before.click();
    assert.deepEqual(f.heard, ["first"]);

    await f.switchTo("user:copy");
    homeButton().click();
    assert.deepEqual(f.heard, ["first"], "the first look's listener must be gone");
    assert.notEqual(homeButton(), before, "the button must be a new node");
    assert.deepEqual(f.highlighted(), ["home"]);
    assert.equal(f.overlay(), overlay, "the overlay itself stays: the chrome bridge holds it");
  } finally {
    await f.close();
  }
});

test("another look with the same HTML and the same script has it running on its new nodes", async () => {
  // A copy saved with other colors only.
  const js = `${listens("click")}
    window.__harborThemeCleanup = () => window.heard.push("cleanup");`;
  const f = await fixture([
    { ...rail(), id: "user:first", js },
    { ...rail(), id: "user:copy", css: ":root { --color-accent: #e05; }", js },
  ]);
  try {
    const before = homeButton();
    await f.switchTo("user:copy");
    assert.notEqual(homeButton(), before);
    homeButton().click();
    assert.deepEqual(f.heard, ["cleanup", "click"], "the first run ended, the second listens once");
  } finally {
    await f.close();
  }
});

test("another look with the same HTML has its nodes when the last look's script took them along", async () => {
  const f = await fixture([
    { ...rail(), id: "user:first", js: movesRail("first") },
    { ...rail(), id: "user:copy", js: movesRail("copy") },
  ]);
  try {
    assert.deepEqual(railParents(), ["BODY"]);
    await f.switchTo("user:copy");
    assert.deepEqual(railParents(), ["BODY"], "one rail, the one the second script took");
  } finally {
    await f.close();
  }
});

test("another look without a script starts on new nodes too", async () => {
  // Two saved versions of one chrome from the Theme Studio, in different colors.
  const f = await fixture([
    { ...rail(), id: "user:first" },
    { ...rail(), id: "user:copy", css: ":root { --color-accent: #e05; }" },
  ]);
  try {
    homeButton().setAttribute("data-left-behind", "");
    await f.switchTo("user:copy");
    assert.ok(!homeButton().hasAttribute("data-left-behind"));
  } finally {
    await f.close();
  }
});

test("another look that is only a script starts it even when it is the same script", async () => {
  const js = `
    window.heard.push("start");
    window.__harborThemeCleanup = () => window.heard.push("end");`;
  const f = await fixture([
    { id: "user:first", css: "", js, html: "" },
    { id: "user:copy", css: "", js, html: "" },
  ]);
  try {
    await f.switchTo("user:copy");
    assert.deepEqual(f.heard, ["start", "end", "start"]);
  } finally {
    await f.close();
  }
});

test("the user's own HTML stays in place while looks without HTML and script are switched", async () => {
  const plain = (id: string): Look => ({ id, css: ".look { color: red; }", js: "", html: "" });
  const f = await fixture([plain("cool-grey"), plain("noir")]);
  try {
    f.state.settings = { ...f.state.settings, customHtml: '<button id="own">Mine</button>' };
    await f.render();
    const own = document.getElementById("own");
    assert.ok(own);
    // "custom" is the user's own palette, which is no look from the library.
    for (const id of ["noir", "custom", "cool-grey"]) {
      await f.switchTo(id);
      assert.equal(document.getElementById("own"), own, id);
    }
  } finally {
    await f.close();
  }
});
