import assert from "node:assert/strict";
import test from "node:test";
import { loadModule, readSource } from "../scripts/benchmark-discover.mjs";

function scrollActivity() {
  const timers = new Map();
  const attributes = new Set();
  let id = 0;
  const activity = loadModule(
    readSource("src/lib/scroll-activity.ts"),
    {},
    {
      document: {
        documentElement: {
          hasAttribute: (name) => attributes.has(name),
          setAttribute: (name) => attributes.add(name),
          removeAttribute: (name) => attributes.delete(name),
        },
      },
      window: {
        setTimeout: (task) => (timers.set(++id, task), id),
        clearTimeout: (timer) => timers.delete(timer),
      },
    },
  );
  return {
    ...activity,
    attributes,
    settle: () => {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach((task) => task());
    },
  };
}

// The queue of row.tsx with the real scroll activity: how many cards does one frame build?
function cardsPerFrame(isScrollActive) {
  const source = readSource("src/components/row.tsx");
  const start = source.indexOf("const CARD_UPDATES_DURING_SCROLL");
  const end = source.indexOf("export type RowShape", start);
  assert.ok(start >= 0 && end > start);
  const frames = [];
  const { queueRowCardUpdate } = loadModule(
    source.slice(start, end),
    {},
    {
      isScrollActive,
      startTransition: (task) => task(),
      requestAnimationFrame: (task) => frames.push(task),
      cancelAnimationFrame: () => {},
    },
  );
  let built = 0;
  for (let i = 0; i < 20; i++) queueRowCardUpdate(() => built++);
  frames.shift()();
  return built;
}

test("cards are held back while the user scrolls, not while a page puts its saved position back", () => {
  const activity = scrollActivity();
  assert.equal(cardsPerFrame(activity.isScrollActive), 6);
  activity.noteScrollActivity(false);
  assert.equal(cardsPerFrame(activity.isScrollActive), 6);
  activity.noteScrollActivity();
  assert.equal(cardsPerFrame(activity.isScrollActive), 1);
  activity.settle();
  assert.equal(cardsPerFrame(activity.isScrollActive), 6);
  activity.noteScrollActivity(false);
  assert.equal(cardsPerFrame(activity.isScrollActive), 6, "the gesture before it is over");
});

test("a page that moves by itself still counts as moving for everything else", () => {
  const activity = scrollActivity();
  const ran = [];
  activity.noteScrollActivity(false);
  assert.equal(activity.isPageMoving(), true);
  assert.ok(activity.attributes.has("data-scrolling"));
  activity.runAfterScroll(() => ran.push("rating"));
  assert.deepEqual(ran, []);
  activity.settle();
  assert.deepEqual(ran, ["rating"]);
  assert.equal(activity.isPageMoving(), false);
  assert.equal(activity.attributes.size, 0);
});

// useScrollMemory on a page of the given height, with the saved position it opens at.
function openPage(saved) {
  const source = readSource("src/lib/view.tsx");
  const start = source.indexOf("function anchorOffsetIn(");
  const end = source.indexOf("\n}", source.indexOf("export function useScrollMemory", start));
  assert.ok(start >= 0 && end > start);
  const listeners = new Map();
  const keys = new Map();
  const notes = [];
  let close;
  let now = 5000;
  const scroller = {
    style: {},
    scrollTop: 0,
    clientHeight: 800,
    scrollHeight: 6000,
    closest: () => null,
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: (event, handler) => listeners.set(event, handler),
    removeEventListener: (event) => listeners.delete(event),
  };
  const { useScrollMemory } = loadModule(
    source.slice(start, end + 2),
    {},
    {
      useView: () => ({
        rememberScroll: () => {},
        recallScroll: () => saved,
        registerScrollSave: () => () => {},
      }),
      useSettings: () => ({ settings: { smoothScroll: false } }),
      useSmoothWheel: () => {},
      useEffect: () => {},
      useLayoutEffect: (effect) => (close = effect()),
      noteScrollActivity: (gesture) => notes.push(gesture),
      performance: { now: () => now },
      ResizeObserver: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
      CSS: { escape: (value) => value },
      window: {
        setTimeout: () => 1,
        addEventListener: (event, handler) => keys.set(event, handler),
        removeEventListener: (event) => keys.delete(event),
      },
      clearTimeout: () => {},
    },
  );
  useScrollMemory("home", { current: scroller });
  return {
    scroller,
    listeners,
    keys,
    close: () => close(),
    scrollEventAfter: (ms) => {
      now = 5000 + ms;
      listeners.get("scroll")();
      return notes.at(-1);
    },
  };
}

test("the first scroll events of a page that opens at its saved position are not a gesture", () => {
  const page = openPage({ fallback: 1500, delta: 0 });
  assert.equal(page.scroller.scrollTop, 1500);
  assert.equal(page.scrollEventAfter(90), false, "the position that was put back");
  assert.equal(
    page.scrollEventAfter(600),
    false,
    "the anchor kept while rows replace placeholders",
  );
  assert.equal(page.scrollEventAfter(1500), true, "a gesture later on");
});

test("the first input of the user makes every scroll a gesture again", () => {
  for (const type of ["wheel", "pointerdown", "touchstart", "keydown"]) {
    const page = openPage({ fallback: 1500, delta: 0 });
    assert.equal(page.scrollEventAfter(90), false);
    (page.listeners.get(type) ?? page.keys.get(type))();
    assert.equal(page.scrollEventAfter(120), true, type);
    page.close();
    assert.equal(page.listeners.size + page.keys.size, 0);
  }
});

test("a page that opens at the top has nothing to put back, so every scroll is a gesture", () => {
  assert.equal(openPage(undefined).scrollEventAfter(90), true);
  assert.equal(openPage({ fallback: 0, delta: 0 }).scrollEventAfter(90), true);
});

test("hover previews ignore a page that moves, whoever moves it", () => {
  const source = readSource("src/lib/hover-preview/store.ts");
  assert.match(source, /hoverPreviewEnter\([\s\S]*?if \(isPageMoving\(\)\) return;/);
  assert.doesNotMatch(source, /isScrollActive/);
});
