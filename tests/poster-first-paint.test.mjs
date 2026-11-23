import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { JSDOM } from "jsdom";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { createRoot } from "react-dom/client";
import * as imgSize from "../src/lib/img-size.ts";
import { createObjectUrlCache } from "../src/lib/object-url-cache.ts";
import { createRequestScheduler } from "../src/lib/request-scheduler.ts";

const POSTER = "https://image.tmdb.org/t/p/w500/title.jpg";
const SMALL = "https://image.tmdb.org/t/p/w300/title.jpg";
const address = (url) => `asset:${url}`;

// Poster with the real image proxy: only the native side, the observers and the pixels are stand-ins.
async function withPosters(run) {
  const dom = new JSDOM("<div id='app'></div>", { url: "http://localhost/" });
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  window.__TAURI_INTERNALS__ = {};
  Object.defineProperties(dom.window.HTMLImageElement.prototype, {
    complete: { get: () => false, configurable: true },
    naturalWidth: { get: () => 0, configurable: true },
  });
  const settings = { posterEffect: "off", posterQuality: "high" };
  const observers = { near: new Set(), size: new Set() };
  const observe = (set) => (callback) => {
    set.add(callback);
    return () => set.delete(callback);
  };
  const pool = createObjectUrlCache();
  const mocks = {
    react: React,
    "react/jsx-runtime": jsx,
    "./row": {
      ScrollRootContext: React.createContext(null),
      resolveRowScrollRoot: () => undefined,
    },
    "./object-url-cache": { createObjectUrlCache: () => pool },
    "./request-scheduler": { createRequestScheduler },
    "@tauri-apps/api/core": {
      convertFileSrc: (path) => path,
      invoke: async (command, { url }) => {
        assert.equal(command, "cached_thumb_path");
        return address(url);
      },
    },
    "@/lib/manga/sources/suwayomi/auth-registry": { suwayomiAuthFor: () => undefined },
    "@/lib/idb-cache": { idbCacheKeys: async () => [], idbCacheGet: async () => null },
    "@/lib/settings": { useSettings: () => ({ settings }) },
    "@/lib/img-size": imgSize,
    "@/lib/visibility": {
      observeWithin: (_el, _margin, callback) => observe(observers.near)(callback),
      observeResize: (_el, callback) => observe(observers.size)(callback),
    },
    "@/lib/render-cause": { noteProbe: () => {}, recordRenderCause: () => {} },
  };
  const load = (file) => {
    const code = ts.transpileModule(
      readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"),
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
    return exports;
  };
  mocks["@/lib/remote-image-proxy"] = load("lib/remote-image-proxy.ts");
  const { Poster } = load("components/poster.tsx");
  const root = createRoot(document.querySelector("#app"));
  const card = (props) =>
    React.act(() =>
      root.render(
        React.createElement(Poster, {
          src: POSTER,
          seed: "title",
          lazy: "release",
          ...props,
        }),
      ),
    );
  const image = () => document.querySelector(".harbor-poster-img");
  const poster = {
    // A row tells its width to the cards it shows. Nothing else does.
    inRow: (props) => card({ cardWidth: 150, ...props }),
    inGrid: (props) => card(props),
    measure: (width) =>
      React.act(() => observers.size.forEach((cb) => cb({ width, height: width * 1.5 }))),
    comeNear: () => React.act(() => observers.near.forEach((cb) => cb({ isIntersecting: true }))),
    src: () => image()?.getAttribute("src"),
    revealed: () => document.querySelector(".harbor-poster").hasAttribute("data-loaded"),
  };
  try {
    await run(poster);
  } finally {
    await React.act(() => root.unmount());
    pool.clear();
    dom.window.close();
    Object.assign(globalThis, previous);
  }
}

test("a card that knows its width from its row loads its poster without an observer", async () => {
  await withPosters(async (poster) => {
    await poster.inRow();
    assert.equal(poster.src(), address(SMALL));
    assert.equal(poster.revealed(), false);
    await poster.measure(150);
    assert.equal(poster.src(), address(SMALL), "the measured size asks for the same picture");
  });
});

test("a card without that width waits for its size and for the observer", async () => {
  await withPosters(async (poster) => {
    await poster.inGrid();
    await poster.measure(150);
    assert.equal(poster.src(), undefined);
    await poster.comeNear();
    assert.equal(poster.src(), address(SMALL));
  });
});

test("the poster card hands the width its row tells it to its poster", () => {
  const card = readFileSync(new URL("../src/components/pick-card.tsx", import.meta.url), "utf8");
  assert.match(card, /const rowCardWidth = useContext\(RowCardWidthContext\);/);
  assert.match(card, /lazy="release"\s+cardWidth=\{rowCardWidth \?\? undefined\}/);
});
