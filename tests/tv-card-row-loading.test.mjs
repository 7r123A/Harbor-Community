import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const jsx = (type, props) => ({ type, props });
const RowCardWidthContext = { name: "RowCardWidthContext" };

// The real card with its artwork; the lookups it makes have nothing to say here.
function wideCard({ row, meta }) {
  const code = ts.transpileModule(
    readFileSync(new URL("../src/components/tv-card.tsx", import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  const settings = { tvCardOptions: {}, tvCardLogoPos: "bottomStart", posterRadius: 12 };
  const shared = { inWatchlist: false, watched: false };
  const mocks = {
    react: {
      memo: (component) => component,
      useContext: (context) => {
        assert.equal(context, RowCardWidthContext);
        return row;
      },
      useEffect: () => {},
      useRef: (current) => ({ current }),
      useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
    },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" },
    "./row": { RowCardWidthContext },
    "@/lib/settings": { useSettings: () => ({ settings }) },
    "@/lib/view": { useViewActions: () => ({}) },
    "@/lib/context-menu": { useContextMenu: () => ({}) },
    "@/lib/logo": { peekCachedLogo: () => "https://logo.example/title.png" },
    "@/lib/img-size": { sizeImageUrl: (url) => url },
    "@/lib/i18n": { useT: () => (text) => text },
    "@/lib/card-anime": { isCardAnimeId: () => false },
    "@/lib/anime-awards": { parseAwardYear: () => undefined, findTopAward: () => null },
    "@/lib/providers/tmdb": { useTmdbImdbId: () => undefined },
    "@/components/poster": { usePosterChain: () => ({ src: meta.poster }) },
    "@/components/card-award": { useClassicAwardWin: () => null },
    "@/components/card-status-badges": { stackTop: () => "top-2" },
    "@/components/use-card-shared-state": { useCardSharedState: () => shared },
    "@/components/use-card-score-state": { useCardScoreState: () => ({ cardBadges: [] }) },
    "@/lib/expanding-card-artwork": { expandingCardArtworkKey: (title) => title.id },
  };
  const exports = {};
  new Function("require", "exports", code)((name) => mocks[name] ?? {}, exports);
  const find = (node, test) => {
    if (!node || typeof node !== "object") return [];
    if (Array.isArray(node)) return node.flatMap((child) => find(child, test));
    if (typeof node.type === "function" && node.type === exports.TvCardArtwork)
      return find(exports.TvCardArtwork(node.props), test);
    return [...(test(node) ? [node] : []), ...find(node.props?.children, test)];
  };
  return find(exports.TvCard({ meta }), (node) => node.type === "img");
}

const meta = {
  id: "tt1",
  type: "movie",
  name: "Title",
  poster: "https://poster.example/title.jpg",
  background: "https://wide.example/title.jpg",
};
const loading = (images, src) => images.find((image) => image.props.src === src)?.props.loading;

test("a wide card in a row loads its artwork without waiting to be on screen", () => {
  const images = wideCard({ row: 318, meta });
  assert.equal(loading(images, meta.background), "eager");
  assert.equal(loading(images, "https://logo.example/title.png"), "eager");
  const fallback = wideCard({ row: 318, meta: { ...meta, background: undefined } });
  assert.equal(loading(fallback, meta.poster), "eager");
});

test("a wide card in a grid still loads its artwork when it comes close", () => {
  const images = wideCard({ row: null, meta });
  assert.equal(loading(images, meta.background), "lazy");
  assert.equal(loading(images, "https://logo.example/title.png"), "lazy");
});
