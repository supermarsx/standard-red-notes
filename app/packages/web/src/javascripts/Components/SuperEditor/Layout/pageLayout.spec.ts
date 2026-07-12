/**
 * Unit tests for the t48 page-layout additions to NoteLayout:
 *  - `normalizeNoteLayout` back-fills the new pageNumbering / header / footer
 *    fields onto legacy records, clamps startAt, whitelists enums, never throws;
 *  - `noteLayoutToPageLayoutOptions` returns `undefined` when everything is off
 *    (baseline export path) and the right serializable shape when opted in.
 */
import {
  DEFAULT_NOTE_LAYOUT,
  MAX_PAGE_START,
  NoteLayout,
  normalizeNoteLayout,
} from './layoutSettings'
import { noteLayoutToPageLayoutOptions } from '../Lexical/Utils/DocExport/PageLayoutOptions'

describe('normalizeNoteLayout — page numbering / header / footer back-fill', () => {
  it('back-fills the three new fields (all OFF) onto a legacy record that lacks them', () => {
    // A pre-t48 persisted record: only the original four fields.
    const legacy = { pageSizeId: 'letter', orientation: 'landscape', marginId: 'wide', customMargin: '2cm', columns: 2 }
    const normalized = normalizeNoteLayout(legacy)

    expect(normalized.pageNumbering).toEqual(DEFAULT_NOTE_LAYOUT.pageNumbering)
    expect(normalized.header).toEqual(DEFAULT_NOTE_LAYOUT.header)
    expect(normalized.footer).toEqual(DEFAULT_NOTE_LAYOUT.footer)
    // Everything defaults OFF ⇒ no export behavior change.
    expect(normalized.pageNumbering.enabled).toBe(false)
    expect(normalized.header.enabled).toBe(false)
    expect(normalized.footer.enabled).toBe(false)
    // Original fields preserved.
    expect(normalized.pageSizeId).toBe('letter')
    expect(normalized.columns).toBe(2)
  })

  it('returns the full defaults (incl. new fields) for garbage input, never throwing', () => {
    expect(normalizeNoteLayout(null)).toEqual(DEFAULT_NOTE_LAYOUT)
    expect(normalizeNoteLayout('nonsense')).toEqual(DEFAULT_NOTE_LAYOUT)
    expect(normalizeNoteLayout(42)).toEqual(DEFAULT_NOTE_LAYOUT)
  })

  it('clamps startAt to >= 1 and <= MAX_PAGE_START, rounding floats', () => {
    expect(normalizeNoteLayout({ pageNumbering: { startAt: 0 } }).pageNumbering.startAt).toBe(1)
    expect(normalizeNoteLayout({ pageNumbering: { startAt: -50 } }).pageNumbering.startAt).toBe(1)
    expect(normalizeNoteLayout({ pageNumbering: { startAt: 3.7 } }).pageNumbering.startAt).toBe(4)
    expect(normalizeNoteLayout({ pageNumbering: { startAt: 9e9 } }).pageNumbering.startAt).toBe(MAX_PAGE_START)
    expect(normalizeNoteLayout({ pageNumbering: { startAt: 'x' } }).pageNumbering.startAt).toBe(1)
  })

  it('whitelists format / align / location enums, falling back on unknown values', () => {
    const bad = normalizeNoteLayout({
      pageNumbering: { format: 'roman', align: 'middle', location: 'sidebar' },
      header: { align: 'nope' },
    })
    expect(bad.pageNumbering.format).toBe(DEFAULT_NOTE_LAYOUT.pageNumbering.format)
    expect(bad.pageNumbering.align).toBe(DEFAULT_NOTE_LAYOUT.pageNumbering.align)
    expect(bad.pageNumbering.location).toBe('footer')
    expect(bad.header.align).toBe(DEFAULT_NOTE_LAYOUT.header.align)

    const good = normalizeNoteLayout({
      pageNumbering: { enabled: true, format: 'n-of-total', align: 'right', location: 'header', startAt: 5 },
      header: { enabled: true, text: 'Hi', align: 'left' },
      footer: { enabled: true, text: 'Bye', align: 'right' },
    })
    expect(good.pageNumbering).toEqual({
      enabled: true,
      format: 'n-of-total',
      align: 'right',
      location: 'header',
      startAt: 5,
    })
    expect(good.header).toEqual({ enabled: true, text: 'Hi', align: 'left' })
    expect(good.footer).toEqual({ enabled: true, text: 'Bye', align: 'right' })
  })

  it('coerces non-string header/footer text and non-boolean enabled', () => {
    const n = normalizeNoteLayout({ header: { enabled: 'yes', text: 123 }, footer: { enabled: 1 } })
    // enabled must be a strict boolean (only `true` enables).
    expect(n.header.enabled).toBe(false)
    expect(n.footer.enabled).toBe(false)
    // Non-string text falls back to the default ('').
    expect(n.header.text).toBe('')
  })
})

describe('noteLayoutToPageLayoutOptions', () => {
  const withLayout = (patch: Partial<NoteLayout>): NoteLayout => normalizeNoteLayout({ ...DEFAULT_NOTE_LAYOUT, ...patch })

  it('returns undefined when nothing is enabled (baseline export path)', () => {
    expect(noteLayoutToPageLayoutOptions(DEFAULT_NOTE_LAYOUT)).toBeUndefined()
  })

  it('maps only the enabled pieces into the serializable options', () => {
    const options = noteLayoutToPageLayoutOptions(
      withLayout({
        pageNumbering: { enabled: true, format: 'n', align: 'right', location: 'header', startAt: 3 },
        footer: { enabled: true, text: 'Page {page} of {total}', align: 'center' },
      }),
    )
    expect(options).toEqual({
      pageNumber: { format: 'n', align: 'right', location: 'header', startAt: 3 },
      footer: { text: 'Page {page} of {total}', align: 'center' },
    })
    // Header is off ⇒ not present.
    expect(options?.header).toBeUndefined()
  })

  it('includes an enabled header even when its text is empty', () => {
    const options = noteLayoutToPageLayoutOptions(withLayout({ header: { enabled: true, text: '', align: 'left' } }))
    expect(options).toEqual({ header: { text: '', align: 'left' } })
  })
})
