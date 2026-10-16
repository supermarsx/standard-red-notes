import type { WebApplication } from '@/Application/WebApplication'
import { AppPaneId } from '@/Components/Panes/AppPaneMetadata'

export const ASSISTANT_EDITOR_FOCUS_EVENT = 'assistant-editor-focus'
let requested: { accountScope: string; chatId: string } | undefined
export function editorAssistantChatId(application: WebApplication): string | undefined {
  const accountScope = application.sessions.getUser()?.uuid ?? `anonymous:${application.identifier}`
  return requested?.accountScope === accountScope ? requested.chatId : undefined
}
export function openAssistantEditorTab(application: WebApplication, chatId: string): void {
  requested = { accountScope: application.sessions.getUser()?.uuid ?? `anonymous:${application.identifier}`, chatId }
  application.paneController.openPaneTab(AppPaneId.Assistant)
  application.paneController.removePane(AppPaneId.Assistant)
  window.dispatchEvent(new Event(ASSISTANT_EDITOR_FOCUS_EVENT))
}
