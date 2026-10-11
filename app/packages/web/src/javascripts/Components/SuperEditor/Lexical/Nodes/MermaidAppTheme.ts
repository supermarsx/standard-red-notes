/**
 * Standard Red Notes — the LIVE application theme, as a mermaid render surface
 * needs it.
 *
 * MermaidSettings.ts owns the pure decisions (which polarity, which palette,
 * which mermaid config). This module owns the two impure halves: reading the
 * palette out of the live cascade, and knowing WHEN it has changed.
 *
 * It owns the LABEL FONT for the same two reasons. The font a diagram's labels
 * are drawn in is also only knowable from the live cascade (the Editor Font
 * preference is a custom property on `<html>`, resolved through `.font-editor`),
 * and it changes through exactly the signals listed below — `editorFont.ts`
 * writes the property onto `documentElement.style` and appends a Google-Fonts
 * `<link>` whose `load` is when the family becomes measurable. Why mermaid has
 * to be told it CONCRETELY, rather than the `fontFamily: 'inherit'` that used
 * to be passed, is in `resolveMermaidLabelFontFamily` in MermaidSettings.ts.
 *
 *
 * WHERE THE APP'S THEME ACTUALLY LIVES
 *
 * Not `prefers-color-scheme`. A theme here is a stylesheet: ThemeManager
 * installs one by appending `<link rel="stylesheet">` to `<head>`
 * (`ui-services/src/Theme/ThemeManager.ts`, `activateTheme`) and uninstalls it
 * by removing that element; the stylesheet redefines the `--sn-stylekit-*`
 * custom properties on `:root`. ThemeManager itself then reads the result back
 * with `getComputedStyle(document.documentElement).getPropertyValue(...)` for
 * the theme-colour meta tag and the native shell. So the computed value of
 * those properties IS the source of truth, and it covers a user-selected
 * built-in theme, a third-party component theme and a hand-written custom theme
 * identically. A `matchMedia` check cannot: it reports the OS preference, which
 * says nothing about the theme the user picked.
 *
 *
 * WHY THE LIVE SWITCH NEEDED THIS MODULE
 *
 * The previous subscription was a `MutationObserver` on `document.documentElement`
 * filtered to `style` and `class`. A theme switch changes NEITHER — it adds and
 * removes a `<link>` in `<head>`. It appeared to work only because
 * `ThemeManager.toggleTranslucentUIColors()` writes `--popover-background-color`
 * onto `documentElement.style` from the new stylesheet's `onload`. With the
 * translucent-UI preference off (`LocalPrefKey.UseTranslucentUI`) that write
 * becomes a `removeProperty` of a property that is not set, no attribute
 * changes, no mutation record is delivered, and the diagram keeps rendering the
 * previous theme until something else happens to re-render it. Measured in
 * headless Chrome: mermaid's dark node fill `rgb(31,32,32)` with its pale
 * `rgb(204,204,204)` labels still on screen after the app had gone white —
 * 1.61 contrast against the page.
 *
 * So this watches what actually changes:
 *
 *   1. a stylesheet FINISHING loading — `load` does not bubble, but a
 *      capture-phase listener on `document` still receives it, which is the same
 *      hook ThemeManager uses on the element itself. This is the exact instant a
 *      newly installed theme's palette becomes readable.
 *   2. `<head>` gaining or losing children — a REMOVED stylesheet applies
 *      synchronously and fires no `load` at all, so (1) alone would miss
 *      "switch back to the default theme" entirely.
 *   3. attributes on `<html>` and `<body>` — an inline-style palette, the
 *      translucent-UI write, and any class-switched theme.
 *   4. the OS `prefers-color-scheme`, which is still the answer when no theme
 *      declares a type and no palette can be read.
 *
 * A `<head>` insertion is delivered before the stylesheet has applied, so every
 * notification also schedules one deferred re-read; (1) covers the same moment
 * from the other side, and a re-read that finds no change costs one
 * `getComputedStyle` and dispatches no React update.
 */
import { useEffect, useRef, useState, type RefObject } from 'react'
import {
  buildMermaidAppTokens,
  canMeasureMermaidIn,
  isDarkMermaidSurface,
  mermaidAppThemeIsDark,
  MERMAID_APP_TOKEN_PROPERTIES,
  MERMAID_LABEL_FONT_FALLBACK,
  resolveMermaidLabelFontFamily,
  type MermaidAppTheme,
} from './MermaidSettings'

/** The theme of an environment with no layout engine at all. */
export const UNREADABLE_MERMAID_APP_THEME: MermaidAppTheme = { isDark: false, tokens: null }

/**
 * Read the application's current theme from the live cascade. Impure by
 * definition; every decision it makes is delegated to the pure functions in
 * MermaidSettings.
 */
