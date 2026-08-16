import { AppPaneId } from '../../Components/Panes/AppPaneMetadata'

export const ASSISTANT_PANEL_MIN_WIDTH = 300
export const ASSISTANT_PANEL_DEFAULT_WIDTH = 400
export const ASSISTANT_PANEL_MAX_WIDTH = 900
const MINIMUM_MAIN_PANE_WIDTH = 400

/**
 * Desktop treats the assistant as a docked utility pane rather than a transient
 * navigation step. Keep exactly one copy at the far right while it is open.
 */
export function dockAssistantPaneToRight(panes: AppPaneId[], assistantWasOpen: boolean): AppPaneId[] {
  const shouldKeepAssistant = assistantWasOpen || panes.includes(AppPaneId.Assistant)
  const panesWithoutAssistant = panes.filter((pane) => pane !== AppPaneId.Assistant)

  return shouldKeepAssistant ? [...panesWithoutAssistant, AppPaneId.Assistant] : panesWithoutAssistant
}

/** Adds or focuses a normal pane without putting it after an open assistant. */
export function presentPaneBeforeDockedAssistant(panes: AppPaneId[], pane: AppPaneId): AppPaneId[] {
  const panesWithoutAssistant = panes.filter((candidate) => candidate !== AppPaneId.Assistant)

  if (pane !== AppPaneId.Assistant && !panesWithoutAssistant.includes(pane)) {
    panesWithoutAssistant.push(pane)
  }

  return [...panesWithoutAssistant, AppPaneId.Assistant]
}

/** Inserts a pane without allowing it to land to the right of the assistant. */
export function insertPaneBeforeDockedAssistant(panes: AppPaneId[], pane: AppPaneId, index: number): AppPaneId[] {
  const panesWithoutAssistant = panes.filter((candidate) => candidate !== AppPaneId.Assistant && candidate !== pane)
  const insertionIndex = Math.max(0, Math.min(index, panesWithoutAssistant.length))

  if (pane === AppPaneId.Assistant) {
    return [...panesWithoutAssistant, AppPaneId.Assistant]
  }

  return [
    ...panesWithoutAssistant.slice(0, insertionIndex),
    pane,
    ...panesWithoutAssistant.slice(insertionIndex),
    AppPaneId.Assistant,
  ]
}

export function maximumAssistantPanelWidth(viewportWidth: number, occupiedSidePaneWidth = 0): number {
  return Math.max(
    ASSISTANT_PANEL_MIN_WIDTH,
    Math.min(ASSISTANT_PANEL_MAX_WIDTH, viewportWidth - Math.max(0, occupiedSidePaneWidth) - MINIMUM_MAIN_PANE_WIDTH),
  )
}

export function clampAssistantPanelWidth(width: number, viewportWidth: number, occupiedSidePaneWidth = 0): number {
  return Math.max(
    ASSISTANT_PANEL_MIN_WIDTH,
    Math.min(width, maximumAssistantPanelWidth(viewportWidth, occupiedSidePaneWidth)),
  )
}
