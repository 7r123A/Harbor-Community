// The in-player chat history is a non-modal panel, so it does not own Escape or
// Back. The player asks it to close as one step of its own dismissal order
// (after the shortcuts panel and draw mode, before leaving playback).
// A single slot is enough: only one ChatOverlay is mounted, inside the player.
let closeHistory: (() => void) | null = null;

export function registerChatHistoryDismiss(close: () => void): () => void {
  closeHistory = close;
  return () => {
    if (closeHistory === close) closeHistory = null;
  };
}

export function dismissChatHistory(): boolean {
  if (!closeHistory) return false;
  const close = closeHistory;
  closeHistory = null;
  close();
  return true;
}
