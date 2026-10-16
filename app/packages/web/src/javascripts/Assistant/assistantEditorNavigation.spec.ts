/** @jest-environment jsdom */
import {
  editorAssistantChatId,
  openAssistantEditorTab,
  ASSISTANT_EDITOR_FOCUS_EVENT,
} from './assistantEditorNavigation'
import type { WebApplication } from '@/Application/WebApplication'
import { AppPaneId } from '@/Components/Panes/AppPaneMetadata'

it('opens the selected conversation in the editor and keeps focus requests scoped to its account', () => {
  let user = 'one'
  const openPaneTab = jest.fn()
  const removePane = jest.fn()
  const focus = jest.fn()
  const application = {
    identifier: 'app',
    sessions: { getUser: () => ({ uuid: user }) },
    paneController: { openPaneTab, removePane },
  } as unknown as WebApplication
  window.addEventListener(ASSISTANT_EDITOR_FOCUS_EVENT, focus)
  try {
    openAssistantEditorTab(application, 'conversation-a')
    expect(openPaneTab).toHaveBeenCalledWith(AppPaneId.Assistant)
    expect(removePane).toHaveBeenCalledWith(AppPaneId.Assistant)
    expect(editorAssistantChatId(application)).toBe('conversation-a')
    openAssistantEditorTab(application, 'conversation-b')
    expect(editorAssistantChatId(application)).toBe('conversation-b')
    expect(focus).toHaveBeenCalledTimes(2)
    user = 'two'
    expect(editorAssistantChatId(application)).toBeUndefined()
  } finally {
    window.removeEventListener(ASSISTANT_EDITOR_FOCUS_EVENT, focus)
  }
})
