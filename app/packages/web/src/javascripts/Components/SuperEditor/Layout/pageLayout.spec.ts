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
  loadNoteLayout,
  normalizeNoteLayout,
  saveNoteLayout,
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
  const withLayout = (patch: Partial<NoteLayout>): NoteLayout =>
    normalizeNoteLayout({ ...DEFAULT_NOTE_LAYOUT, ...patch })

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

  it('an enabled but UN-styled band maps to exactly { text, align } (no style keys — back-compat)', () => {
    const options = noteLayoutToPageLayoutOptions(
      withLayout({ header: { enabled: true, text: 'Hi', align: 'center' } }),
    )
    // Must NOT gain any style keys, so its export stays byte-identical to t48.
    expect(options).toEqual({ header: { text: 'Hi', align: 'center' } })
  })

  it('carries only the set style fields into a styled band (dropping the no-op default font)', () => {
    const options = noteLayoutToPageLayoutOptions(
      withLayout({
        header: {
          enabled: true,
          text: 'Title',
          align: 'left',
          fontId: 'serif',
          fontSizePt: 14,
          bold: true,
          color: '#ff0000',
        },
        footer: { enabled: true, text: 'Foot', align: 'right', fontId: 'default', italic: true, underline: true },
      }),
    )
    expect(options?.header).toEqual({
      text: 'Title',
      align: 'left',
      fontId: 'serif',
      fontSizePt: 14,
      bold: true,
      color: '#ff0000',
    })
    // fontId 'default' is a no-op ⇒ dropped; only the real style keys survive.
    expect(options?.footer).toEqual({ text: 'Foot', align: 'right', italic: true, underline: true })
  })
})

describe('normalizeHeaderFooter — optional style fields', () => {
  it('leaves legacy / default records with NO style keys (byte-identical export)', () => {
    const legacy = normalizeNoteLayout({ header: { enabled: true, text: 'x', align: 'left' } }).header
    expect(legacy).toEqual({ enabled: true, text: 'x', align: 'left' })
    expect('fontId' in legacy).toBe(false)
    expect('bold' in legacy).toBe(false)
    expect('color' in legacy).toBe(false)
  })

  it('whitelists fontId and drops unknown ids and the no-op "default"', () => {
    expect(normalizeNoteLayout({ header: { fontId: 'serif' } }).header.fontId).toBe('serif')
    expect('fontId' in normalizeNoteLayout({ header: { fontId: 'comic-sans' } }).header).toBe(false)
    // 'default' means "no font" ⇒ never stored as a key.
    expect('fontId' in normalizeNoteLayout({ header: { fontId: 'default' } }).header).toBe(false)
  })

  it('clamps fontSizePt into range and omits non-numbers', () => {
    expect(normalizeNoteLayout({ header: { fontSizePt: 14 } }).header.fontSizePt).toBe(14)
    expect(normalizeNoteLayout({ header: { fontSizePt: 2 } }).header.fontSizePt).toBe(6) // MIN
    expect(normalizeNoteLayout({ header: { fontSizePt: 999 } }).header.fontSizePt).toBe(72) // MAX
    expect(normalizeNoteLayout({ header: { fontSizePt: 12.6 } }).header.fontSizePt).toBe(13) // rounded
    expect('fontSizePt' in normalizeNoteLayout({ header: { fontSizePt: 'big' } }).header).toBe(false)
    expect('fontSizePt' in normalizeNoteLayout({ header: { fontSizePt: '' } }).header).toBe(false)
  })

  it('sets bold/italic/underline only when strictly true', () => {
    const on = normalizeNoteLayout({ header: { bold: true, italic: true, underline: true } }).header
    expect(on.bold).toBe(true)
    expect(on.italic).toBe(true)
    expect(on.underline).toBe(true)
    const off = normalizeNoteLayout({ header: { bold: 'yes', italic: 1, underline: 0 } }).header
    expect('bold' in off).toBe(false)
    expect('italic' in off).toBe(false)
    expect('underline' in off).toBe(false)
  })

  it('validates + normalizes color to lowercase #rrggbb, dropping invalid values', () => {
    expect(normalizeNoteLayout({ header: { color: '#AABBCC' } }).header.color).toBe('#aabbcc')
    expect(normalizeNoteLayout({ header: { color: 'ff0000' } }).header.color).toBe('#ff0000')
    expect('color' in normalizeNoteLayout({ header: { color: 'red' } }).header).toBe(false)
    expect('color' in normalizeNoteLayout({ header: { color: '#12345' } }).header).toBe(false)
    expect('color' in normalizeNoteLayout({ header: { color: 42 } }).header).toBe(false)
  })

  it('never throws on garbage style values', () => {
    expect(() => normalizeNoteLayout({ header: { fontId: {}, fontSizePt: [], bold: null, color: [] } })).not.toThrow()
  })
})

