import { TOGGLE_LIST_PANE_KEYBOARD_COMMAND, TOGGLE_NAVIGATION_PANE_KEYBOARD_COMMAND } from '@standardnotes/ui-services'
import { useMemo } from 'react'
import { observer } from 'mobx-react-lite'
import { useResponsiveAppPane } from '../Panes/ResponsivePaneProvider'
import { useKeyboardService } from '../KeyboardServiceProvider'
import MenuSwitchButtonItem from '../Menu/MenuSwitchButtonItem'
import { useLocalPreference } from '@/Hooks/usePreference'
import { NAVIGATION_PANE_MINI_PREF_KEY } from '../Tags/navigationMini'

const PanelSettingsSection = () => {
  const { isListPaneCollapsed, isNavigationPaneCollapsed, toggleListPane, toggleNavigationPane } =
    useResponsiveAppPane()

  /**
   * Standard Red Notes: the tags panel can render as a narrow rail of icons.
   * Device-local and default OFF, like the two collapse states above it.
   *
   * Read straight from the preference rather than through the pane controller:
   * mini is a rendering mode inside the Navigation pane, not a fourth pane
   * state, so nothing about the pane stack has to know about it.
   */
  const [isNavigationPaneMini, setNavigationPaneMini] = useLocalPreference(NAVIGATION_PANE_MINI_PREF_KEY)

  const keyboardService = useKeyboardService()

  const navigationShortcut = useMemo(
    () => keyboardService.keyboardShortcutForCommand(TOGGLE_NAVIGATION_PANE_KEYBOARD_COMMAND),
    [keyboardService],
  )

  const listShortcut = useMemo(
    () => keyboardService.keyboardShortcutForCommand(TOGGLE_LIST_PANE_KEYBOARD_COMMAND),
    [keyboardService],
  )

  return (
    <div className="pointer-coarse:md-only:hidden pointer-coarse:lg-only:hidden hidden md:block">
      <MenuSwitchButtonItem
        className="items-center"
        checked={!isNavigationPaneCollapsed}
        onChange={toggleNavigationPane}
        shortcut={navigationShortcut}
      >
        Show Tags Panel
      </MenuSwitchButtonItem>
      <MenuSwitchButtonItem
        className="items-center"
        checked={isNavigationPaneMini === true}
        disabled={isNavigationPaneCollapsed}
        title={
          isNavigationPaneCollapsed
            ? 'Show the tags panel first — there is nothing to shrink while it is hidden.'
            : 'Shrink the tags panel to a rail of icons. Each icon keeps its name as a tooltip.'
        }
        onChange={(checked) => setNavigationPaneMini(checked)}
      >
        Mini Tags Panel
      </MenuSwitchButtonItem>
      <MenuSwitchButtonItem
        className="items-center"
        checked={!isListPaneCollapsed}
        onChange={toggleListPane}
        shortcut={listShortcut}
      >
        Show Notes Panel
      </MenuSwitchButtonItem>
    </div>
  )
}
export default observer(PanelSettingsSection)
