import { VectorIconNameOrEmoji } from '@standardnotes/snjs'
import { AppPaneId } from '@/Components/Panes/AppPaneMetadata'

/**
 * Standard Red Notes: a view tab is a full-column "pane" view (Home, Dashboard,
 * Reminders, Todos, Research) surfaced as a TAB in the editor tab bar instead of
 * taking over the whole window as a column. The `id` is the pane id string so a
 * given pane can only have a single tab open at once.
 */
export type ViewTab = {
  id: string
  kind: 'pane'
  paneId: AppPaneId
  title: string
  icon: VectorIconNameOrEmoji
}

/**
 * The panes that are surfaced as tabs. Each entry's icon matches the icon that
 * pane's sidebar SectionButton already uses.
 */
export const TABBABLE_PANES: { paneId: AppPaneId; title: string; icon: VectorIconNameOrEmoji }[] = [
  { paneId: AppPaneId.Home, title: 'Home', icon: 'window' },
  { paneId: AppPaneId.Dashboard, title: 'Dashboard', icon: 'dashboard' },
  { paneId: AppPaneId.Reminders, title: 'Reminders', icon: 'clock' },
  { paneId: AppPaneId.Todos, title: 'Todos', icon: 'list-check' },
  { paneId: AppPaneId.Research, title: 'Research', icon: 'toc' },
  { paneId: AppPaneId.Bookmarks, title: 'Bookmarks', icon: 'pin' },
]
