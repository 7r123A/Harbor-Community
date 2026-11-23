import assert from "node:assert/strict";
import test from "node:test";
import {
  OVERLAY_HISTORY_LIMIT,
  OVERLAY_RECENT_LIMIT,
  groupOverlayMessages,
  overlayMessages,
} from "../src/lib/together/chat-overlay-messages";
import type { ChatMessage } from "../src/lib/together/provider-types";

const msg = (from: string, text: string, at: number): ChatMessage => ({
  from,
  name: from,
  text,
  at,
});

test("closed overlay shows only messages from the last few seconds", () => {
  const now = 100_000;
  const messages = [msg("a", "old", now - 60_000), msg("b", "fresh", now - 2_000)];
  assert.deepEqual(
    overlayMessages(messages, now, false).map((m) => m.text),
    ["fresh"],
  );
  const burst = Array.from({ length: 10 }, (_, i) => msg("a", `m${i}`, now - 1_000));
  assert.equal(overlayMessages(burst, now, false).length, OVERLAY_RECENT_LIMIT);
});

test("open history keeps earlier messages, capped to the newest ones", () => {
  const now = 10_000_000;
  const messages = Array.from({ length: 80 }, (_, i) => msg("a", `m${i}`, now - (80 - i) * 60_000));
  const shown = overlayMessages(messages, now, true);
  assert.equal(shown.length, OVERLAY_HISTORY_LIMIT);
  assert.equal(shown[0].text, "m30");
  assert.equal(shown.at(-1)?.text, "m79");
});

test("messages from the same sender close together are grouped", () => {
  const grouped = groupOverlayMessages([
    msg("a", "1", 0),
    msg("a", "2", 30_000),
    msg("b", "3", 31_000),
    msg("b", "4", 500_000),
  ]);
  assert.deepEqual(
    grouped.map((g) => g.isContinuation),
    [false, true, false, false],
  );
});
