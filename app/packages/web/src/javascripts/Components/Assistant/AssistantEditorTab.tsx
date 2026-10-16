import type { PaneViewTabProps } from '../NoteGroupView/PaneViewTabRoutes'
import AssistantView from './AssistantView'
import { useEffect, useState } from 'react'
import { ASSISTANT_EDITOR_FOCUS_EVENT, editorAssistantChatId } from '@/Assistant/assistantEditorNavigation'

export default function AssistantEditorTab(props: PaneViewTabProps) {
  const [request, setRequest] = useState(() => ({ chatId: editorAssistantChatId(props.application), revision: 0 }))
  useEffect(() => {
    const focus = () =>
      setRequest((current) => ({ chatId: editorAssistantChatId(props.application), revision: current.revision + 1 }))
    window.addEventListener(ASSISTANT_EDITOR_FOCUS_EVENT, focus)
    return () => window.removeEventListener(ASSISTANT_EDITOR_FOCUS_EVENT, focus)
  }, [props.application])
  return <AssistantView {...props} editorTab focusChatId={request.chatId} focusRequestRevision={request.revision} />
}