export function readMermaidAppTheme(): MermaidAppTheme {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return UNREADABLE_MERMAID_APP_THEME
  }
  const styles = window.getComputedStyle(document.documentElement)
  const read = (property: string): string => styles.getPropertyValue(property)
  const backgroundColor = read(MERMAID_APP_TOKEN_PROPERTIES.background)
  const isDark = mermaidAppThemeIsDark({
    themeType: declaredThemeTypeToTrust(read(MERMAID_APP_TOKEN_PROPERTIES.themeType), backgroundColor),
    backgroundColor,
    prefersDark: window.matchMedia?.('(prefers-color-scheme: dark)')?.matches === true,
  })
  return { isDark, tokens: buildMermaidAppTokens(read, isDark) }
}

/**
 * A declared `--sn-stylekit-theme-type`, but only when it agrees with the colour
 * the theme actually paints; otherwise `''`, which drops the decision to the
 * background's own luminance.
 *
 * This exists because the declaration LEAKS. A theme stylesheet overrides only
 * the properties it names, and the base `:root` underneath it declares
 * `--sn-stylekit-theme-type: dark` (this product's palette is dark), so a theme
 * that declares no type inherits `dark` whatever it looks like. The Autobiography
 * theme is exactly that: a light, cream `#ede4da` page
 * (`components/assets/org.standardnotes.theme-autobiography/index.css`, whose
 * `features/Domain/Lists/Themes.ts` entry carries no `isDark`) which reads back
 * as `theme-type: dark`. Trusting the declaration there puts a dark chart on a
 * cream page. The background colour cannot leak the same way — every theme sets
 * it, and it is the colour on screen.
 *
 * Note what this does NOT do: it never overrules a declaration that agrees with
 * its own background, so a theme whose type is a deliberate statement still
 * wins over a borderline luminance.
 */
export function declaredThemeTypeToTrust(declared: unknown, backgroundColor: unknown): string {
  const text = typeof declared === 'string' ? declared.trim().toLowerCase() : ''
  if (text !== 'dark' && text !== 'light') {
    return text
  }
  const backgroundIsDark = isDarkMermaidSurface(backgroundColor)
  if (backgroundIsDark === null) {
    return text
  }
  return backgroundIsDark === (text === 'dark') ? text : ''
}

/**
 * A value that changes exactly when the rendered diagram would have to change.
 * Used to suppress a re-render for a theme event that moved no colour — a
 * stylesheet load fires for every image and script too.
 */
export function mermaidAppThemeKey(theme: MermaidAppTheme): string {
  const tokens = theme.tokens
  return [
    theme.isDark ? 'dark' : 'light',
    tokens
      ? [
          tokens.background,
          tokens.foreground,
          tokens.contrastBackground,
          tokens.secondaryBackground,
          tokens.secondaryContrastBackground,
          tokens.border,
          tokens.passive,
        ].join('|')
      : 'no-tokens',
  ].join('/')
}

/**
 * THE subscription: every signal, listed above, that can change what this
 * module reads out of the live cascade. `onChange` is called once immediately
 * and again on each signal; it must do its own change detection, because a
 * stylesheet `load` fires for every image and script too.
 *
 * Shared, not duplicated, because the EDITOR FONT changes through exactly the
 * same two mechanisms a theme does — `editorFont.ts` writes
 * `--sn-stylekit-editor-font-family` onto `document.documentElement.style`
 * (signal 3) and appends a Google-Fonts `<link>` to `<head>` whose `load` is
 * when the family becomes measurable (signals 1 and 2). A second observer set
 * would be the same four listeners with the same deferred re-read.
 */
export function subscribeToAppThemeSignals(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => undefined
  }

  let disposed = false
  let deferred: number | undefined

  const refresh = (): void => {
    if (disposed) {
      return
    }
    onChange()
  }

  // A `<head>` insertion is reported before the new stylesheet has applied, so
  // read again once the browser has had a frame to apply it.
  const refreshSoon = (): void => {
    refresh()
    if (deferred !== undefined) {
      return
    }
    const schedule =
      typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame.bind(window)
        : (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 16)
    deferred = schedule(() => {
      deferred = undefined
      refresh()
    }) as unknown as number
  }

  refresh()

  // (1) A stylesheet finished loading. `load` does not bubble; the capture
  // phase still delivers it.
  document.addEventListener('load', refresh, true)

  // (2) A theme stylesheet added to, or removed from, `<head>`.
  const headObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(refreshSoon)
  if (document.head) {
    headObserver?.observe(document.head, { childList: true })
  }

  // (3) An inline-style or class-switched palette on the root or the body.
  const attributeObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(refresh)
  attributeObserver?.observe(document.documentElement, { attributes: true })
  if (document.body) {
    attributeObserver?.observe(document.body, { attributes: true })
  }

  // (4) The OS preference, which still decides when nothing else can.
  const media = window.matchMedia?.('(prefers-color-scheme: dark)')
  media?.addEventListener?.('change', refresh)

  return () => {
    disposed = true
    document.removeEventListener('load', refresh, true)
    headObserver?.disconnect()
    attributeObserver?.disconnect()
    media?.removeEventListener?.('change', refresh)
    if (deferred !== undefined && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(deferred)
    }
  }
}

