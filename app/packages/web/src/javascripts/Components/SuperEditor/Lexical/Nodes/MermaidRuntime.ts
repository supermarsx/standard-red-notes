import type { MermaidRenderTheme } from './MermaidSettings'

/**
 * Standard Red Notes — THE one place this app talks to mermaid.
 *
 * Mermaid keeps its configuration in MODULE-GLOBAL state: one site config, set
 * by `initialize`, and one list of "directives", which is whatever the diagram
 * being rendered said about itself in a frontmatter `config:` block or a
 * `%%{init: …}%%` line. Every Mermaid and Gantt block in every open note shares
 * both. The two blocks used to call `initialize` and then `render` each on its
 * own, which is two bugs:
 *
 *  1. ONE BAD COLOUR BROKE EVERY DIAGRAM UNTIL THE PAGE WAS RELOADED. A diagram
 *     whose own text names a theme and a colour mermaid cannot parse (`#ff`,
 *     which is what a hex colour looks like half-typed) throws while its
 *     directive is being applied — AFTER the directive has been stored.
 *     `render` clears that list on entry, but `initialize` recomputes the
 *     config from it first, so the next diagram's `initialize` threw the same
 *     error and its `render` was never reached. Nothing ever cleared it:
 *     measured in the running app, every block after the bad one, every block
 *     in every other note, and the Gantt block all showed that one diagram's
 *     error. `mermaidAPI.reset()` before `initialize` is the cure.
 *  2. A DIAGRAM COULD BE DRAWN WITH ANOTHER BLOCK'S SETTINGS. `initialize` is
 *     immediate and `render` is queued inside mermaid, so with several blocks
 *     rendering at once every `initialize` ran before the second `render`
 *     started, and each diagram was drawn with whichever block called
 *     `initialize` LAST. Measured: a block pinned to Forest, followed by one
 *     pinned to Default, took Default's text colour.
 *
 * So every render goes through `renderMermaidDiagram`, and they run ONE AT A
 * TIME: reset, configure, render, as a unit nothing else can get between.
 */

type MermaidLibrary = typeof import('mermaid').default
type MermaidSiteConfig = Parameters<MermaidLibrary['initialize']>[0]

// Lazily loaded singleton, so the heavy library is code-split and only fetched
// when a diagram is actually rendered.
let mermaidPromise: Promise<MermaidLibrary> | undefined
export function loadMermaid(): Promise<MermaidLibrary> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => m.default)
  }
  return mermaidPromise
}

/**
 * THE keys a diagram's own text may not set — the whole list, in one place.
 * Handed to mermaid as `secure` on every `initialize`, where it is UNIONED with
 * mermaid's own built-in list (measured against 11.17.2; `MermaidContract.mjs`
 * pins it), so a key added here is locked and a key removed here is not thereby
 * unlocked.
 *
 * Today it restates mermaid's built-in list and nothing more, so it changes
 * what no existing diagram renders: these are the trust level, the
 * denial-of-service limits and the error handling this app relies on (it keeps
 * the last good diagram), which a diagram could not set yesterday either.
 * Stating them here means that stays true if a mermaid upgrade trims its own
 * list.
 *
 * To lock another key — `themeCSS`, say — add its name. That one line is the
 * whole change: the contract test reads this list and expects every key in it
 * to be refused and every other key it knows about to be honoured.
 */
export const MERMAID_APP_SECURE_KEYS: readonly string[] = [
  'secure',
  'securityLevel',
  'startOnLoad',
  'maxTextSize',
  'suppressErrorRendering',
  'maxEdges',
]

/** What one block asks for. */
export type MermaidRenderRequest = {
  /**
   * The id mermaid puts on the `<svg>` it builds and measures in. The CALLER
   * owns it, prefix included: the reduced-motion exception in
   * stylesheets/_animation.scss recognises a Mermaid block's measuring `<svg>`
   * by `MERMAID_RENDER_ID_PREFIX`, and the Gantt block keeps its own.
   */
  id: string
  text: string
  /** The block's theme, as `resolveMermaidRenderTheme` resolved it. */
  theme: MermaidRenderTheme
  /** A CONCRETE font stack — see `resolveMermaidLabelFontFamily`. */
  fontFamily: string
  /** Where mermaid measures; `undefined` is its `document.body` path. */
  measureIn: HTMLElement | undefined
}

export type MermaidRenderResult = {
  svg: string
}

function siteConfig(request: MermaidRenderRequest): MermaidSiteConfig {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    secure: [...MERMAID_APP_SECURE_KEYS],
    theme: request.theme.theme,
    // The APPLICATION's own design tokens, not mermaid's generic palette.
    // Absent for a pinned built-in theme: `initialize` rebuilds its config from
    // the defaults rather than accumulating, so a pinned diagram rendered after
    // an app-themed one gets mermaid's own clean palette and not the previous
    // diagram's overrides.
    themeVariables: request.theme.themeVariables,
    // A CONCRETE stack, never `inherit`. Mermaid sizes every node by measuring
    // its label in a temporary element, and the finished SVG is then injected
    // into the editor — so a value that defers to its parent is resolved twice,
    // against two different fonts, and every box is sized from metrics the
    // label never had. Still required with a measuring element: that element
    // only covers the DOM measurement, while the print snapshot reparents the
    // finished SVG under `#srn-print-root` and its own `font-family`.
    fontFamily: request.fontFamily,
  }
}

/**
 * Everything mermaid remembers, replaced. `reset` FIRST: it drops the previous
 * diagram's directives, and `initialize` would otherwise recompute the config
 * from them — and throw, if one of them is the bad colour described above.
 */
function configure(mermaid: MermaidLibrary, config: MermaidSiteConfig): void {
  mermaid.mermaidAPI.reset()
  mermaid.initialize(config)
}

// The tail of the line. A failed render must not hold up the one behind it, so
// what is chained on is the settled promise, never the rejection.
let lastInLine: Promise<unknown> = Promise.resolve()

function inTurn<T>(job: () => Promise<T>): Promise<T> {
  const result = lastInLine.then(job)
  lastInLine = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

/**
 * Render one diagram. Rejects with mermaid's own error for a source it cannot
 * parse or draw; the caller decides what to show, and the NEXT call starts
 * clean either way.
 */
export async function renderMermaidDiagram(request: MermaidRenderRequest): Promise<MermaidRenderResult> {
  const mermaid = await loadMermaid()
  return inTurn(async () => {
    configure(mermaid, siteConfig(request))
    const { svg } = await mermaid.render(request.id, request.text, request.measureIn)
    return { svg }
  })
}