describe('normalizeNoteLayout — navigation sidebar (on-screen only)', () => {
  it('defaults navigation to hidden with bookmarks enabled', () => {
    expect(DEFAULT_NOTE_LAYOUT.navigation).toEqual({ visible: false, showBookmarks: true })
    // Back-filled onto a legacy record that predates the field.
    const legacy = { pageSizeId: 'a4', orientation: 'portrait', marginId: 'normal', customMargin: '1cm', columns: 1 }
    expect(normalizeNoteLayout(legacy).navigation).toEqual({ visible: false, showBookmarks: true })
  })

  it('coerces navigation: only strict true shows it, only strict false disables bookmarks', () => {
    expect(normalizeNoteLayout({ navigation: { visible: true, showBookmarks: false } }).navigation).toEqual({
      visible: true,
      showBookmarks: false,
    })
    // Non-boolean / missing → safe defaults.
    expect(normalizeNoteLayout({ navigation: { visible: 'yes', showBookmarks: 0 } }).navigation).toEqual({
      visible: false,
      showBookmarks: true,
    })
    expect(normalizeNoteLayout({ navigation: 'nonsense' }).navigation).toEqual({ visible: false, showBookmarks: true })
    expect(normalizeNoteLayout({ navigation: null }).navigation).toEqual({ visible: false, showBookmarks: true })
  })

  it('round-trips navigation through save/load', () => {
    const uuid = 'nav-roundtrip-note'
    saveNoteLayout(uuid, { ...DEFAULT_NOTE_LAYOUT, navigation: { visible: true, showBookmarks: false } })
    expect(loadNoteLayout(uuid).navigation).toEqual({ visible: true, showBookmarks: false })
  })

  it('never throws on garbage navigation values', () => {
    expect(() => normalizeNoteLayout({ navigation: { visible: [], showBookmarks: {} } })).not.toThrow()
  })
})

describe('noteLayoutToPageLayoutOptions — navigation is NOT an export band', () => {
  it('ignores navigation entirely (export byte-identical whether the sidebar is on or off)', () => {
    // Default layout (everything off) still maps to undefined even with navigation present.
    expect(noteLayoutToPageLayoutOptions(DEFAULT_NOTE_LAYOUT)).toBeUndefined()

    const hidden = normalizeNoteLayout({ ...DEFAULT_NOTE_LAYOUT, navigation: { visible: false, showBookmarks: true } })
    const visible = normalizeNoteLayout({ ...DEFAULT_NOTE_LAYOUT, navigation: { visible: true, showBookmarks: false } })
    // Toggling the on-screen sidebar must not change export output at all.
    expect(noteLayoutToPageLayoutOptions(visible)).toEqual(noteLayoutToPageLayoutOptions(hidden))
    expect(noteLayoutToPageLayoutOptions(visible)).toBeUndefined()

    // With an actual export band enabled, the mapped options are identical
    // regardless of the navigation flag (navigation contributes nothing).
    const withHeader = (nav: { visible: boolean; showBookmarks: boolean }) =>
      noteLayoutToPageLayoutOptions(
        normalizeNoteLayout({
          ...DEFAULT_NOTE_LAYOUT,
          header: { enabled: true, text: 'Title', align: 'center' },
          navigation: nav,
        }),
      )
    expect(withHeader({ visible: true, showBookmarks: true })).toEqual(
      withHeader({ visible: false, showBookmarks: false }),
    )
    expect(withHeader({ visible: true, showBookmarks: true })).toEqual({ header: { text: 'Title', align: 'center' } })
  })
})
