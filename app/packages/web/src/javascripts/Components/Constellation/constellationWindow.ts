/**
 * Tracks the popped-out constellation window so it can be refocused instead of
 * opening duplicates, mirroring the assistant's detached-window behaviour.
 */
const CONSTELLATION_WINDOW_NAME = 'standard-notes-constellation'
const CONSTELLATION_ROUTE = '/?route=constellation'

let constellationWindow: Window | null = null

/** Open the constellation in a separate window, or refocus it if already open. */
export function openOrFocusConstellationWindow(): void {
  if (constellationWindow && !constellationWindow.closed) {
    constellationWindow.focus()
    return
  }
  constellationWindow = window.open(CONSTELLATION_ROUTE, CONSTELLATION_WINDOW_NAME)
  constellationWindow?.focus()
}

/** Focus the popped-out constellation window if one is open. Returns true when handled. */
export function focusConstellationWindowIfOpen(): boolean {
  if (constellationWindow && !constellationWindow.closed) {
    constellationWindow.focus()
    return true
  }
  return false
}
