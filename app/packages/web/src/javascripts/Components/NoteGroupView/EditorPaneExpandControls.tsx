import { observer } from 'mobx-react-lite'
import { useResponsiveAppPane } from '../Panes/ResponsivePaneProvider'
import PaneCollapseButton from '../Panes/PaneCollapseButton'

/**
 * A thin desktop-only (md+) rail rendered at the top-left of the editor pane that
 * surfaces expand affordances for any collapsed layout pane. This guarantees there
 * is always a way to bring a collapsed pane back even when both the navigation
 * sidebar and the notes list are hidden (editor-only layout), since the editor is
 * always present on desktop. Renders nothing when both panes are expanded.
 */
const EditorPaneExpandControls = () => {
  const { isNavigationPaneCollapsed, isListPaneCollapsed, toggleNavigationPane, toggleListPane } =
    useResponsiveAppPane()

  if (!isNavigationPaneCollapsed && !isListPaneCollapsed) {
    return null
  }

  return (
    <div className="hidden flex-shrink-0 items-center gap-1 border-b border-border bg-default px-2 py-1 md:flex">
      {isNavigationPaneCollapsed && (
        <PaneCollapseButton
          onClick={toggleNavigationPane}
          label="Expand tags panel"
          icon="menu-variant"
          expanded={false}
        />
      )}
      {isListPaneCollapsed && (
        <PaneCollapseButton
          onClick={toggleListPane}
          label="Expand notes panel"
          icon="chevron-right"
          expanded={false}
        />
      )}
    </div>
  )
}

export default observer(EditorPaneExpandControls)
