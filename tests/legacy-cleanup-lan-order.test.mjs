import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// The body of one top-level Rust function, without its comments.
function body(path, signature) {
  const source = read(path);
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} is missing in ${path}`);
  return source.slice(start, source.indexOf("\n}\n", start)).replace(/\/\/.*$/gm, "");
}

test("the LAN listener waits for the legacy clean-up, the window does not", () => {
  // The unit tests in cast_server.rs cover what the waiting does. This is the wiring around it.
  const cleanup = /run_once\(\s*&LEGACY_CLEANUP,\s*kill_orphan_sidecars,?\s*\)/;
  const setup = body("src-tauri/src/cast_server.rs", "pub fn ensure_started_on_setup");
  assert.match(setup, cleanup);
  assert.match(setup, /async_runtime::spawn\(/, "setup starts the clean-up in the background");
  assert.doesNotMatch(setup, /block_on|\.join\(\)/, "setup does not wait for it");

  assert.match(
    body("src-tauri/src/cast_server.rs", "pub async fn wait_for_legacy_cleanup"),
    cleanup,
    "waiting joins the run that setup started",
  );

  const start = body("src-tauri/src/torrent_engine.rs", "pub async fn start_lan_server");
  const waits = start.indexOf("cast_server::wait_for_legacy_cleanup().await");
  assert.ok(waits >= 0, "the LAN server waits for the clean-up");
  assert.ok(waits < start.indexOf("bind_lan_listener()"), "before it binds");
  // Torrent playback needs the same lock, so it is not held while waiting.
  assert.ok(waits < start.indexOf("lifecycle().lock()"), "before it takes the transition lock");
});
