import { ElementIds } from '@/Constants/ElementIDs'

export enum AppPaneId {
  Navigation = 'NavigationColumn',
  Items = 'ItemsColumn',
  Editor = 'EditorColumn',
  Assistant = 'AssistantColumn',
  Constellation = 'ConstellationColumn',
  Dashboard = 'DashboardColumn',
}

export const AppPaneIdToDivId = {
  [AppPaneId.Navigation]: ElementIds.NavigationColumn,
  [AppPaneId.Items]: ElementIds.ItemsColumn,
  [AppPaneId.Editor]: ElementIds.EditorColumn,
  [AppPaneId.Assistant]: ElementIds.AssistantColumn,
  [AppPaneId.Constellation]: ElementIds.ConstellationColumn,
  [AppPaneId.Dashboard]: ElementIds.DashboardColumn,
}
