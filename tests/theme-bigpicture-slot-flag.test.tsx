import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import * as ReactDOM from "react-dom";
import * as jsxRuntime from "react/jsx-runtime";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { pageLevelHasSelectors } from "./helpers/page-level-has.ts";

const FLAG = "data-harbor-bigpicture-slot";

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

async function fixture(markup: string) {
  const dom = new JSDOM(
    `<div id="look">${markup}</div><div id="harbor-custom-overlay"></div><div id="root"></div>`,
    { url: "https://fixture.invalid" },
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    HTMLImageElement: dom.window.HTMLImageElement,
    Element: dom.window.Element,
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  // The bridge rescans on a timer; the test runs those scans by hand.
  const scans: Array<() => void> = [];
  dom.window.setInterval = ((fn: () => void) => scans.push(fn)) as typeof dom.window.setInterval;
  dom.window.clearInterval = (() => {}) as typeof dom.window.clearInterval;

  const state = {
    settings: { theme: { preset: "user:one" }, customHtml: "", harborAvatar: null },
    preview: null as { layout: string } | null,
  };
  const nothing = () => null;
  const { ThemeChromeBridge } = load("components/theme-chrome-bridge.tsx", {
    react: React,
    "react-dom": ReactDOM,
    "react/jsx-runtime": jsxRuntime,
    "@/chrome/account-menu/account-menu-floating": { AccountMenuFloating: nothing },
    "@/chrome/sidebar/status-control": { StatusPicker: nothing },
    "@/components/notification-center/notification-center": { NotificationCenter: nothing },
    "@/lib/auth": { useAuth: () => ({ user: null }) },
    "@/lib/profiles": { useActiveKid: () => null, useProfiles: () => ({ activeProfile: null }) },
    "@/lib/settings": { useSettings: () => ({ settings: state.settings }) },
    "@/lib/nuvio/nuvio-client": { isNuvioProviderActive: () => false },
    "@/lib/social/account-menu-open": { anchorFromElement: nothing, openAccountMenu: nothing },
    "@/lib/social/notification-open": { openNotificationCenter: nothing },
    "@/lib/social/presence": {
      currentStatus: () => "online",
      setStatus: nothing,
      subscribeStatus: () => () => {},
    },
    "@/lib/social/unread-bridge": { getUnreadCount: () => 0, subscribeUnread: () => () => {} },
    "@/lib/theme": { activeLayout: () => "custom" },
    "@/lib/theme-markup-calls": { runBlockedHarborCall: () => false },
    "@/chrome/use-big-picture-entry": { useBigPictureEntry: () => ({ offer: true }) },
    "@/lib/theme-preview": { useThemePreview: () => state.preview },
  }) as { ThemeChromeBridge: React.ComponentType };

  const root = createRoot(document.getElementById("root")!);
  const render = () => React.act(() => root.render(React.createElement(ThemeChromeBridge)));
  await render();
  return {
    state,
    render,
    look: document.getElementById("look")!,
    overlay: document.getElementById("harbor-custom-overlay")!,
    // Runs a change of the page and lets the page's observers see it. No scan, no render.
    change: (edit: () => void) =>
      React.act(async () => {
        edit();
      }),
    flagged: () => document.documentElement.hasAttribute(FLAG),
    scan: () => React.act(() => scans.forEach((run) => run())),
    async close() {
      await React.act(() => root.unmount());
      dom.window.close();
    },
  };
}

const SLOT = '<button data-harbor-bigpicture aria-label="Big Picture"></button>';

test("the page is flagged while a theme supplies its own Big Picture control", async () => {
  const withSlot = await fixture(`<nav>${SLOT}</nav>`);
  try {
    assert.equal(withSlot.flagged(), true);
  } finally {
    await withSlot.close();
  }
  const without = await fixture("<nav><button>Home</button></nav>");
  try {
    assert.equal(without.flagged(), false);
  } finally {
    await without.close();
  }
});

test("the flag follows a change of look in the same update", async () => {
  const f = await fixture(`<nav>${SLOT}</nav>`);
  try {
    // What switching look does: new markup, then a render with the new preset.
    f.look.innerHTML = "<nav><button>Home</button></nav>";
    f.state.settings = { ...f.state.settings, theme: { preset: "user:two" } };
    await f.render();
    assert.equal(f.flagged(), false);

    f.look.innerHTML = `<nav>${SLOT}</nav>`;
    f.state.settings = { ...f.state.settings, customHtml: SLOT };
    await f.render();
    assert.equal(f.flagged(), true);
  } finally {
    await f.close();
  }
});

test("a control a theme script adds or removes later is picked up by the next scan", async () => {
  const f = await fixture("<nav></nav>");
  try {
    assert.equal(f.flagged(), false);
    f.look.querySelector("nav")!.innerHTML = SLOT;
    await f.scan();
    assert.equal(f.flagged(), true);
    f.look.querySelector("nav")!.innerHTML = "";
    await f.scan();
    assert.equal(f.flagged(), false);
  } finally {
    await f.close();
  }
});

test("the flag follows the active theme's markup at once while the preset stays", async () => {
  const f = await fixture("");
  try {
    // A store update of the active theme: new markup, the same preset.
    await f.change(() => {
      f.overlay.innerHTML = `<nav><div>${SLOT}</div></nav>`;
    });
    assert.equal(f.flagged(), true);
    await f.change(() => {
      f.overlay.innerHTML = "<nav><button id='home'>Home</button></nav>";
    });
    assert.equal(f.flagged(), false);

    // A theme script: it hooks a button it has, gives that up again, and adds one of its own.
    const home = document.getElementById("home")!;
    await f.change(() => home.setAttribute("data-harbor-bigpicture", ""));
    assert.equal(f.flagged(), true);
    await f.change(() => home.removeAttribute("data-harbor-bigpicture"));
    assert.equal(f.flagged(), false);
    await f.change(() => home.insertAdjacentHTML("afterend", SLOT));
    assert.equal(f.flagged(), true);

    // A script that takes its bar out of the overlay still supplies the control.
    await f.change(() => document.body.append(f.overlay.firstElementChild!));
    assert.equal(f.flagged(), true);
  } finally {
    await f.close();
  }
});

test("the flag follows the draft in the Theme Studio at once", async () => {
  const f = await fixture("");
  try {
    const draft = document.createElement("div");
    draft.id = "harbor-studio-preview-html";
    draft.innerHTML = SLOT;
    document.body.append(draft);
    f.state.preview = { layout: "custom" };
    await f.render();
    assert.equal(f.flagged(), true, "the Studio opens on a draft with the control");

    await f.change(() => {
      draft.innerHTML = "<nav></nav>";
    });
    assert.equal(f.flagged(), false);
    await f.change(() => {
      draft.innerHTML = SLOT;
    });
    assert.equal(f.flagged(), true);

    draft.remove();
    f.state.preview = null;
    await f.render();
    assert.equal(f.flagged(), false, "the Studio is closed without saving");
  } finally {
    await f.close();
  }
});

test("theme markup that changes all the time does not make the bridge search the page", async () => {
  const f = await fixture("");
  try {
    await f.change(() => {
      f.overlay.innerHTML = `<span id="clock"></span><ul id="list"></ul>${SLOT}`;
    });
    let searches = 0;
    const search = document.querySelectorAll.bind(document);
    document.querySelectorAll = ((selector: string) => {
      searches += 1;
      return search(selector);
    }) as typeof document.querySelectorAll;
    for (let i = 0; i < 20; i += 1) {
      await f.change(() => {
        document.getElementById("clock")!.textContent = String(i);
        document.getElementById("list")!.innerHTML = `<li><b>${i}</b></li>`;
        f.overlay.firstElementChild!.setAttribute("style", `width: ${i}px`);
      });
    }
    assert.equal(searches, 0);
    assert.equal(f.flagged(), true);
  } finally {
    await f.close();
  }
});

test("the flag is taken off the page with the bridge", async () => {
  const f = await fixture(`<nav>${SLOT}</nav>`);
  assert.equal(f.flagged(), true);
  await f.close();
  assert.equal(document.documentElement.hasAttribute(FLAG), false);
});

test("the scan reports a :has() question asked of the whole page, in every shape it can take", () => {
  for (const css of [
    "html:has([data-x]) .a { color: red; }",
    'html[data-theme-layout="custom"]:not(:has(aside)) #b { color: red; }',
    "body.fixed:has(.modal) { overflow: hidden; }",
    ":root:has(dialog[open]) main { filter: none; }",
    "html body:has(dialog[open]) { color: red; }",
    ":root > body:has(.modal) { color: red; }",
    ":is(html):has(.x) { color: red; }",
    ":where(html, body):has(.x) { color: red; }",
    "HTML:HAS(.x) { color: red; }",
    ".ok, html:has(.x) .z { color: red; }",
    "  html:has(.indented) .z { color: red; }",
    "html:has(> body .deep) { color: red; }",
    // No tag, class or id: these match html and body as well.
    '[data-theme-layout="custom"]:has([data-harbor-bigpicture]) .harbor-bp-proxy { display: none; }',
    ":has(.x) .y { color: red; }",
    "*:has(.x) { color: red; }",
    // Nested rules and rules inside at-rules.
    "html { &:has(.x) .y { color: red; } }",
    ":root { & body:has(.x) { color: red; } }",
    "html { > body:has(.x) { color: red; } }",
    ".a { html:has(.x) & { color: red; } }",
    ".a { color: red; html:has(.x) & { color: red; } }",
    "@media (min-width: 10px) { html:has(.x) .y { color: red; } }",
    "@layer base { @supports (display: grid) { body:has(.x) { color: red; } } }",
  ]) {
    assert.equal(pageLevelHasSelectors(css).length, 1, `not reported: ${css}`);
  }
});

test("the scan leaves alone what does not ask the whole page", () => {
  for (const css of [
    ".card:has(> img) { color: red; }",
    "button:has(> img) { color: red; }",
    "main:has(.brand-hero) { color: red; }",
    "html[data-flag] .e { color: red; }",
    ".f html-like:has(.g) { color: red; }",
    ".card [data-open]:has(.x) { color: red; }",
    'html[data-theme-layout="custom"] .myc-bar:has(.x) { color: red; }',
    "html body .row:has(.x) { color: red; }",
    'html:not([data-input-modality="pointer"]) [data-field]:has(input:focus-visible) { color: red; }',
    '[data-hero="billboard"] [data-anchor="hero"]:has(.stage) { color: red; }',
    ".row:is(:hover, :focus-within):has(.actions) .game { color: red; }",
    '.open:has(> .preview:is([data-state="playing"], [data-state="buffering"])) .art { color: red; }',
    ".hset-row[data-span]:has(> .hset-row-label) > .hset-row-control > * { color: red; }",
    // Direct children only: measured as cheap, even on html.
    "html:has(> body > .x) body { color: red; }",
    ":has(> h3.truncate) { color: red; }",
    // Not selectors at all.
    '.x::after { content: "html:has(.y) {"; }',
    "/* html:has(.x) { } */ .y { color: red; }",
    ".x { background: url(data:image/svg+xml;charset=utf8,html:has(.y){}); }",
  ]) {
    assert.deepEqual(pageLevelHasSelectors(css), [], css);
  }
});

test("Harbor's own style sheets ask no :has() question of the whole page", () => {
  const sheets: URL[] = [];
  const visit = (dir: URL) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) visit(url);
      else if (entry.name.endsWith(".css")) sheets.push(url);
    }
  };
  visit(new URL("../src/", import.meta.url));
  assert.ok(sheets.length > 50, "expected to scan the app's style sheets");
  const offenders = sheets.flatMap((url) =>
    pageLevelHasSelectors(readFileSync(url, "utf8")).map(
      (selector) => `${url.href.replace(/^.*\/src\//, "src/")}: ${selector}`,
    ),
  );
  assert.deepEqual(offenders, []);

  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  assert.match(
    css,
    /html\[data-theme-layout="custom"\]\[data-harbor-bigpicture-slot\] \.harbor-bp-proxy \{\s*display: none;/,
  );
});
