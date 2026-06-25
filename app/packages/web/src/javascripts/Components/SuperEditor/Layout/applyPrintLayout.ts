/**
 * Standard Red Notes: bridge between a note's persisted `NoteLayout` and the
 * browser print pipeline. Right before `window.print()` we inject a single
 * dynamic `<style>` element into `<head>` that:
 *
 *   - sets `@page { size: <size> <orientation>; margin: <margin> }`, overriding
 *     the static `@page { margin: 1.5cm }` baked into `_print.scss`;
 *   - applies `column-count` (+ a column gap) to `#editor-content` so the note
 *     content flows into the requested number of columns when printed;
 *   - turns the page-break decorator node into a hard `break-after: page`.
 *
 * The injected style id is fixed so a previous (un-removed) style is always
 * replaced rather than duplicated. `removePrintLayout()` cleans it up after.
 */
import { ElementIds } from '@/Constants/ElementIDs'
import { loadNoteLayout, resolveMargin, resolvePageSize } from './layoutSettings'

/** Stable id of the injected <style>, and the class the page-break node carries. */
export const PRINT_LAYOUT_STYLE_ID = 'srn-print-layout-style'
export const PAGE_BREAK_CLASS = 'srn-page-break'

function buildPrintLayoutCss(noteUuid: string | undefined): string {
  const layout = loadNoteLayout(noteUuid)
  const size = resolvePageSize(layout)
  const margin = resolveMargin(layout)
  const editorContent = `#${ElementIds.EditorContent}`

  // Only emit the column rule when the user actually wants multiple columns so
  // single-column notes keep the default flow exactly.
  const columnRule =
    layout.columns > 1
      ? `@media print { ${editorContent} { column-count: ${layout.columns} !important; column-gap: 1.5rem !important; } }`
      : ''

  return [
    `@media print { @page { size: ${size.cssSize} ${layout.orientation}; margin: ${margin}; } }`,
    columnRule,
    // The page-break node renders a divider on screen; for print/export it must
    // force a hard page break after itself (and never show its own chrome).
    `@media print { .${PAGE_BREAK_CLASS} { break-after: page !important; page-break-after: always !important; height: 0 !important; margin: 0 !important; border: none !important; visibility: hidden !important; } }`,
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Inject (or replace) the dynamic print-layout `<style>` for the given note.
 * Returns the element so callers can keep a handle if they prefer.
 */
export function applyPrintLayout(noteUuid: string | undefined): HTMLStyleElement {
  removePrintLayout()
  const style = document.createElement('style')
  style.id = PRINT_LAYOUT_STYLE_ID
  style.textContent = buildPrintLayoutCss(noteUuid)
  document.head.appendChild(style)
  return style
}

/** Remove the dynamic print-layout `<style>` if present. */
export function removePrintLayout(): void {
  const existing = document.getElementById(PRINT_LAYOUT_STYLE_ID)
  if (existing) {
    existing.remove()
  }
}
