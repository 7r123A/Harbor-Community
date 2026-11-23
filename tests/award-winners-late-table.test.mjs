import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function load(path, mocks = {}, globals = {}) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
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

const TABLE = {
  oscar: {
    best_picture: {
      name: "Best Picture",
      entries: [
        { year: 2020, title: "Parasite", recipients: [] },
        { year: 2021, title: "Nomadland", recipients: [] },
      ],
    },
  },
};

// The real feed on the real award table, with the hosted list out of reach and nothing saved by
// an earlier session: the state in which the feed depends on the bundled table alone.
function winnersFeed() {
  const awards = load("src/lib/awards-history.ts");
  const lookups = [];
  const stored = new Map();
  const { fetchAwardWinners } = load(
    "src/lib/feed/award-winners.ts",
    {
      "@/lib/awards-history": awards,
      "@/lib/config/endpoints": { HARBOR_API_BASE: "https://hosted.invalid" },
      "@/lib/providers/tmdb": {
        tmdbSearchMovie: async (_key, title) => {
          lookups.push(title);
          return { id: `tmdb:movie:${title}`, type: "movie", name: title, poster: "poster" };
        },
      },
    },
    {
      fetch: async () => {
        throw new Error("hosted feed unavailable");
      },
      localStorage: {
        getItem: (key) => stored.get(key) ?? null,
        setItem: (key, value) => stored.set(key, value),
      },
    },
  );
  return {
    arrive: () => awards.setBundledAwards(TABLE),
    open: async () => (await fetchAwardWinners("tmdb-key")).map((meta) => meta.name),
    lookups,
    stored,
  };
}

test("the winners feed fills once an award table that came late is there", async () => {
  const feed = winnersFeed();
  assert.deepEqual(await feed.open(), []);
  feed.arrive();
  assert.deepEqual(await feed.open(), ["Nomadland", "Parasite"]);
});

test("winners that were looked up with the table in place are looked up once", async () => {
  const feed = winnersFeed();
  feed.arrive();
  assert.deepEqual(await feed.open(), ["Nomadland", "Parasite"]);
  assert.deepEqual(await feed.open(), ["Nomadland", "Parasite"]);
  assert.deepEqual(feed.lookups, ["Nomadland", "Parasite"]);
});

test("a list saved by an earlier session is shown without waiting for the table", async () => {
  const feed = winnersFeed();
  feed.stored.set("harbor.discover.awards.v1", JSON.stringify([{ id: "tt1", name: "Saved" }]));
  assert.deepEqual(await feed.open(), ["Saved"]);
  assert.deepEqual(feed.lookups, []);
});
