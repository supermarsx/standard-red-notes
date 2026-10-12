import type * as React from 'react'

/**
 * Standard Red Notes — the look of a Mermaid control, in one place.
 *
 * The settings clusters (MermaidSettingsPanel) and the Customise panel
 * (MermaidCustomisePanel) sit side by side on the same ribbon and in the same
 * popovers, so a select or a segmented group in one must be the select or the
 * group in the other. These are the class strings both are built from.
 */

export const MERMAID_SELECT_CLASS =
  'rounded border border-border bg-default px-1 py-0.5 text-foreground outline-none focus:border-info'

export const MERMAID_GROUP_CLASS = 'border-border flex overflow-hidden rounded border text-xs'

export const mermaidSegmentClass = (active: boolean): string =>
  'px-1.5 py-0.5 ' + (active ? 'bg-info text-info-contrast' : 'hover:bg-contrast')

/** Keeps the caret in the editor when a control inside the toolbar is clicked. */
export const keepEditorFocus = (event: React.MouseEvent): void => event.preventDefault()
