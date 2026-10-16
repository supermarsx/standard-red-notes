/** @jest-environment jsdom */
import {
  CUSTOM_PAGE_SIZE_ID,
  DEFAULT_NOTE_LAYOUT,
  loadLayoutDefaults,
  loadNoteLayout,
  normalizeNoteLayout,
  resetNoteLayout,
  resolvePageCssSize,
  resolvePageDimensionsMm,
  saveLayoutDefaults,
  saveNoteLayout,
} from './layoutSettings'
import { applyPrintLayout, removePrintLayout } from './applyPrintLayout'

beforeEach(() => localStorage.clear())
afterEach(removePrintLayout)

it('applies all configured defaults only to notes without explicit layout overrides', () => {
  const original = normalizeNoteLayout({ ...DEFAULT_NOTE_LAYOUT, pageSizeId: 'letter', columns: 2 })
  saveNoteLayout('existing', original)
  const defaults = normalizeNoteLayout({
    pageSizeId: CUSTOM_PAGE_SIZE_ID,
    customPageWidthMm: 180,
    customPageHeightMm: 240,
    orientation: 'landscape',
    marginId: 'custom',
    customMargin: '12mm',
    columns: 3,
    pageNumbering: { enabled: true, format: 'n-of-total', align: 'right', location: 'header', startAt: 5 },
    header: {
      enabled: true,
      text: 'Report {page}',
      align: 'left',
      fontId: 'serif',
      fontSizePt: 14,
      bold: true,
      italic: true,
      underline: true,
      color: '#123456',
    },
    footer: { enabled: true, text: 'Footer', align: 'right', fontId: 'mono', fontSizePt: 10, color: '#654321' },
    navigation: { visible: true, showBookmarks: false },
    lineNumbers: true,
    minimap: true,
  })
  expect(saveLayoutDefaults(defaults)).toBe(true)
  expect(loadLayoutDefaults()).toEqual(defaults)
  expect(loadNoteLayout('new-note')).toEqual(defaults)
  expect(loadNoteLayout(undefined)).toEqual(defaults)
  expect(loadNoteLayout('existing')).toEqual(original)
  resetNoteLayout('existing')
  expect(loadNoteLayout('existing')).toEqual(defaults)
})

it('preserves legacy per-note overrides when a field was added after the note was configured', () => {
  localStorage.setItem(
    'standardnotes.note.layout.v1',
    JSON.stringify({ legacy: { pageSizeId: 'a5', orientation: 'portrait' } }),
  )
  saveLayoutDefaults(
    normalizeNoteLayout({ pageSizeId: 'custom', customPageWidthMm: 120, header: { enabled: true, text: 'default' } }),
  )
  expect(loadNoteLayout('legacy')).toEqual(normalizeNoteLayout({ pageSizeId: 'a5', orientation: 'portrait' }))
})

it('rejects malformed persisted defaults and bounds custom dimensions', () => {
  localStorage.setItem('standardnotes.note.layout.defaults.v1', 'invalid-json')
  expect(loadLayoutDefaults()).toEqual(DEFAULT_NOTE_LAYOUT)
  const normalized = normalizeNoteLayout({ pageSizeId: 'custom', customPageWidthMm: -20, customPageHeightMm: 999999 })
  expect(resolvePageDimensionsMm(normalized)).toEqual({ widthMm: 10, heightMm: 2000 })
  expect(normalizeNoteLayout({ customPageWidthMm: NaN, customPageHeightMm: '20mm' })).toEqual(DEFAULT_NOTE_LAYOUT)
})

it('prints explicit custom dimensions with orientation applied once, without invalid orientation keywords', () => {
  saveNoteLayout(
    'custom',
    normalizeNoteLayout({
      pageSizeId: 'custom',
      customPageWidthMm: 120,
      customPageHeightMm: 180,
      orientation: 'landscape',
      columns: 2,
    }),
  )
  const css = applyPrintLayout('custom').textContent!
  expect(css).toContain('size: 180mm 120mm;')
  expect(css).not.toContain('180mm 120mm landscape')
  expect(css).toContain('column-count: 2')
  expect(resolvePageCssSize(normalizeNoteLayout({ pageSizeId: 'tabloid', orientation: 'landscape' }))).toBe(
    '431.8mm 279.4mm',
  )
  expect(resolvePageCssSize(DEFAULT_NOTE_LAYOUT)).toBe('A4 portrait')
})

it('keeps screen navigation off by default, strictly validates persisted toggles, and excludes them from print', () => {
  expect(normalizeNoteLayout(undefined)).toMatchObject({ lineNumbers: false, minimap: false })
  expect(normalizeNoteLayout({ lineNumbers: 'true', minimap: 1 })).toMatchObject({ lineNumbers: false, minimap: false })
  saveNoteLayout('screen-tools', normalizeNoteLayout({ lineNumbers: true, minimap: true }))
  expect(loadNoteLayout('screen-tools')).toMatchObject({ lineNumbers: true, minimap: true })
  const on = applyPrintLayout('screen-tools').textContent
  const off = applyPrintLayout('no-tools').textContent
  expect(on).toEqual(off)
})
