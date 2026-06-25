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
import {
  applyToolbarConfig,
  DEFAULT_TOOLBAR_GROUPS,
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
      hiddenButtonIds: [ToolbarButtonId.BlockStyle], // BlockStyle group has a single button
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
        [ToolbarGroupId.TextStyle]: 0, // clamped to 1 == default -> dropped
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
      buttonOrder: { [ToolbarGroupId.TextStyle]: [ToolbarButtonId.Link, ToolbarButtonId.InlineCode] },
    })
    const textGroup = result.find((g) => g.id === ToolbarGroupId.TextStyle)
    expect(textGroup).toBeDefined()
    const ids = textGroup!.buttons.map((b) => b.id)
    expect(ids[0]).toBe(ToolbarButtonId.Link)
    expect(ids[1]).toBe(ToolbarButtonId.InlineCode)
    // All original buttons still present.
    const defaultTextIds = DEFAULT_TOOLBAR_GROUPS.find((g) => g.id === ToolbarGroupId.TextStyle)!.buttons.map(
      (b) => b.id,
    )
    expect(new Set(ids)).toEqual(new Set(defaultTextIds))
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
