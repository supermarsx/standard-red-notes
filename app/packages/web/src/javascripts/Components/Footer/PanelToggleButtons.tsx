import { observer } from 'mobx-react-lite'
import { useTranslation } from 'react-i18next'
import { useResponsiveAppPane } from '../Panes/ResponsivePaneProvider'
import PaneCollapseButton from '../Panes/PaneCollapseButton'

/**
 * The topics-panel and notes-panel collapse/expand toggles, rendered as a pair
 * of small icon buttons inside the footer bar.
 *
 * These used to be scattered across three top bars (the navigation sidebar
 * header, the content-list header, and a rail above the editor). They now live
 * in the footer so no panel chrome sits above the content the user is reading,
 * and so both toggles are always in the same, predictable place.
 *
 * Both buttons are rendered unconditionally so the pair never shifts position
 * as panes collapse; instead each button's icon, tooltip and accessible name
 * describe the action it will perform *right now* ("Collapse notes panel" when
 * the pane is open, "Expand notes panel" when it is collapsed), with
 * `aria-expanded` on top of that via PaneCollapseButton.
 *
 * Like PaneCollapseButton itself — and like the footer that hosts it — this is
 * md+ only. Below md the layout is single-pane and there is nothing to collapse.
 */
const PanelToggleButtons = () => {
  const { t: tNavigation } = useTranslation('navigation')
  const { t: tNotes } = useTranslation('notes')

  const { isNavigationPaneCollapsed, isListPaneCollapsed, toggleNavigationPane, toggleListPane } =
    useResponsiveAppPane()

  return (
    <div className="flex items-center gap-1" data-testid="footer-panel-toggles">
      <PaneCollapseButton
        onClick={toggleNavigationPane}
        label={isNavigationPaneCollapsed ? tNavigation('expandTagsPanel') : tNavigation('collapseTagsPanel')}
        icon={isNavigationPaneCollapsed ? 'menu-variant' : 'menu-close'}
        expanded={!isNavigationPaneCollapsed}
      />
      <PaneCollapseButton
        onClick={toggleListPane}
        label={isListPaneCollapsed ? tNotes('expandNotesPanel') : tNotes('collapseNotesPanel')}
        icon={isListPaneCollapsed ? 'chevron-right' : 'chevron-left'}
        expanded={!isListPaneCollapsed}
      />
    </div>
  )
}

export default observer(PanelToggleButtons)
