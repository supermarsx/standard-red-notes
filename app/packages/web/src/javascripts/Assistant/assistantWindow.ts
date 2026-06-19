/**
 * Tracks the popped-out assistant window so it can be refocused instead of
 * opening duplicates. A named target keeps a single window even if the in-memory
 * reference is lost (e.g. after a reload of the main window).
 */
const ASSISTANT_WINDOW_NAME = 'standard-notes-assistant'
const ASSISTANT_ROUTE = '/?route=assistant'

let assistantWindow: Window | null = null

/** Open the assistant in a separate window, or refocus it if already open. */
export function openOrFocusAssistantWindow(): void {
  if (assistantWindow && !assistantWindow.closed) {
    assistantWindow.focus()
    return
  }
  // Named (not `_blank`) so repeated calls reuse the same window. We intentionally
  // keep the opener relationship (no `noopener`) so we retain the reference to
  // focus it later — safe because it's our own same-origin route.
  assistantWindow = window.open(ASSISTANT_ROUTE, ASSISTANT_WINDOW_NAME)
  assistantWindow?.focus()
}

/**
 * Focus the popped-out assistant window if one is currently open. Returns true
 * when it handled the request, so callers can skip opening an in-app pane.
 */
export function focusAssistantWindowIfOpen(): boolean {
  if (assistantWindow && !assistantWindow.closed) {
    assistantWindow.focus()
    return true
  }
  return false
}
