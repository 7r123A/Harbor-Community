import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";

const require = createRequire(import.meta.url);

function load(path, mocks, globals = {}) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", ...Object.keys(globals), outputText)(
    (name) => {
      assert.ok(Object.hasOwn(mocks, name), `Unexpected dependency: ${name}`);
      return mocks[name];
    },
    module,
    module.exports,
    ...Object.values(globals),
  );
  return module.exports;
}

// What each source answers when it has nothing. For TMDB that is also the answer without a key.
const NOTHING = {
  tmdb: {
    query: "dune",
    topMatch: null,
    people: [],
    movies: [],
    series: [],
    liveTv: [],
    anime: [],
    manga: [],
    music: [],
    ebooks: [],
    sports: [],
    characters: [],
    addonGroups: [],
    addons: [],
    intent: null,
  },
  anime: [],
  manga: [],
  music: [],
  ebooks: [],
  sports: [],
  characters: [],
  addons: { movies: [], series: [] },
  addonGroups: [],
  cinemeta: { movies: [], series: [] },
};

// The real provider on the real installation store. Every source is a promise the test settles,
// and the typing pause is a timer the test fires.
async function mountSearch(t, { settings = {}, hiddenTabs = {}, localAddons = [] } = {}) {
  const dom = new JSDOM("<!doctype html><div id='app'></div>");
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  const asked = [];
  const pending = new Map();
  const source = (name) => () => {
    asked.push(name);
    return new Promise((resolve) => pending.set(name, resolve));
  };
  const probe = Promise.withResolvers();
  const timers = new Map();
  let nextTimer = 1;

  const install = load("src/lib/features/install.ts", {
    "@tauri-apps/api/core": { invoke: () => probe.promise },
    react: React,
  });
  const allSettings = {
    tmdbKey: "key",
    mangaEnabled: true,
    hideContent: {},
    metadataSources: {},
    metadataAddonOrder: [],
    ...settings,
  };
  const playlists = [];
  const { SearchProvider, useSearchActions, useSearchData } = load(
    "src/lib/search-context.tsx",
    {
      react: React,
      "react/jsx-runtime": require("react/jsx-runtime"),
      "./search-context-state": load("src/lib/search-context-state.ts", { react: React }),
      "@/lib/addons": { gatherCatalogAddons: async () => [] },
      "@/lib/anilist/character": { anilistCharacterSearch: source("characters") },
      "@/lib/anime-detect": { metaLooksAnime: () => false },
      "@/lib/auth": { useAuth: () => ({ authKey: null }) },
      "@/lib/ebook/api": { searchEBooks: source("ebooks") },
      "@/lib/features/install": install,
      "@/lib/feed/tags": { MOVIE_GENRES: { Animation: 16 } },
      "@/lib/iptv/playlists-store": { usePlaylists: () => playlists },
      "@/lib/manga/api": { searchManga: source("manga") },
      "@/lib/metadata-addons": { orderedMetadataAddons: (addons) => addons },
      "@/lib/metadata-sources": { addonKeyFromSource: () => null },
      "@/lib/music/catalog": { searchTyped: source("music") },
      "@/lib/parental": { useParental: () => ({ hiddenTabs }) },
      "@/lib/search": {
        searchAll: source("tmdb"),
        searchAnime: source("anime"),
        searchCinemeta: source("cinemeta"),
        searchLiveTvChannels: () => [],
      },
      "@/lib/search-addon-index": { searchAddonIndex: () => localAddons },
      "@/lib/search-addons": {
        createAddonSearchCatalogReader: () => null,
        mergeMetas: (primary, extra) => [...primary, ...extra],
        searchAddonCatalogs: source("addons"),
        searchAddonGroups: source("addonGroups"),
      },
      "@/lib/search-display-state": load("src/lib/search-display-state.ts", {
        "./search-query.ts": load("src/lib/search-query.ts", {}),
      }),
      "@/lib/search-music-hits": { toMusicHits: (hits) => hits },
      "@/lib/search-query": load("src/lib/search-query.ts", {}),
      "@/lib/search-request-guard": load("src/lib/search-request-guard.ts", {}),
      "@/lib/search-top-match": {
        addonTopMatch: () => null,
        addonsBeforeTmdb: () => [],
        animeTopMatch: () => null,
        prioritizedTopMatch: () => null,
        sameSearchTitle: () => false,
      },
      "@/lib/settings": { useSettings: () => ({ settings: allSettings }) },
      "@/lib/sports/search-events": { searchSportsEvents: source("sports") },
      "@/lib/torrent/magnet": { isDirectVideoUrl: () => false, isMagnetInput: () => false },
      "@/lib/view": { useView: () => ({ navDepth: 0, rootFrame: null }) },
    },
    {
      localStorage: { getItem: () => null, setItem: () => {} },
      window: {
        addEventListener: () => {},
        removeEventListener: () => {},
        setTimeout: (run) => {
          timers.set(nextTimer, run);
          return nextTimer++;
        },
        clearTimeout: (id) => timers.delete(id),
      },
    },
  );

  let data;
  let actions;
  const Reader = () => {
    data = useSearchData();
    actions = useSearchActions();
    return null;
  };
  const root = createRoot(document.querySelector("#app"));
  t.after(() => React.act(async () => root.unmount()));
  await React.act(async () =>
    root.render(React.createElement(SearchProvider, null, React.createElement(Reader))),
  );

  const act = (run) => React.act(async () => void run());
  const pauseTyping = () =>
    act(() => {
      const due = [...timers.values()];
      timers.clear();
      for (const run of due) run();
    });
  return {
    asked: () => [...asked].sort(),
    forget: () => asked.splice(0),
    results: () => data.results,
    status: () => data.status,
    // The overlay's own condition for its loading rows, as far as it depends on the search.
    loadingRows: () => !data.results && data.status !== "done",
    pauseTyping,
    async search(query) {
      await act(() => actions.setQuery(query));
      await pauseTyping();
    },
    installation: (features) => act(() => probe.resolve(features)),
    installationUnreadable: () => act(() => probe.reject(new Error("no native host"))),
    answer: (name, value = NOTHING[name]) => act(() => pending.get(name)(value)),
  };
}

