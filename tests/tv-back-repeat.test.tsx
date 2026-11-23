import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

// Listener errors are swallowed by jsdom; collect them so a broken handler fails the test.
const pageErrors: unknown[] = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (error) => pageErrors.push(error));
const dom = new JSDOM('<div id="root"></div>', {
  url: "https://fixture.invalid",
  pretendToBeVisual: true,
  virtualConsole,
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Element: dom.window.Element,
  Node: dom.window.Node,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLSelectElement: dom.window.HTMLSelectElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  KeyboardEvent: dom.window.KeyboardEvent,
  CustomEvent: dom.window.CustomEvent,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
});

// Load after the DOM globals exist; the navigation module touches them on import.
const { useKeyboardNavigation } = await import("../src/lib/keyboard-navigation.ts");
const { registerChatHistoryDismiss, dismissChatHistory } =
  await import("../src/lib/together/chat-history-dismiss.ts");

function pressEscape(repeat: boolean) {
  const event = new dom.window.KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
    repeat,
  });
  act(() => {
    document.body.dispatchEvent(event);
  });
  return event;
}

test("holding Escape in TV navigation closes chat history without leaving playback", async () => {
  let historyCloses = 0;
  let playerExits = 0;

  // Same Back order as the player's TV navigation onBack.
  function PlayerProbe() {
    useKeyboardNavigation({
      wrap: true,
      onBack: () => {
        if (dismissChatHistory()) return true;
        playerExits++;
        return true;
      },
    });
    return null;
  }

  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(<PlayerProbe />));

  try {
    registerChatHistoryDismiss(() => historyCloses++);

    const first = pressEscape(false);
    assert.equal(first.defaultPrevented, true, "Back must be swallowed");
    assert.equal(historyCloses, 1, "first press closes chat history");

    for (let i = 0; i < 5; i++) {
      const held = pressEscape(true);
      assert.equal(held.defaultPrevented, true, "repeated Back must still be swallowed");
    }
    assert.equal(playerExits, 0, "held Escape must not leave playback");

    pressEscape(false);
    assert.equal(playerExits, 1, "a fresh Escape press still leaves playback");
    assert.deepEqual(pageErrors, []);
  } finally {
    await act(async () => root.unmount());
  }
});
