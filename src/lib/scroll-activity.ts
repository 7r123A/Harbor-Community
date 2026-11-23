/**
 * Marks active scrolling on <html> so CSS can hold back work that cannot be seen
 * while content moves: the 300ms poster fade and the skeleton shimmer. Every
 * fading poster promotes a compositing layer and fires transition events, and a
 * fast first scroll revealed dozens at once — the largest source of double-vsync
 * frames the profiler attributed to Home. The attribute is removed shortly after
 * the last scroll, so the resting reveal is unchanged.
 *
 * Optional state that arrives from the network (ratings) can be applied through
 * `runAfterScroll`, so a response that lands mid-gesture does not add a render to
 * the frame that is already revealing cards.
 */
const SCROLL_IDLE_MS = 160;
let timer: number | undefined;
let gesture = false;
const afterScroll = new Set<() => void>();

/** Content moves, through a gesture or because a page puts its saved position back. */
export function isPageMoving(): boolean {
  return timer !== undefined;
}

/** The user scrolls, so cards that compete for the frame are held back. */
export function isScrollActive(): boolean {
  return gesture;
}

export function runAfterScroll(task: () => void): void {
  if (!isPageMoving()) {
    task();
    return;
  }
  afterScroll.add(task);
}

function flushAfterScroll(): void {
  const tasks = Array.from(afterScroll);
  afterScroll.clear();
  for (const task of tasks) {
    try {
      task();
    } catch {
      // A queued optional update must not stop the rest from running.
    }
  }
}

export function noteScrollActivity(byUser = true): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (!root.hasAttribute("data-scrolling")) root.setAttribute("data-scrolling", "");
  if (timer !== undefined) window.clearTimeout(timer);
  if (byUser) gesture = true;
  timer = window.setTimeout(() => {
    timer = undefined;
    gesture = false;
    root.removeAttribute("data-scrolling");
    flushAfterScroll();
  }, SCROLL_IDLE_MS);
}
