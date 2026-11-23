import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { JSDOM } from "jsdom";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { createRoot } from "react-dom/client";

const code = ts.transpileModule(
  readFileSync("src/views/settings/player-panel/p2p-advanced-section.tsx", "utf8"),
  { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  }},
).outputText;

const stub = () => null;
const passthrough = ({ children }: { children?: React.ReactNode }) => React.createElement("div", null, children);

function fixture() {
  const dom = new JSDOM("<main id='test-root'></main>", {
    url: "http://localhost:1420/", pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,

    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let copySucceeds = true;
  let statusFails = false;
  const copies: string[] = [];
  const dependencies: Record<string, unknown> = {
    react: React,
    "react/jsx-runtime": jsx,
    "../icons": Object.fromEntries([
      "Ban", "Check", "ClipboardCopy", "Clock", "FolderOpen",
      "HardDrive", "Loader2", "RotateCcw", "ShieldCheck", "Trash2", "Zap",
    ].map((name) => [name, stub])),
    "@tauri-apps/api/path": { appCacheDir: async () => "", join: async () => "" },
    "@tauri-apps/plugin-dialog": { open: async () => null },
    "@tauri-apps/plugin-opener": { revealItemInDir: async () => {} },
    "@/lib/settings": { useSettings: () => ({
      settings: {
        directTorrentStream: true,
        torrentsDisabled: false,
        p2pAutoConsent: true,
        remoteStreamServerUrl: "",
        remoteStreamServerStrict: false,
        streamCacheDir: "",
      },
      update() {},
      torrentEnginePolicyPending: false,
      torrentEnginePolicyError: false,
    }) },
    "@/lib/i18n": { useT: () => (text: string) => text },
    "@/lib/torrent/stremio-stream": {
      directTorrentEnabled: () => true,
      localTorrentAllowed: () => true,
      torrentsDisabled: () => false,
    },
    "@/lib/clipboard-text": { copyText: async (text: string) => {
      copies.push(text);
      return copySucceeds;
    } },
    "@/lib/torrent/local-engine": {
      torrentEngineStatus: async () => {
        if (statusFails) throw Error("Engine unavailable");
        return { ready: true, dht_nodes: 77, port: 11480 };
      },
      torrentEngineHardReset: async () => {},
      torrentEngineSetOptions: async () => {},
    },
    "../shared": { Section: passthrough, ToggleRow: stub },
    "../kit": {
      SettingRow: ({ children, warn }: {
        children?: React.ReactNode;
        warn?: string;
      }) => React.createElement("div", null,
        warn ? React.createElement("p", { role: "alert" }, warn) : null, children),
      SettingGroup: passthrough,
      SettingsModal: ({ open, children, title }: {
        open: boolean; children?: React.ReactNode; title?: string;
      }) => open ? React.createElement("div", { role: "dialog", "aria-label": title }, children) : null,
      ModalButton: ({ children, onClick }: {
        children?: React.ReactNode; onClick?: () => void;
      }) => React.createElement("button", { onClick }, children),
      ROW_ACTION: "test-action",
      ROW_ACTION_DANGER: "test-danger",
    },
    "./choice": { BADGE_BASE: "test-badge" },
    "@/components/dropdown": { Dropdown: stub },
  };
  const exports: Record<string, any> = {};
  new Function("require", "exports", code)((path: string) => {
    if (!(path in dependencies)) throw Error("Unexpected import: " + path);
    return dependencies[path];
  }, exports);
  const component = exports.P2PPowerToolsSection;
  assert.ok(component);
  const root = createRoot(document.getElementById("test-root")!);
  const button = (label: string) => Array.from(document.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === label,
  );
  return {
    copies,
    setCopySucceeds(value: boolean) { copySucceeds = value; },
    setStatusFails(value: boolean) { statusFails = value; },
    button,
    async render() {
      await React.act(async () => root.render(React.createElement(component)));
    },
    async click(label: string) {
      const selected = button(label);
      assert.ok(selected, "Expected clickable " + label);
      await React.act(async () => {
        selected.click();
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      });
    },
    async dispose() {
      await React.act(async () => root.unmount());
      dom.window.close();
      delete (globalThis as { document?: Document }).document;
      delete (globalThis as { window?: Window }).window;

    },
  };
}

test("P2P copy diagnostics uses shared native-aware copy helper and confirms success", async () => {
  const f = fixture();
  try {
    await f.render();
    await f.click("Copy diagnostics");
    assert.equal(f.copies.length, 1);
    const data = JSON.parse(f.copies[0]);
    assert.deepEqual(data.engine, { ready: true, dht_nodes: 77, port: 11480 });
    assert.equal(data.torrentsDisabled, false);
    assert.deepEqual(data.playbackPolicy, {
      directTorrentEnabled: true, localTorrentAllowed: true, torrentsDisabled: false,
    });
    assert.equal(data.directTorrentStream, true);
    assert.ok(f.button("Copied"));
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally { await f.dispose(); }
});

test("blocked clipboard reveals selectable diagnostics instead of silently failing", async () => {
  const f = fixture();
  try {
    f.setCopySucceeds(false);
    await f.render();
    await f.click("Copy diagnostics");
    assert.equal(f.copies.length, 1);
    assert.ok(document.querySelector('[role="alert"]')?.textContent?.includes("Could not copy"));
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    const json = dialog.querySelector("textarea");
    assert.ok(json?.readOnly);
    assert.equal(JSON.parse(json.value).engine.dht_nodes, 77);
    f.setCopySucceeds(true);
    await f.click("Copy diagnostics");
    assert.ok(f.button("Copied"));
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally { await f.dispose(); }
});

test("unavailable engine still produces actionable settings diagnostics", async () => {
  const f = fixture();
  try {
    f.setStatusFails(true);
    await f.render();
    await f.click("Copy diagnostics");
    assert.equal(JSON.parse(f.copies[0]).engine, null);
    assert.equal(JSON.parse(f.copies[0]).directTorrentStream, true);
    assert.ok(f.button("Copied"));
  } finally { await f.dispose(); }
});
