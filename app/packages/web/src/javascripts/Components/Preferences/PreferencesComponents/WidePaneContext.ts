import { createContext, useContext } from 'react'

/**
 * Layout hint flowing from the Preferences layout (PreferencesCanvas, which knows
 * the selected menu item) down to the generic PreferencesPane wrapper: when true,
 * the pane's content column renders at double the standard width (62.5rem instead
 * of 31.25rem), still capped to the available space so it never forces horizontal
 * page scroll. Set per pane via the `wide` flag on its PreferencesMenuItem
 * (currently only 'admin', which hosts big tables).
 *
 * Lives in its own module (rather than in PreferencesCanvas or PreferencesPane)
 * to avoid an import cycle: Canvas → PaneSelector → panes → PreferencesPane.
 */
export const WidePaneContext = createContext(false)

export const useIsWidePane = (): boolean => useContext(WidePaneContext)