/**
 * Subscribe to the application's theme. The returned object is referentially
 * stable while the palette is unchanged, so a consumer may depend on it
 * directly in an effect without re-rendering its diagram on every unrelated
 * mutation.
 */
export function useMermaidAppTheme(): MermaidAppTheme {
  const [theme, setTheme] = useState<MermaidAppTheme>(readMermaidAppTheme)
  const keyRef = useRef<string>(mermaidAppThemeKey(theme))

  useEffect(
    () =>
      subscribeToAppThemeSignals(() => {
        const next = readMermaidAppTheme()
        const key = mermaidAppThemeKey(next)
        if (key === keyRef.current) {
          return
        }
        keyRef.current = key
        setTheme(next)
      }),
    [],
  )

  return theme
}

/**
 * The font a diagram's labels will actually be DRAWN in, resolved off the
 * element the diagram is drawn inside, as a concrete stack that means the same
 * thing in `document.body` (where mermaid measures) as it does here. See
 * `resolveMermaidLabelFontFamily` in MermaidSettings.ts for why `inherit` is
 * not an answer.
 */
export function readMermaidLabelFontFamily(element: Element | null | undefined): string {
  if (!element || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
    return MERMAID_LABEL_FONT_FALLBACK
  }
  return resolveMermaidLabelFontFamily(window.getComputedStyle(element).fontFamily)
}

/**
 * The element to hand `mermaid.render` as its `svgContainingElement`, or
 * `undefined` to leave mermaid on its `document.body` path.
 *
 * `offsetParent` is the cheap, exact test for "is being rendered": it is `null`
 * for every element in a `display: none` subtree, which is the case the
 * container argument cannot serve (no layout engine, every rect zero). The
 * measuring element is `position: absolute`, so `offsetParent` is otherwise its
 * nearest positioned ancestor and never `null` for that reason. See
 * `canMeasureMermaidIn` in MermaidSettings.ts for the rest of the why.
 */
export function readMermaidMeasurementContainer(element: HTMLElement | null | undefined): HTMLElement | undefined {
  if (!element || typeof element.getBoundingClientRect !== 'function') {
    return undefined
  }
  const layout = { width: element.getBoundingClientRect().width, isRendered: element.offsetParent !== null }
  return canMeasureMermaidIn(layout) ? element : undefined
}

/**
 * The label font, kept live. Read off `ref` — the diagram's own block, so a
 * per-note or per-subtree override is picked up as readily as the global
 * preference — and re-read on the same signals the theme uses.
 *
 * Returns the fallback until the ref is attached, which is the first paint
 * only: the subscription's immediate read happens in an effect, long before the
 * component's render debounce fires.
 */
export function useMermaidLabelFontFamily(ref: RefObject<Element | null>): string {
  const [fontFamily, setFontFamily] = useState<string>(MERMAID_LABEL_FONT_FALLBACK)

  useEffect(
    () =>
      subscribeToAppThemeSignals(() => {
        const next = readMermaidLabelFontFamily(ref.current)
        setFontFamily((current) => (current === next ? current : next))
      }),
    [ref],
  )

  return fontFamily
}

/**
 * Increments when the browser finishes loading font faces.
 *
 * A concrete family NAME is not the same as concrete METRICS. `editorFont.ts`
 * loads a Google font with `display=swap`, so between the stylesheet arriving
 * and the woff2 arriving the editor paints a generic fallback under the chosen
 * family's name. A diagram rendered in that window is measured in the fallback
 * and then repainted in the webfont, with its node boxes still the fallback's
 * size — the same defect as `fontFamily: 'inherit'`, triggered by time instead
 * of by a preference. The family string is byte-identical either side of the
 * swap, so nothing keyed on it can notice; this is keyed on the swap itself.
 *
 * `document.fonts` is absent in jsdom and in any non-browser environment, where
 * this stays at 0 and costs nothing.
 */
export function useFontFacesLoadedToken(): number {
  const [token, setToken] = useState(0)

  useEffect(() => {
    const fonts = typeof document === 'undefined' ? undefined : document.fonts
    if (!fonts || typeof fonts.addEventListener !== 'function') {
      return
    }
    const bump = (): void => setToken((n) => n + 1)
    fonts.addEventListener('loadingdone', bump)
    return () => fonts.removeEventListener('loadingdone', bump)
  }, [])

  return token
}
