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
})
