import { useLayoutEffect } from 'react'

/**
 * The attribute that marks the document root as the public share surface.
 * `_shared-view.scss` hangs the light palette off it; nothing else in the app
 * sets it, so the authenticated UI is untouched.
 */
export const SHARED_VIEW_ROOT_ATTRIBUTE = 'data-public-share'

/**
 * Standard Red Notes — give the public share page a theme context of its own.
 *
 *
 * WHAT THE SHARE PAGE RESOLVED BEFORE (measured, headless Chrome, fresh
 * stylesheets — `dist/app.css` is stale JIT output and was not used):
 *
 *   --sn-stylekit-theme-type        dark
 *   --sn-stylekit-background-color  #16090f
 *   --sn-stylekit-foreground-color  #eadde0
 *   body background                 rgb(22, 9, 15)
 *
 * and the SAME four values with the browser emulating
 * `prefers-color-scheme: light`. So the properties were not missing — the base
 * `:root` palette in `styles/src/Styles/_colors.scss` ships with the app and
 * applies on every route — but they were the dark Standard Red palette by
 * accident rather than by decision, because the share route returns before any
 * WebApplication boots and `ThemeManager` therefore never installs a theme.
 *
 * That matters more than it looks since commit `d3a6469f`: mermaid now derives
 * its palette from exactly those properties (`MermaidAppTheme.readMermaidAppTheme`
 * reads them off `document.documentElement` and `MermaidSettings` decides
 * polarity from `--sn-stylekit-theme-type` cross-checked against the luminance
 * of the background). Whatever the share page declares, diagrams follow.
 *
 *
 * THE DECISION. A public reader is not a user of this app: they have no
 * account, no stored preference and no installed theme, so the only signal
 * about how they want to read is the one their own OS provides. The share page
 * therefore honours `prefers-color-scheme`, and says so on the root element so
 * the whole cascade — including the mermaid palette reader — sees one coherent
 * answer:
 *
 *   dark / no preference   the shipped Standard Red dark palette (unchanged)
 *   light                  the light palette in `_shared-view.scss`
 *
 * WHY AN ATTRIBUTE ON `<html>` AND NOT A CLASS ON THE VIEW. The palette has to
 * be readable through `getComputedStyle(document.documentElement)`: that is
 * where `ThemeManager` writes it, and it is where `readMermaidAppTheme` looks.
 * A palette scoped to a wrapper `<div>` would style the page correctly and
 * still hand every diagram the wrong colours, because the diagram asks the root
 * element, not its own parent.
 */
export function useSharedViewThemeContext(): void {
  useLayoutEffect(() => {
    const root = document.documentElement
    root.setAttribute(SHARED_VIEW_ROOT_ATTRIBUTE, 'true')
    return () => {
      root.removeAttribute(SHARED_VIEW_ROOT_ATTRIBUTE)
    }
  }, [])
}
