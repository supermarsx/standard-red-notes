import { AppPaneId } from '@/Components/Panes/AppPaneMetadata'
import { TABBABLE_PANES, ViewTab } from '@/Controllers/PaneController/ViewTab'

export const WORKSPACE_STATE_KEY = 'WorkspaceStartupState'
export const STARTUP_BEHAVIOR_KEY = 'WorkspaceStartupBehavior'
export const STARTUP_VIEW_KEY = 'WorkspaceStartupView'
export type StartupBehavior = 'resume' | 'new-note' | 'view'
export type WorkspaceItem = { uuid: string; kind: 'note' | 'file' }
export type WorkspaceState = {
  version: 1
  owner: string
  items: WorkspaceItem[]
  views: ViewTab[]
  activeItemUuid?: string
  activeViewId?: string
}

export function startupBehavior(value: unknown): StartupBehavior {
  return value === 'new-note' || value === 'view' ? value : 'resume'
}

export function startupView(value: unknown): AppPaneId {
  return TABBABLE_PANES.find((pane) => pane.paneId === value)?.paneId ?? AppPaneId.Home
}

/** Local resume metadata contains identifiers, never note text or stored titles. */
export function readWorkspaceState(value: unknown, owner: string): WorkspaceState | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const input = value as Partial<WorkspaceState>
  if (input.version !== 1 || input.owner !== owner || !Array.isArray(input.items) || !Array.isArray(input.views)) {
    return undefined
  }
  const items: WorkspaceItem[] = []
  const seen = new Set<string>()
  for (const item of input.items) {
    if (!item || typeof item.uuid !== 'string' || item.uuid.length > 128 || !item.uuid) {
      continue
    }
    if ((item.kind === 'note' || item.kind === 'file') && !seen.has(item.uuid)) {
      seen.add(item.uuid)
      items.push({ uuid: item.uuid, kind: item.kind })
    }
  }
  const views: ViewTab[] = []
  const viewIds = new Set<string>()
  for (const view of input.views) {
    if (!view || typeof view !== 'object') {
      continue
    }
    let tab: ViewTab | undefined
    if (view.kind === 'pane') {
      const pane = TABBABLE_PANES.find((entry) => entry.paneId === view.paneId)
      if (pane) {
        tab = { ...pane, id: pane.paneId, kind: 'pane' }
      }
    } else if (view.kind === 'empty' && /^empty:\d+$/.test(view.id) && Number.isSafeInteger(Number(view.id.slice(6)))) {
      tab = { id: view.id, kind: 'empty', title: 'New tab', icon: 'add' }
    } else if (view.kind === 'conflict' && typeof view.noteUuid === 'string' && view.noteUuid.length <= 128) {
      tab = {
        id: `conflict:${view.noteUuid}`,
        noteUuid: view.noteUuid,
        kind: 'conflict',
        title: 'Conflicts',
        icon: 'merge',
      }
    }
    if (tab && !viewIds.has(tab.id)) {
      viewIds.add(tab.id)
      views.push(tab)
    }
  }
  return {
    version: 1,
    owner,
    items,
    views,
    activeItemUuid:
      typeof input.activeItemUuid === 'string' && seen.has(input.activeItemUuid) ? input.activeItemUuid : undefined,
    activeViewId:
      typeof input.activeViewId === 'string' && viewIds.has(input.activeViewId) ? input.activeViewId : undefined,
  }
}

export function serializeWorkspaceState(state: WorkspaceState): object {
  return {
    ...state,
    views: state.views.map((view) => {
      return view.kind === 'pane'
        ? { kind: view.kind, paneId: view.paneId }
        : view.kind === 'conflict'
          ? { kind: view.kind, noteUuid: view.noteUuid }
          : { kind: view.kind, id: view.id }
    }),
  }
}
