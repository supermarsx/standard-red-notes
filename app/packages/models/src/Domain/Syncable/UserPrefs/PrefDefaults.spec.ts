import { PrefDefaults } from './PrefDefaults'
import { PrefKey } from './PrefKey'

/**
 * The `satisfies { [key in PrefKey]: PrefValue[key] }` guard on `PrefDefaults`
 * already makes a MISSING entry and a WRONG-TYPED value compile errors, so
 * neither is re-tested here. What that guard cannot see is the value itself:
 * `boolean` admits both `true` and `false`, so a settled product default can be
 * flipped without a single gate complaining. The assertions below pin the
 * defaults that were actually decided.
 *
 * The literal strings are pinned for a second, sharper reason. Web consumes
 * `PrefKey`'s RUNTIME value from the generated `snjs` bundle, where a new member
 * is absent until that shared artifact is rebuilt, so each new synced key is
 * additionally pinned web-side as `'x' as PrefKey.X` (the precedent is
 * `todoFilters.ts`'s `TODO_FILTERS_PREF_KEY`). A cast like that is unchecked by
 * construction: renaming a literal here would leave it reading a key that no
 * longer exists, silently falling back to its default forever and looking for
 * all the world like "the setting does nothing". Changing a string below is
 * therefore a storage migration, not a rename.
 */
describe('PrefDefaults', () => {
  it('has a default for every PrefKey member', () => {
    for (const key of Object.values(PrefKey)) {
      expect(Object.keys(PrefDefaults)).toContain(key)
    }
  })

  it('maps no two members onto the same stored key', () => {
    const storedKeys = Object.values(PrefKey)
    expect(new Set(storedKeys).size).toBe(storedKeys.length)
  })

  describe('todo heading hierarchy', () => {
    it('stores under the published literals', () => {
      expect(PrefKey.TodoHeadingLevels).toBe('todoHeadingLevels')
      expect(PrefKey.TodoHeadingDescriptions).toBe('todoHeadingDescriptions')
    })

    it('defaults both ON, so a note written with headings reads as the outline it looks like', () => {
      expect(PrefDefaults[PrefKey.TodoHeadingLevels]).toBe(true)
      expect(PrefDefaults[PrefKey.TodoHeadingDescriptions]).toBe(true)
    })
  })

  describe('note covers', () => {
    it('stores under the published literal', () => {
      expect(PrefKey.NoteCoversEnabled).toBe('noteCoversEnabled')
    })

    it('defaults OFF, because a cover is re-encrypted and re-uploaded with every revision of its note', () => {
      expect(PrefDefaults[PrefKey.NoteCoversEnabled]).toBe(false)
    })
  })

  describe('missed recurrence generation', () => {
    it('stores under the published literals', () => {
      expect(PrefKey.ChecklistAutoGenerateRecurrences).toBe('checklistAutoGenerateRecurrences')
      expect(PrefKey.ChecklistGenerateCap).toBe('checklistGenerateCap')
    })

    it('defaults ON, since silently skipping the occurrences a late completion owed is the defect', () => {
      expect(PrefDefaults[PrefKey.ChecklistAutoGenerateRecurrences]).toBe(true)
    })

    it('defaults to a cap of 12 whole occurrences', () => {
      const cap = PrefDefaults[PrefKey.ChecklistGenerateCap]
      expect(cap).toBe(12)
      // The cap bounds a generation loop, so a non-integer or non-positive
      // default would be a hang or a no-op rather than a cosmetic slip.
      expect(Number.isSafeInteger(cap)).toBe(true)
      expect(cap).toBeGreaterThan(0)
    })
  })
})
