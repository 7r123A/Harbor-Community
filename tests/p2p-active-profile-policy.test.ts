// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import "./_localstorage-stub.ts";
import { readActiveSettingsRaw, MIRROR_KEY, SHARED_KEY, PROFILES_KEY } from "../src/lib/settings/profile-store.ts";
import {
  localTorrentAllowed,
  torrentsDisabled,
  directTorrentEnabled,
} from "../src/lib/torrent/stremio-stream.ts";

const set = (key: string, value: object) => localStorage.setItem(key, JSON.stringify(value));

test("P2P playback uses shared settings rather than a stale mirror", () => {
  localStorage.clear();
  try {
    set(SHARED_KEY, { directTorrentStream: true, torrentsDisabled: false });
    set(MIRROR_KEY, { directTorrentStream: false, torrentsDisabled: true });
    assert.equal(localTorrentAllowed(), true);
    assert.equal(torrentsDisabled(), false);
    assert.equal(directTorrentEnabled(), true);
    assert.equal(JSON.parse(readActiveSettingsRaw()!).directTorrentStream, true);
  } finally {
    localStorage.clear();
  }
});

test("P2P playback honors a deliberately disabled local streaming setting", () => {
  localStorage.clear();
  try {
    set(SHARED_KEY, { directTorrentStream: false, torrentsDisabled: false });
    set(MIRROR_KEY, { directTorrentStream: true, torrentsDisabled: false });
    assert.equal(localTorrentAllowed(), false);
    assert.equal(torrentsDisabled(), false);
    assert.equal(directTorrentEnabled(), false);
  } finally {
    localStorage.clear();
  }
});

test("active unlinked profile determines the P2P policy, not another profile", () => {
  localStorage.clear();
  try {
    set(PROFILES_KEY, {
      activeId: "mac-profile",
      profiles: [
        { id: "mac-profile", settingsLinked: false },
        { id: "other-profile", settingsLinked: false },
      ],
    });
    set("harbor.settings.mac-profile", { directTorrentStream: true, torrentsDisabled: false });
    set("harbor.settings.other-profile", { directTorrentStream: false, torrentsDisabled: true });
    set(SHARED_KEY, { directTorrentStream: false, torrentsDisabled: false });
    set(MIRROR_KEY, { directTorrentStream: false, torrentsDisabled: true });
    assert.equal(localTorrentAllowed(), true);
    assert.equal(torrentsDisabled(), false);
    assert.equal(directTorrentEnabled(), true);

    set(PROFILES_KEY, {
      activeId: "other-profile",
      profiles: [
        { id: "mac-profile", settingsLinked: false },
        { id: "other-profile", settingsLinked: false },
      ],
    });
    assert.equal(localTorrentAllowed(), false);
    assert.equal(torrentsDisabled(), true);
    assert.equal(directTorrentEnabled(), false);
  } finally {
    localStorage.clear();
  }
});

test("global P2P kill switch still blocks torrents even if local streaming is enabled", () => {
  localStorage.clear();
  try {
    set(SHARED_KEY, { directTorrentStream: true, torrentsDisabled: true });
    assert.equal(localTorrentAllowed(), true);
    assert.equal(torrentsDisabled(), true);
    assert.equal(directTorrentEnabled(), false);
  } finally {
    localStorage.clear();
  }
});

test("older installations fall back to the legacy settings mirror and safe defaults", () => {
  localStorage.clear();
  try {
    assert.equal(localTorrentAllowed(), true);
    assert.equal(torrentsDisabled(), false);
    set(MIRROR_KEY, { directTorrentStream: false, torrentsDisabled: true });
    assert.equal(localTorrentAllowed(), false);
    assert.equal(torrentsDisabled(), true);
  } finally {
    localStorage.clear();
  }
});
