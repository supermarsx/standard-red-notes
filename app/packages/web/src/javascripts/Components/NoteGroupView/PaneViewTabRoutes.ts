import type { ComponentType } from 'react'
import { WebApplication } from '@/Application/WebApplication'
import { AppPaneId } from '../Panes/AppPaneMetadata'
import HomeView from '../Home/HomeView'
import DashboardView from '../Dashboard/DashboardView'
import RemindersView from '../RemindersAggregate/RemindersView'
import CalendarAggregateView from '../CalendarAggregate/CalendarAggregateView'
import TodoView from '../TodoAggregate/TodoView'
import ResearchView from '../Research/ResearchView'
import BookmarksView from '../Bookmarks/BookmarksView'
import TemplatesView from '../Templates/TemplatesView'
import ConstellationView from '../Constellation/ConstellationView'
import NotificationsView from '../Notifications/NotificationsView'
import FilesView from '../FilesView/FilesView'
import WorkflowsView from '../Workflows/WorkflowsView'

export type PaneViewTabProps = {
  application: WebApplication
  className?: string
  id: string
}

/**
 * First-class routes rendered inside the editor tab surface. Keeping this map
 * beside NoteGroupView prevents a pane from being declared tabbable without a
 * corresponding content route.
 */
export const PANE_VIEW_TAB_ROUTES: Partial<Record<AppPaneId, ComponentType<PaneViewTabProps>>> = {
  [AppPaneId.Home]: HomeView,
  [AppPaneId.Dashboard]: DashboardView,
  [AppPaneId.Reminders]: RemindersView,
  [AppPaneId.Calendar]: CalendarAggregateView,
  [AppPaneId.Todos]: TodoView,
  [AppPaneId.Research]: ResearchView,
  [AppPaneId.Bookmarks]: BookmarksView,
  [AppPaneId.Templates]: TemplatesView,
  [AppPaneId.Constellation]: ConstellationView,
  [AppPaneId.Notifications]: NotificationsView,
  [AppPaneId.Files]: FilesView,
  [AppPaneId.Workflows]: WorkflowsView,
}
