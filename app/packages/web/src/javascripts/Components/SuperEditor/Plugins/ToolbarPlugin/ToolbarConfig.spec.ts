/**
 * Unit tests for the Super editor toolbar config application logic.
 *
 * These cover the pure filter+order core used to drive the toolbar from a saved
 * (user-customizable) config, independent of any React/Lexical rendering:
 *   - default/empty config == full default set, in default order (no-op)
 *   - hidden buttons removed; groups emptied by hiding dropped entirely
 *   - explicit group reorder respected; un-listed groups appended in default order
 *   - malformed / partial / unknown-id config falls back safely to default
 *   - DEFAULT_TOOLBAR_GROUPS is never mutated
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  applyToolbarConfig,
  DEFAULT_TOOLBAR_GROUPS,
  isLayoutSentinel,
  normalizeToolbarConfig,
  ToolbarButtonId,
  ToolbarGroupId,
} from './ToolbarConfig'

const groupIds = (groups: { id: ToolbarGroupId }[]) => groups.map((g) => g.id)
const allButtonIds = (groups: { buttons: { id: ToolbarButtonId }[] }[]) =>
  groups.flatMap((g) => g.buttons.map((b) => b.id))

describe('applyToolbarConfig', () => {
  it('returns the full default set unchanged for an empty config (no-op)', () => {
    const result = applyToolbarConfig({ groupOrder: [], hiddenButtonIds: [] })
    expect(result).toEqual(DEFAULT_TOOLBAR_GROUPS)
  })

  it('returns the full default set for undefined/null config', () => {
    expect(applyToolbarConfig(undefined)).toEqual(DEFAULT_TOOLBAR_GROUPS)
    expect(applyToolbarConfig(null)).toEqual(DEFAULT_TOOLBAR_GROUPS)
  })

  it('removes a hidden button while leaving the rest of its group intact', () => {
    const result = applyToolbarConfig({ groupOrder: [], hiddenButtonIds: [ToolbarButtonId.Bold] })
    const ids = allButtonIds(result)
    expect(ids).not.toContain(ToolbarButtonId.Bold)
    expect(ids).toContain(ToolbarButtonId.Italic)
    expect(ids).toContain(ToolbarButtonId.Cut)
  })

  it('drops a group entirely when all of its buttons are hidden', () => {
    const result = applyToolbarConfig({
      groupOrder: [],
      // Hide every button in the BlockStyle group (formatting options + the
      // typography-profile gallery) so the group has nothing left to render.
      hiddenButtonIds: [ToolbarButtonId.BlockStyle, ToolbarButtonId.TypographyGallery],
    })
    expect(groupIds(result)).not.toContain(ToolbarGroupId.BlockStyle)
  })

  it('respects an explicit group reorder', () => {
    const result = applyToolbarConfig({
      groupOrder: [ToolbarGroupId.AI, ToolbarGroupId.Clipboard],
      hiddenButtonIds: [],
    })
    const ids = groupIds(result)
    // Explicitly-ordered groups come first, in the given order.
    expect(ids[0]).toBe(ToolbarGroupId.AI)
    expect(ids[1]).toBe(ToolbarGroupId.Clipboard)
    // All groups still present (un-listed ones appended in default order).
    expect(new Set(ids)).toEqual(new Set(groupIds(DEFAULT_TOOLBAR_GROUPS)))
  })

  it('appends un-listed groups in their default order after the explicit ones', () => {
    const result = applyToolbarConfig({ groupOrder: [ToolbarGroupId.AI], hiddenButtonIds: [] })
    const ids = groupIds(result)
    expect(ids[0]).toBe(ToolbarGroupId.AI)
    const remainingDefaults = groupIds(DEFAULT_TOOLBAR_GROUPS).filter((id) => id !== ToolbarGroupId.AI)
    expect(ids.slice(1)).toEqual(remainingDefaults)
  })

  it('falls back to default for malformed config (non-object, wrong field types, unknown ids)', () => {
    expect(applyToolbarConfig('garbage')).toEqual(DEFAULT_TOOLBAR_GROUPS)
    expect(applyToolbarConfig(42)).toEqual(DEFAULT_TOOLBAR_GROUPS)
    expect(applyToolbarConfig({ groupOrder: 'nope', hiddenButtonIds: {} })).toEqual(DEFAULT_TOOLBAR_GROUPS)
    expect(
      applyToolbarConfig({ groupOrder: ['__unknown__'], hiddenButtonIds: ['__unknown__', 123, null] }),
    ).toEqual(DEFAULT_TOOLBAR_GROUPS)
  })

  it('does not mutate DEFAULT_TOOLBAR_GROUPS', () => {
    const before = JSON.stringify(DEFAULT_TOOLBAR_GROUPS)
    applyToolbarConfig({ groupOrder: [ToolbarGroupId.AI], hiddenButtonIds: [ToolbarButtonId.Bold] })
    expect(JSON.stringify(DEFAULT_TOOLBAR_GROUPS)).toBe(before)
  })

  it('trims the Insert group to exactly the three non-catalog actions (t41)', () => {
    // The general Insert dropdown + quick-insert buttons were replaced by inline
    // catalog sections (rendered by the Insert special-case). Only Link,
    // NoteFromSelection and Dictation remain as renderer-backed config buttons.
    const insert = DEFAULT_TOOLBAR_GROUPS.find((g) => g.id === ToolbarGroupId.Insert)
    expect(insert).toBeDefined()
    expect(insert!.buttons.map((b) => b.id)).toEqual([
      ToolbarButtonId.Link,
      ToolbarButtonId.NoteFromSelection,
      ToolbarButtonId.Dictation,
    ])
    // The removed ids must NOT be part of the default Insert group anymore…
    const removed = [
      ToolbarButtonId.InsertMenu,
      ToolbarButtonId.InsertTable,
      ToolbarButtonId.InsertImageFile,
      ToolbarButtonId.InsertDrawing,
      ToolbarButtonId.InsertEquation,
      ToolbarButtonId.InsertFootnote,
    ]
    const allButtonIdsInDefaults = allButtonIds(DEFAULT_TOOLBAR_GROUPS)
    for (const id of removed) {
      expect(allButtonIdsInDefaults).not.toContain(id)
    }
    // …but the enum values are retained for persisted-config back-compat.
    for (const id of removed) {
      expect(typeof id).toBe('string')
    }
  })
})

describe('Insert-sections vanish guard (static source assertion)', () => {
  // The Insert group is rendered by a dedicated special-case (inline catalog
  // sections), so — exactly like the BlockStyle group — its config buttons alone
  // must never decide whether the group survives the "drop groups with nothing
  // renderable" filter. This asserts the unconditional keep literally exists in
  // the source, since it has silently disappeared twice before and no runtime
  // test can mount the full ToolbarPlugin.
  const source = readFileSync(join(__dirname, 'ToolbarPlugin.tsx'), 'utf8')

  it('keeps the BlockStyle group unconditionally in resolvedGroups', () => {
    expect(source).toContain('group.id === ToolbarGroupId.BlockStyle ||')
  })

  it('keeps the Insert group unconditionally in resolvedGroups', () => {
    expect(source).toContain('group.id === ToolbarGroupId.Insert ||')
  })

  // t48: the new Page → Header/footer button. The Page group survives the
  // "drop groups with nothing renderable" filter only via renderer-backed
  // buttons, so its new button MUST have a render-map entry or it silently
  // won't render. The full ToolbarPlugin can't be jsdom-mounted (it closes over
  // deep editor state), so — as with the Insert/BlockStyle guards above — assert
  // the render-map entry exists literally in source.
  it('has a render-map entry for the new PageHeaderFooter button', () => {
    expect(source).toContain('[ToolbarButtonId.PageHeaderFooter]:')
  })
})

describe('Page group includes the Header/footer button (t48)', () => {
  it('lists PageHeaderFooter as the last button of the Page group', () => {
    const page = DEFAULT_TOOLBAR_GROUPS.find((g) => g.id === ToolbarGroupId.Page)
    expect(page).toBeDefined()
    const ids = page!.buttons.map((b) => b.id)
    expect(ids).toContain(ToolbarButtonId.PageHeaderFooter)
    expect(ids).toEqual([
      ToolbarButtonId.PageSize,
      ToolbarButtonId.PageOrientation,
      ToolbarButtonId.PageMargins,
      ToolbarButtonId.PageColumns,
      ToolbarButtonId.PageHeaderFooter,
    ])
  })

  it('keeps the Page group present (not filtered) after applying a default config', () => {
    const resolved = applyToolbarConfig({ groupOrder: [], hiddenButtonIds: [] })
    const page = resolved.find((g) => g.id === ToolbarGroupId.Page)
    expect(page).toBeDefined()
    expect(page!.buttons.map((b) => b.id)).toContain(ToolbarButtonId.PageHeaderFooter)
  })
})

describe('normalizeToolbarConfig', () => {
  it('strips unknown and duplicate ids', () => {
    const normalized = normalizeToolbarConfig({
      groupOrder: [ToolbarGroupId.AI, ToolbarGroupId.AI, '__nope__'],
      hiddenButtonIds: [ToolbarButtonId.Bold, ToolbarButtonId.Bold, '__nope__'],
    })
    expect(normalized.groupOrder).toEqual([ToolbarGroupId.AI])
    expect(normalized.hiddenButtonIds).toEqual([ToolbarButtonId.Bold])
  })

  it('returns empty arrays for non-object input', () => {
    expect(normalizeToolbarConfig(null)).toEqual({ groupOrder: [], hiddenButtonIds: [] })
    expect(normalizeToolbarConfig('x')).toEqual({ groupOrder: [], hiddenButtonIds: [] })
  })

  it('omits the new optional fields entirely for an empty/default config (no-op shape)', () => {
    const normalized = normalizeToolbarConfig({ groupOrder: [], hiddenButtonIds: [] })
    expect(normalized).toEqual({ groupOrder: [], hiddenButtonIds: [] })
    expect('buttonOrder' in normalized).toBe(false)
    expect('groupRows' in normalized).toBe(false)
    expect('horizontalScroll' in normalized).toBe(false)
  })

  it('keeps valid buttonOrder entries scoped to their own group, dropping foreign/unknown ids', () => {
    const normalized = normalizeToolbarConfig({
      groupOrder: [],
      hiddenButtonIds: [],
      buttonOrder: {
        [ToolbarGroupId.ColorFont]: [ToolbarButtonId.Italic, ToolbarButtonId.Bold, ToolbarButtonId.Cut, '__nope__'],
        __unknownGroup__: [ToolbarButtonId.Bold],
      },
    })
    // Cut belongs to Clipboard, not the Font group, so it's dropped; unknown ids too.
    expect(normalized.buttonOrder).toEqual({
      [ToolbarGroupId.ColorFont]: [ToolbarButtonId.Italic, ToolbarButtonId.Bold],
    })
  })

  it('clamps groupRows to 1-3 and drops default (1) values', () => {
    const normalized = normalizeToolbarConfig({
      groupOrder: [],
      hiddenButtonIds: [],
      groupRows: {
        [ToolbarGroupId.ParagraphList]: 9, // clamped to 3
        [ToolbarGroupId.BlockStyle]: 0, // clamped to 1 == default -> dropped
        [ToolbarGroupId.ColorFont]: 1, // default -> dropped
        [ToolbarGroupId.Insert]: 2, // kept
        __unknownGroup__: 2, // unknown group -> dropped
      },
    })
    expect(normalized.groupRows).toEqual({
      [ToolbarGroupId.ParagraphList]: 3,
      [ToolbarGroupId.Insert]: 2,
    })
  })

  it('retains horizontalScroll only when explicitly true', () => {
    expect(normalizeToolbarConfig({ groupOrder: [], hiddenButtonIds: [], horizontalScroll: true }).horizontalScroll).toBe(
      true,
    )
    expect('horizontalScroll' in normalizeToolbarConfig({ groupOrder: [], hiddenButtonIds: [], horizontalScroll: false })).toBe(
      false,
    )
  })
})

describe('applyToolbarConfig with new fields', () => {
  it('reorders buttons within a group, appending unlisted defaults', () => {
    const result = applyToolbarConfig({
      groupOrder: [],
      hiddenButtonIds: [],
      buttonOrder: { [ToolbarGroupId.ColorFont]: [ToolbarButtonId.InlineCode, ToolbarButtonId.Bold] },
    })
    const fontGroup = result.find((g) => g.id === ToolbarGroupId.ColorFont)
    expect(fontGroup).toBeDefined()
    const ids = fontGroup!.buttons.map((b) => b.id)
    expect(ids[0]).toBe(ToolbarButtonId.InlineCode)
    expect(ids[1]).toBe(ToolbarButtonId.Bold)
    // All original buttons still present.
    const defaultFontIds = DEFAULT_TOOLBAR_GROUPS.find((g) => g.id === ToolbarGroupId.ColorFont)!.buttons.map(
      (b) => b.id,
    )
    expect(new Set(ids)).toEqual(new Set(defaultFontIds))
  })

  it('keeps every group layout valid: rows are ToolbarButtonId[][] and every non-sentinel id exists in that group buttons', () => {
    for (const group of DEFAULT_TOOLBAR_GROUPS) {
      if (!group.layout) {
        continue
      }
      const ownButtonIds = new Set(group.buttons.map((b) => b.id))
      expect(Array.isArray(group.layout)).toBe(true)
      for (const row of group.layout) {
        expect(Array.isArray(row)).toBe(true)
        for (const id of row) {
          if (isLayoutSentinel(id)) {
            continue
          }
          // Every real id placed in a layout row must be a button of that group.
          expect(ownButtonIds.has(id)).toBe(true)
        }
      }
    }
  })

  it('places Select all on the first Selection-group layout row and Select-all-text on the second', () => {
    const selection = DEFAULT_TOOLBAR_GROUPS.find((g) => g.id === ToolbarGroupId.Selection)
    expect(selection).toBeDefined()
    expect(selection!.layout).toBeDefined()
    const layout = selection!.layout!
    expect(layout[0]).toContain(ToolbarButtonId.SelectAll)
    expect(layout[0]).not.toContain(ToolbarButtonId.SelectAllText)
    expect(layout[1]).toContain(ToolbarButtonId.SelectAllText)
    // The new button is a real descriptor in the group's buttons.
    expect(selection!.buttons.map((b) => b.id)).toContain(ToolbarButtonId.SelectAllText)
  })

  it('exposes per-group rows when overridden and never on the default config', () => {
    const withRows = applyToolbarConfig({
      groupOrder: [],
      hiddenButtonIds: [],
      groupRows: { [ToolbarGroupId.ParagraphList]: 3 },
    })
    expect(withRows.find((g) => g.id === ToolbarGroupId.ParagraphList)?.rows).toBe(3)
    // Default config has no `rows` key on any group.
    const defaults = applyToolbarConfig({ groupOrder: [], hiddenButtonIds: [] })
    expect(defaults.every((g) => !('rows' in g))).toBe(true)
  })
})
