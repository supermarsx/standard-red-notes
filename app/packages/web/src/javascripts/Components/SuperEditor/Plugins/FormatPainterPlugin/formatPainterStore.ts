/**
 * Standard Red Notes: Format Painter (Word-style) shared state store.
 *
 * Holds the captured inline formatting (the TextNode format bitmask + the inline
 * CSS style string) and the "armed" / "locked" flags. It is a tiny subscribable
 * store (getSnapshot/subscribe) so it can be consumed both by the Lexical plugin
 * (which arms/applies) and by a React toolbar button via useSyncExternalStore.
 *
 * The store is intentionally decoupled from Lexical so the painting/arming logic
 * is plain, synchronously testable data with no editor dependency.
 */

/** The inline formatting snapshot captured from a selection. */
export type CapturedFormat = {
  /** The TextNode format bitmask (bold/italic/underline/... combined via IS_* flags). */
  format: number
  /** The inline CSS style string (font-family/size/color/background-color/...). */
  style: string
}

export type FormatPainterState = {
  /** True while the painter is waiting to apply to the next selection. */
  armed: boolean
  /**
   * True when the painter should stay armed after applying (Word's double-click
   * semantics). When false, applying disarms after a single use.
   */
  locked: boolean
  /** The captured formatting, or null when nothing has been captured yet. */
  captured: CapturedFormat | null
}

const initialState: FormatPainterState = {
  armed: false,
  locked: false,
  captured: null,
}

class FormatPainterStore {
  private state: FormatPainterState = initialState
  private listeners = new Set<() => void>()

  getSnapshot = (): FormatPainterState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private setState(next: FormatPainterState): void {
    if (
      next.armed === this.state.armed &&
      next.locked === this.state.locked &&
      next.captured === this.state.captured
    ) {
      return
    }
    this.state = next
    this.listeners.forEach((listener) => listener())
  }

  /**
   * Arm the painter with a captured format. `locked` enables sticky (multi-use)
   * mode (double-click semantics); single-click arms for one application.
   */
  arm(captured: CapturedFormat, locked = false): void {
    this.setState({ armed: true, locked, captured })
  }

  /** Disarm the painter (after a single-use apply, or an explicit cancel). */
  disarm(): void {
    if (!this.state.armed && !this.state.locked) {
      return
    }
    this.setState({ armed: false, locked: false, captured: this.state.captured })
  }

  /**
   * Called after a successful apply. Disarms unless locked, in which case the
   * painter stays armed (and keeps its captured format) for the next selection.
   */
  afterApply(): void {
    if (this.state.locked) {
      return
    }
    this.disarm()
  }

  /** Reset everything (used on unmount / editor teardown and in tests). */
  reset(): void {
    this.setState(initialState)
  }
}

/**
 * Singleton store. The painter is conceptually a global "tool" (one armed state
 * at a time), mirroring how a single toolbar button reflects it. Tests can call
 * `formatPainterStore.reset()` between cases.
 */
export const formatPainterStore = new FormatPainterStore()
