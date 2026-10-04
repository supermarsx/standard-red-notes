import { FunctionComponent, useCallback } from 'react'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import Switch from '@/Components/Switch/Switch'
import { useLocalPreference } from '@/Hooks/usePreference'
import { NAVIGATION_MINI_RAIL_WIDTH, NAVIGATION_PANE_MINI_PREF_KEY } from '@/Components/Tags/navigationMini'
import PreferencesGroup from '../../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../../PreferencesComponents/PreferencesSegment'

/**
 * Standard Red Notes: the "Mini tags panel" setting (t111 §3 row 3).
 *
 * A MIRROR, NOT A SECOND SETTING. The same switch already exists in the quick
 * settings menu (`Components/QuickSettingsMenu/PanelSettingsSection.tsx`), which
 * is where someone changes it in passing. This one exists because a setting that
 * lives only inside a transient popover is not findable: a user who remembers
 * "there was a narrow-sidebar option" looks in Preferences.
 *
 * Both surfaces go through `useLocalPreference(NAVIGATION_PANE_MINI_PREF_KEY)` —
 * the same hook, the same imported key constant, the same device-local store — so
 * there is exactly one stored value and flipping either control moves the other.
 * Nothing here keeps a copy of the state.
 *
 * `=== true` rather than a truthiness test, deliberately: the key is pinned as a
 * literal because `LocalPrefKey.NavigationPaneMini` is absent from the generated
 * snjs bundle until it is rebuilt, and `LocalPrefDefaults` has no entry for it
 * either, so the hook's default arrives as `undefined`. Undefined must mean OFF
 * (which it is — the shipped default), not "missing".
 */
const SidebarMini: FunctionComponent = () => {
  const [isNavigationPaneMini, setNavigationPaneMini] = useLocalPreference(NAVIGATION_PANE_MINI_PREF_KEY)

  const toggleMini = useCallback(
    (checked: boolean) => {
      setNavigationPaneMini(checked)
    },
    [setNavigationPaneMini],
  )

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>Tags panel</Title>
        <div className="mt-2" data-test="sidebar-mini-setting">
          <div className="flex justify-between gap-2 md:items-center">
            <div className="flex flex-col">
              <Subtitle>Mini tags panel</Subtitle>
              <Text>
                Shrink the tags panel to a {NAVIGATION_MINI_RAIL_WIDTH}px rail of icons. Each icon keeps its name as a
                tooltip and in the accessibility tree, so nothing becomes unreadable — only narrower.
              </Text>
            </div>
            <Switch onChange={toggleMini} checked={isNavigationPaneMini === true} />
          </div>
          <Text className="text-passive-0 mt-2">
            Applies while the tags panel is showing, on desktop-width windows. It is the same switch as "Mini Tags
            Panel" in the quick settings menu, and this device remembers it on its own — it is not synced to your other
            devices.
          </Text>
        </div>
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default SidebarMini