const DUNE = { movies: [{ id: "tt1160419", type: "movie", name: "Dune" }], series: [] };

const QUERIED_ALWAYS = [
  "addonGroups",
  "addons",
  "anime",
  "characters",
  "cinemeta",
  "sports",
  "tmdb",
];

test("optional lookups wait until the installation is known", async (t) => {
  for (const [component, lookup] of [
    ["manga", "manga"],
    ["music", "music"],
    ["ebook", "ebooks"],
  ]) {
    await t.test(`only ${component} is installed`, async (t) => {
      const search = await mountSearch(t);
      await search.search("dune");
      // The boot watchdog let the app start while the native answer was still out. Until it is
      // here the store reports every component as installed, so it must not be acted on yet.
      assert.deepEqual(search.asked(), QUERIED_ALWAYS);

      search.forget();
      await search.installation({ manga: false, music: false, ebook: false, [component]: true });
      await search.pauseTyping();
      assert.deepEqual(search.asked(), [...QUERIED_ALWAYS, lookup].sort());
    });
  }
});

test("a search is not started over when no optional lookup was waiting", async (t) => {
  for (const [reason, options, installed] of [
    ["nothing optional is installed", {}, {}],
    ["manga is, with manga search off", { settings: { mangaEnabled: false } }, { manga: true }],
  ]) {
    await t.test(reason, async (t) => {
      const search = await mountSearch(t, options);
      await search.search("dune");
      await search.answer("addons", DUNE);
      search.forget();
      await search.installation({ manga: false, music: false, ebook: false, ...installed });
      await search.pauseTyping();
      assert.deepEqual(search.asked(), []);
      assert.equal(search.results()?.movies[0].name, "Dune");
    });
  }
});

test("every lookup runs where the installation cannot be read", async (t) => {
  const search = await mountSearch(t);
  await search.installationUnreadable();
  await search.search("dune");
  assert.deepEqual(search.asked(), [...QUERIED_ALWAYS, "ebooks", "manga", "music"].sort());
});

test("manga is not asked with manga search switched off", async (t) => {
  const search = await mountSearch(t, { settings: { mangaEnabled: false } });
  await search.installation({});
  await search.search("dune");
  assert.deepEqual(search.asked(), [...QUERIED_ALWAYS, "ebooks", "music"].sort());
});
