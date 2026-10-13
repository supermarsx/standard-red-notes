import {
  normalizeMermaidOwnSurface,
  resolveMermaidOwnTheme,
  type MermaidLibraryTheme,
  type MermaidRenderTheme,
} from './MermaidSettings'

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
 *
 * The same unit is where a diagram that names its own theme gets that theme
 * rather than the application's palette forced over it — see
 * `resolveMermaidOwnTheme` in MermaidSettings.ts for the rule, and
 * `mermaidTextMayCarryConfig` below for how the text is asked.
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
 * The first six restate mermaid's built-in list: the trust level, the
 * denial-of-service limits and the error handling this app relies on (it keeps
 * the last good diagram). A diagram could never set those; stating them here
 * means that stays true if a mermaid upgrade trims its own list.
 *
 * The last three are this app's own, and they DO change what an existing
 * diagram renders: a diagram whose text sets one of them is now drawn as if it
 * had not. Each was honoured until this, and each let a diagram's text — which
 * in a shared note is somebody else's — reach past the diagram:
 *
 *  - `themeCSS` is arbitrary CSS, scoped to the diagram but free to restyle or
 *    hide anything in it, and mermaid lets a `url(https://…)` through in it.
 *  - `fontFamily` replaced the font this app hands mermaid — the one resolved
 *    from the Editor Font preference, which every box is measured in — and so
 *    resized every box for a font the app had not loaded or checked.
 *  - `htmlLabels` switches how labels are drawn. Labels as SVG text were
 *    evaluated here and rejected (wrapping and markdown labels are lost, long
 *    labels overflow); the app draws HTML labels and fits the diagram to them.
 *
 * Mermaid applies the list at every depth of a diagram's config, so
 * `themeVariables.fontFamily` and `flowchart.htmlLabels` are refused with them.
 * It is a list of exact names: `sequence.actorFontFamily` and the other
 * per-diagram font keys are NOT covered by `fontFamily`.
 *
 * To lock another key, add its name. That one line is the whole change: the
 * contract tests read this list and expect every key in it to be refused and
 * every other key they know about to be honoured.
 */
export const MERMAID_APP_SECURE_KEYS: readonly string[] = [
  'secure',
  'securityLevel',
  'startOnLoad',
  'maxTextSize',
  'suppressErrorRendering',
  'maxEdges',
  'themeCSS',
  'fontFamily',
  'htmlLabels',
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
  /**
   * The theme the diagram was drawn in INSTEAD of the block's, because its own
   * text selected it; `undefined` when the block's theme stands. The preview
   * box needs it to paint the right page behind the diagram.
   */
  ownTheme: MermaidLibraryTheme | undefined
  /**
   * The page that theme was given by the diagram's own text, when it set one
   * this app will paint (`normalizeMermaidOwnSurface`); otherwise `undefined`,
   * and the theme's stock page applies. Never set without `ownTheme`.
   */
  ownSurface: string | undefined
}

/**
 * Could this text carry configuration of its own? Mermaid takes a diagram's
 * config from exactly two places — a YAML frontmatter block, which its pattern
 * can only match on three hyphens, and `%%{…}%%` directives — so a text with
 * neither cannot name a theme, and the common diagram is spared a second parse.
 *
 * Deliberately a superset, and deliberately not smarter: `A --- B` has three
 * hyphens and is no frontmatter, and costs one unnecessary parse. Looking for
 * the word `theme` instead would be wrong in the other direction, where it
 * matters — mermaid reads directives as JSON, so a key written with a unicode
 * escape for its first letter names a theme without spelling it (measured: it
 * is honoured). What a text MEANS is always mermaid's answer; this only
 * decides whether to ask. `MermaidContract.mjs` checks it against the library:
 * no text mermaid finds config in may be turned away here.
 */
export function mermaidTextMayCarryConfig(text: string): boolean {
  return text.includes('---') || text.includes('%%{')
}

function siteConfig(request: MermaidRenderRequest, withAppPalette: boolean): MermaidSiteConfig {
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
    themeVariables: withAppPalette ? request.theme.themeVariables : undefined,
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
    configure(mermaid, siteConfig(request, true))
    let ownTheme: MermaidLibraryTheme | undefined
    let ownSurface: string | undefined
    if (mermaidTextMayCarryConfig(request.text)) {
      // Mermaid's own reading of the text, so the app and mermaid cannot
      // disagree about what a piece of YAML means. A source it cannot parse
      // throws here exactly as it would in `render`.
      const { config } = await mermaid.parse(request.text)
      const own = resolveMermaidOwnTheme(config.theme, request.theme)
      ownTheme = own.ownTheme
      // The page, too, when the text that names a theme also gives it one:
      // mermaid keeps a `background` the text sets exactly as written, for
      // every theme. Asked only of a diagram that themes itself — for any
      // other the page is the block's to decide.
      ownSurface = ownTheme === undefined ? undefined : normalizeMermaidOwnSurface(config.themeVariables?.background)
      if (own.withoutAppPalette) {
        configure(mermaid, siteConfig(request, false))
      }
    }
    const { svg } = await mermaid.render(request.id, request.text, request.measureIn)
    return { svg, ownTheme, ownSurface }
  })
}

/** A diagram as mermaid parsed it: its kind, and the database its parser filled. */
export type MermaidParsedDiagram = { type: string; db: unknown }

/**
 * What mermaid makes of a diagram's text, WITHOUT drawing it: the diagram is
 * parsed and `extract` is handed the result. Rejects with mermaid's own error
 * for a text it cannot parse.
 *
 * It takes its turn in the same line as the renders, for two reasons. The
 * reading depends on mermaid's global configuration — the security level
 * decides what a label is sanitised to — so it is taken under a configuration
 * of its own, and configuring is exactly what must never happen between
 * another diagram's `initialize` and its `render`. And several diagram kinds
 * keep their database in a module-level singleton that the next parse
 * overwrites, which is why the caller reads what it needs inside `extract`
 * rather than being handed the database to keep.
 *
 * The configuration is the application's without any diagram's own theme or
 * palette: what a text means does not depend on what it is drawn with.
 */
export async function readMermaidDiagram<T>(text: string, extract: (diagram: MermaidParsedDiagram) => T): Promise<T> {
  const mermaid = await loadMermaid()
  return inTurn(async () => {
    configure(mermaid, { startOnLoad: false, securityLevel: 'strict', secure: [...MERMAID_APP_SECURE_KEYS] })
    const diagram = await mermaid.mermaidAPI.getDiagramFromText(text)
    return extract({ type: diagram.type, db: diagram.db })
  })
}
