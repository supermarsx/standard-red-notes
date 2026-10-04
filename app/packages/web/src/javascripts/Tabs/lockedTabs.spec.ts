import type { LocalPrefKey, LocalPrefValue, PreferenceServiceInterface } from '@standardnotes/snjs'
import {
  LOCKED_EDITOR_TABS_PREF_KEY,
  MAX_LOCKED_TAB_UUIDS,
  normalizeLockedTabUuids,
  readLockedTabUuids,
  takeoverTabIndex,
  writeLockedTabUuids,
} from './lockedTabs'

/** A stand-in for the device-local preference store, keyed exactly as the real one is. */
const makeStore = (initial?: Record<string, unknown>) => {
  const values = new Map<string, unknown>(Object.entries(initial ?? {}))
  const preferences = {
    getLocalValue: ((key: LocalPrefKey, defaultValue?: unknown) =>
      values.has(key as unknown as string)
        ? values.get(key as unknown as string)
        : defaultValue) as PreferenceServiceInterface['getLocalValue'],
    setLocalValue: ((key: LocalPrefKey, value: LocalPrefValue[LocalPrefKey]) => {
      values.set(key as unknown as string, value)
    }) as PreferenceServiceInterface['setLocalValue'],
  }
  return { preferences, values }
}

describe('locked editor tabs — the takeover rule', () => {
  const locked = (...uuids: string[]) => new Set(uuids)

  it('hands the active tab over when it is not locked', () => {
    expect(takeoverTabIndex(['a', 'b', 'c'], 1, locked())).toBe(1)
    expect(takeoverTabIndex(['a', 'b', 'c'], 1, locked('a', 'c'))).toBe(1)
  })

  it('redirects to the nearest unlocked tab to the RIGHT when the active tab is locked', () => {
    expect(takeoverTabIndex(['a', 'b', 'c'], 0, locked('a'))).toBe(1)
    expect(takeoverTabIndex(['a', 'b', 'c'], 0, locked('a', 'b'))).toBe(2)
  })

  it('wraps around to the left when nothing to the right is unlocked', () => {
    expect(takeoverTabIndex(['a', 'b', 'c'], 2, locked('c'))).toBe(0)
    expect(takeoverTabIndex(['a', 'b', 'c'], 1, locked('b', 'c'))).toBe(0)
  })

  it('asks for a brand new tab when EVERY open tab is locked', () => {
    expect(takeoverTabIndex(['a', 'b', 'c'], 1, locked('a', 'b', 'c'))).toBeUndefined()
    // The single-tab case: the one open tab is locked, so the note cannot land in it.
    expect(takeoverTabIndex(['a'], 0, locked('a'))).toBeUndefined()
  })

  it('asks for a brand new tab when nothing is open', () => {
    expect(takeoverTabIndex([], -1, locked())).toBeUndefined()
    expect(takeoverTabIndex([], 0, locked())).toBeUndefined()
  })

  it('treats a tab with no item uuid (an unsaved template) as always eligible', () => {
    expect(takeoverTabIndex([undefined], 0, locked())).toBe(0)
    expect(takeoverTabIndex(['a', undefined], 0, locked('a'))).toBe(1)
  })
})

describe('locked editor tabs — persistence', () => {
  it('stores the uuids under the pinned device-local key', () => {
    const { preferences, values } = makeStore()

    writeLockedTabUuids(preferences, ['uuid-a', 'uuid-b'])

    /**
     * The literal matters, not just the round-trip: this is the pinned string that
     * stands in for `LocalPrefKey.LockedEditorTabs` until snjs is rebuilt. Reading
     * through an enum member that is absent from the generated bundle resolves
     * `undefined`, which would make the setting silently unreadable forever.
     */
    expect(LOCKED_EDITOR_TABS_PREF_KEY as unknown as string).toBe('lockedEditorTabs')
    expect(values.get('lockedEditorTabs')).toEqual(['uuid-a', 'uuid-b'])
  })

  it('reads back what was written, which is what surviving a reload means', () => {
    const { preferences } = makeStore()

    writeLockedTabUuids(preferences, new Set(['uuid-a', 'uuid-b']))

    expect([...readLockedTabUuids(preferences)]).toEqual(['uuid-a', 'uuid-b'])
  })

  it('reads nothing locked from an empty store', () => {
    expect([...readLockedTabUuids(makeStore().preferences)]).toEqual([])
  })

  it('reads nothing locked when the preference service cannot be read at all', () => {
    // The real service only populates local preferences at a later launch stage,
    // and several specs construct consumers with `{} as PreferenceServiceInterface`.
    expect([...readLockedTabUuids(undefined)]).toEqual([])
    expect([...readLockedTabUuids({})]).toEqual([])
    expect([
      ...readLockedTabUuids({
        getLocalValue: (() => {
          throw new Error('storage unavailable')
        }) as unknown as PreferenceServiceInterface['getLocalValue'],
      }),
    ]).toEqual([])
  })

  it('discards a stored value that is not a list of uuids', () => {
    for (const malformed of ['uuid-a', 42, null, { 'uuid-a': true }, [1, 2], ['', '  ']]) {
      expect([...readLockedTabUuids(makeStore({ lockedEditorTabs: malformed }).preferences)]).toEqual([])
    }
  })

  it('keeps the valid uuids out of a partly malformed stored list', () => {
    expect([...readLockedTabUuids(makeStore({ lockedEditorTabs: ['uuid-a', 7, null, 'uuid-b'] }).preferences)]).toEqual(
      ['uuid-a', 'uuid-b'],
    )
  })

  it('collapses duplicates and caps the stored list', () => {
    expect(normalizeLockedTabUuids(['uuid-a', 'uuid-a', 'uuid-b'])).toEqual(['uuid-a', 'uuid-b'])

    const tooMany = Array.from({ length: MAX_LOCKED_TAB_UUIDS + 5 }, (_value, index) => `uuid-${index}`)
    const capped = normalizeLockedTabUuids(tooMany)
    expect(capped).toHaveLength(MAX_LOCKED_TAB_UUIDS)
    // The newest locks are the ones a user still cares about, so the oldest go.
    expect(capped[capped.length - 1]).toBe(`uuid-${MAX_LOCKED_TAB_UUIDS + 4}`)
    expect(capped).not.toContain('uuid-0')
  })
})
