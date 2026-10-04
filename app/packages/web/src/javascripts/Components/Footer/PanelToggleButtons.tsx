import { observer } from 'mobx-react-lite'
import { useTranslation } from 'react-i18next'
import { useResponsiveAppPane } from '../Panes/ResponsivePaneProvider'
import PaneCollapseButton from '../Panes/PaneCollapseButton'
import { sidebarPaneStatus, SidebarPaneStatus } from '@/Controllers/PaneController/sidebarPaneState'

/**
 * Why these two strings are not i18n keys like the four around them: the
 * `navigation` and `notes` namespaces are typed from the English base, so every
 * locale must carry the same keys, and `LOCALE_RESOURCES` would stop compiling
 * until all sixteen were edited. Focus mode's own command label is hardcoded for
 * the same reason (`PaneController`, 'Toggle focus mode'). Stated here rather
 * than left to be rediscovered.
 */
const TAGS_PANEL_HIDDEN_BY_FOCUS_MODE = 'Topics panel is hidden in focus mode'
const NOTES_PANEL_HIDDEN_BY_FOCUS_MODE = 'Notes panel is hidden in focus mode'

/**
 * The topics-panel and notes-panel collapse/expand toggles, rendered as a pair
 * of small icon buttons inside the footer bar.
 *
 * These used to be scattered across three top bars (the navigation sidebar
 * header, the content-list header, and a rail above the editor). They now live
 * in the footer so no panel chrome sits above the content the user is reading,
 * and so both toggles are always in the same, predictable place.
 *
 * The request was for "floating icons", and they are deliberately NOT floated:
 * the footer is a normal in-flow element, so these buttons structurally cannot
 * overlay the editor. This app already shipped, and had to revert, one control
 * that covered the note being edited — an absolutely-positioned variant would
 * reintroduce exactly that. The intent behind "floating" (get them off the top
 * bars, keep them small and unobtrusive) is met without the overlay risk.
 *
 * Both buttons are rendered unconditionally so the pair never shifts position
 * as panes collapse; instead each button's icon, tooltip and accessible name
 * describe the action it will perform *right now* ("Collapse notes panel" when
 * the pane is open, "Expand notes panel" when it is collapsed), with
 * `aria-expanded` on top of that via PaneCollapseButton.
 *
 * Like PaneCollapseButton itself — and like the footer that hosts it — this is
 * md+ only. Below md the layout is single-pane and there is nothing to collapse.
 *
 * FOCUS MODE. Each button describes its pane's STATUS, not merely whether the
 * pane is in the pane stack. Focus mode leaves both sidebars in the stack and
 * zeroes their grid columns (`_focused.scss` then forces `width: 0 !important`),
 * while the footer stays on screen at 8% opacity and full opacity on hover. So
 * these toggles used to sit over invisible panes claiming `aria-expanded="true"`,
 * and a click there silently rewrote the remembered collapse state with no
 * observable effect — the sidebar the user never collapsed was then missing the
 * next time they left focus mode. They are marked unavailable instead, with the
 * reason as their accessible name, and the remembered state is left alone.
 */
const PanelToggleButtons = () => {
  const { t: tNavigation } = useTranslation('navigation')
  const { t: tNotes } = useTranslation('notes')

  const { isNavigationPaneCollapsed, isListPaneCollapsed, toggleNavigationPane, toggleListPane, focusModeEnabled } =
    useResponsiveAppPane()

  const navigationStatus = sidebarPaneStatus({
    present: !isNavigationPaneCollapsed,
    focusModeEnabled: focusModeEnabled === true,
  })
  const listStatus = sidebarPaneStatus({ present: !isListPaneCollapsed, focusModeEnabled: focusModeEnabled === true })

  const navigationHidden = navigationStatus !== SidebarPaneStatus.Visible
  const listHidden = listStatus !== SidebarPaneStatus.Visible

  const labelFor = (status: SidebarPaneStatus, expand: string, collapse: string, hiddenByFocusMode: string): string => {
    switch (status) {
      case SidebarPaneStatus.HiddenByFocusMode:
        return hiddenByFocusMode
      case SidebarPaneStatus.Collapsed:
        return expand
      default:
        return collapse
    }
  }

  return (
    <div className="flex items-center gap-1" data-testid="footer-panel-toggles">
      <PaneCollapseButton
        onClick={toggleNavigationPane}
        label={labelFor(
          navigationStatus,
          tNavigation('expandTagsPanel'),
          tNavigation('collapseTagsPanel'),
          TAGS_PANEL_HIDDEN_BY_FOCUS_MODE,
        )}
        icon={navigationHidden ? 'menu-variant' : 'menu-close'}
        expanded={!navigationHidden}
        unavailable={navigationStatus === SidebarPaneStatus.HiddenByFocusMode}
      />
      <PaneCollapseButton
        onClick={toggleListPane}
        label={labelFor(
          listStatus,
          tNotes('expandNotesPanel'),
          tNotes('collapseNotesPanel'),
          NOTES_PANEL_HIDDEN_BY_FOCUS_MODE,
        )}
        icon={listHidden ? 'chevron-right' : 'chevron-left'}
        expanded={!listHidden}
        unavailable={listStatus === SidebarPaneStatus.HiddenByFocusMode}
      />
    </div>
  )
}

export default observer(PanelToggleButtons)
