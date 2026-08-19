/**
 * Standard Red Notes: printable non-note views.
 *
 * The print path resolves what to print out of the note editor's DOM. A view tab
 * (Todos, Bookmarks, …) REPLACES that editor in the content area, so printing
 * from one used to resolve nothing and fail with "Open a note before printing."
 *
 * A view fixes that by registering a projection of what it is currently
 * showing. Registration is explicit and element-keyed, exactly like
 * `PrintableDataTableRegistry`: arbitrary application DOM is never interpreted
 * as printable content, and a view that has been unmounted cannot leave a stale
 * projection behind because its element stops being connected.
 *
 * The provider must return a DETACHED, already-static element. The print path
 * still runs it through `sanitizePrintBody`, so the exclusion contract
 * (`[data-srn-print-exclude]` plus the control denylist) applies to a view's
 * output exactly as it does to a note's.
 */
export type PrintableViewSnapshot = {
  /** Heading of the printed page — the view's name, in place of a note title. */
  title: string
  /** Detached body element built from the view's own current data. */
  body: HTMLElement
}

type PrintableViewProvider = () => PrintableViewSnapshot | undefined

const printableViews = new Map<HTMLElement, PrintableViewProvider>()

/** Associate a mounted view's root element with a current print projection. */
export function registerPrintableView(element: HTMLElement, provider: PrintableViewProvider): void {
  printableViews.set(element, provider)
}

export function unregisterPrintableView(element: HTMLElement): void {
  printableViews.delete(element)
}

/**
 * Whether a printable view is on screen, without building its projection.
 *
 * Callers deciding WHICH target to print need this before they can afford to
 * project anything: building a snapshot is not free, and the answer changes
 * what they ask for.
 */
export function hasPrintableView(): boolean {
  for (const element of printableViews.keys()) {
    if (element.isConnected) {
      return true
    }
  }
  return false
}

/**
 * The projection of the view currently on screen, if any.
 *
 * Only a CONNECTED element counts. A React cleanup that has not run yet, or a
 * view torn down without one, must never decide what the browser prints — and a
 * provider that throws is treated as "this view cannot print" rather than being
 * allowed to break printing for everything else.
 */
export function resolvePrintableView(): PrintableViewSnapshot | undefined {
  for (const [element, provider] of printableViews) {
    if (!element.isConnected) {
      continue
    }
    try {
      const snapshot = provider()
      if (snapshot) {
        return snapshot
      }
    } catch {
      // Fall through: printing stays fail-closed rather than fail-broken.
    }
  }
  return undefined
}
