import { LocalPrefDefaults, LocalPrefKey } from './LocalPrefKey'

/**
 * `LocalPrefDefaults` carries the same
 * `satisfies { [key in LocalPrefKey]: LocalPrefValue[key] }` guard as the synced
 * table, so a missing entry and a wrong-typed value are both compile errors and
 * neither is re-tested here. These assertions cover what the type cannot: the
 * chosen value, and the stored key string itself — which is what persisted
 * device-local data is actually keyed by, so changing one strands every value
 * already written under the old spelling.
 */
describe('LocalPrefDefaults', () => {
  it('has a default for every LocalPrefKey member', () => {
    for (const key of Object.values(LocalPrefKey)) {
      expect(Object.keys(LocalPrefDefaults)).toContain(key)
    }
  })

  it('maps no two members onto the same stored key', () => {
    const storedKeys = Object.values(LocalPrefKey)
    expect(new Set(storedKeys).size).toBe(storedKeys.length)
  })

  describe('navigation pane mini mode', () => {
    it('stores under the published literal', () => {
      expect(LocalPrefKey.NavigationPaneMini).toBe('navigationPaneMini')
    })

    it('defaults OFF, so the shipped layout is the full labelled sidebar', () => {
      expect(LocalPrefDefaults[LocalPrefKey.NavigationPaneMini]).toBe(false)
    })

    it('is a state distinct from collapsed, which still means absent', () => {
      expect(LocalPrefKey.NavigationPaneMini).not.toBe(LocalPrefKey.NavigationPaneCollapsed)
      expect(LocalPrefDefaults[LocalPrefKey.NavigationPaneCollapsed]).toBe(false)
    })
  })
})
