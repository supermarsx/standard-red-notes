import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { PrefKey } from '@standardnotes/snjs'
import { confirmDialog } from '@standardnotes/ui-services'
import { classNames } from '@standardnotes/utils'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import Button from '@/Components/Button/Button'
import { useResponsiveAppPane } from '../Panes/ResponsivePaneProvider'
import { AppPaneId } from '../Panes/AppPaneMetadata'
import { ChatMessage as AgentChatMessage } from '@/Assistant/types'
import { run } from '@/Assistant/agent'
import { ProxyProvider } from '@/Assistant/ProxyProvider'
import { DirectProvider } from '@/Assistant/DirectProvider'
import { Provider } from '@/Assistant/types'
import { AssistantTools } from '@/Assistant/tools'
import { ASSISTANT_SYSTEM_PROMPT } from '@/Assistant/prompts'

type ToolEntry = {
  id: string
  name: string
  args: unknown
  result?: string
  isError?: boolean
}

type UIMessage =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; tools: ToolEntry[]; streaming?: boolean }
  | { kind: 'error'; id: string; text: string }

type Props = {
  application: WebApplication
  className?: string
  id: string
  /** When true the view is rendered as a standalone popped-out window. */
  standalone?: boolean
}

const AssistantView = forwardRef<HTMLDivElement, Props>(({ application, className, id, standalone }, ref) => {
  const { dismissLastPane, presentPane } = useResponsiveAppPane()

  const [messages, setMessages] = useState<UIMessage[]>([])
  const [input, setInput] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages])

  const newId = () => Math.random().toString(36).slice(2)

  const handleSend = useCallback(async () => {
    const trimmed = input.trim()
    if (!trimmed || isRunning) {
      return
    }

    const connectionMode = application.getPreference(PrefKey.AssistantConnectionMode, 'direct')
    const provider = application.getPreference(PrefKey.AssistantProvider, '')
    const baseURL = application.getPreference(PrefKey.AssistantBaseUrl, '')
    const apiKey = application.getPreference(PrefKey.AssistantApiKey, '')
    const model = application.getPreference(PrefKey.AssistantModel, '')
    const confirmBeforeWrite = application.getPreference(PrefKey.AssistantConfirmBeforeWrite, true)

    const userMessage: UIMessage = { kind: 'user', id: newId(), text: trimmed }
    const assistantId = newId()

    const priorHistory: AgentChatMessage[] = messages.flatMap((message): AgentChatMessage[] => {
      if (message.kind === 'user') {
        return [{ role: 'user', content: message.text }]
      }
      if (message.kind === 'assistant' && message.text) {
        return [{ role: 'assistant', content: message.text }]
      }
      return []
    })

    setMessages((prev) => [
      ...prev,
      userMessage,
      { kind: 'assistant', id: assistantId, text: '', tools: [], streaming: true },
    ])
    setInput('')
    setIsRunning(true)

    const updateAssistant = (updater: (message: Extract<UIMessage, { kind: 'assistant' }>) => void) => {
      setMessages((prev) =>
        prev.map((message) => {
          if (message.id === assistantId && message.kind === 'assistant') {
            const next = { ...message, tools: [...message.tools] }
            updater(next)
            return next
          }
          return message
        }),
      )
    }

    const controller = new AbortController()
    abortRef.current = controller

    const agentProvider: Provider =
      connectionMode === 'proxy'
        ? new ProxyProvider({
            provider,
            model,
            signal: controller.signal,
            postStream: (body, signal) => application.assistantStreamRequest('/v1/assistant/stream', body, signal),
          })
        : new DirectProvider({
            baseURL,
            model,
            apiKey,
            signal: controller.signal,
          })

    const tools = new AssistantTools(application, {
      confirmBeforeWrite,
      requestConfirmation: (description) =>
        confirmDialog({
          title: 'Assistant action',
          text: description,
          confirmButtonText: 'Allow',
          cancelButtonText: 'Deny',
        }),
      presentPane: (paneId: AppPaneId) => presentPane(paneId),
    })

    try {
      const result = await run([...priorHistory, { role: 'user', content: trimmed }], {
        provider: agentProvider,
        session: tools,
        systemPrompt: ASSISTANT_SYSTEM_PROMPT,
        signal: controller.signal,
        onTextDelta: (delta) => updateAssistant((message) => (message.text += delta)),
        onToolCall: (call) =>
          updateAssistant((message) => message.tools.push({ id: call.id, name: call.name, args: call.args })),
        onToolResult: (callId, toolResult, isError) =>
          updateAssistant((message) => {
            const entry = message.tools.find((tool) => tool.id === callId)
            if (entry) {
              entry.result = toolResult
              entry.isError = isError
            }
          }),
      })

      updateAssistant((message) => {
        message.streaming = false
        if (!message.text) {
          message.text = result.finalText
        }
      })

      if (result.stopReason === 'error') {
        setMessages((prev) => [
          ...prev,
          { kind: 'error', id: newId(), text: result.finalText || 'The assistant encountered an error.' },
        ])
      }
    } catch (error) {
      updateAssistant((message) => (message.streaming = false))
      setMessages((prev) => [
        ...prev,
        { kind: 'error', id: newId(), text: error instanceof Error ? error.message : String(error) },
      ])
    } finally {
      setIsRunning(false)
      abortRef.current = null
    }
  }, [application, input, isRunning, messages, presentPane])

  const handleStop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const isConfigured = useMemo(() => {
    const connectionMode = application.getPreference(PrefKey.AssistantConnectionMode, 'direct')
    if (connectionMode === 'proxy') {
      return Boolean(application.getPreference(PrefKey.AssistantProvider, ''))
    }
    return Boolean(application.getPreference(PrefKey.AssistantBaseUrl, '')) &&
      Boolean(application.getPreference(PrefKey.AssistantModel, ''))
  }, [application])

  const handlePopOut = useCallback(() => {
    window.open('/?route=assistant', '_blank', 'noopener,noreferrer')
  }, [])

  return (
    <div
      id={id}
      ref={ref}
      className={classNames(className, 'flex h-full flex-col overflow-hidden bg-default')}
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Icon type="dashboard" className="text-info" />
          <span className="text-base font-bold">Assistant</span>
        </div>
        <div className="flex items-center gap-1">
          {!standalone && (
            <button
              className="rounded p-1 hover:bg-contrast"
              onClick={handlePopOut}
              aria-label="Pop out assistant"
              title="Pop out to a new window"
            >
              <Icon type="open-in" />
            </button>
          )}
          {!standalone && (
            <button
              className="rounded p-1 hover:bg-contrast"
              onClick={() => dismissLastPane()}
              aria-label="Close assistant"
              title="Close assistant"
            >
              <Icon type="close" />
            </button>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="flex-grow overflow-y-auto px-4 py-4">
        {!isConfigured && (
          <div className="mb-4 rounded border border-border bg-contrast p-3 text-sm text-neutral">
            The assistant is not configured yet. Open Preferences → Assistant to set the connection mode, endpoint
            (e.g. LM Studio at http://localhost:1234/v1), and model.
          </div>
        )}
        {messages.length === 0 && isConfigured && (
          <div className="text-sm text-passive-0">
            Ask the assistant to find, summarize, create, or organize your notes.
          </div>
        )}
        <div className="flex flex-col gap-4">
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
        </div>
      </div>

      <div className="border-t border-border p-3">
        <div className="flex items-end gap-2">
          <textarea
            className="min-h-[2.5rem] flex-grow resize-none rounded border border-border bg-default px-3 py-2 text-sm focus:border-info focus:outline-none"
            placeholder="Message the assistant…"
            value={input}
            rows={1}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void handleSend()
              }
            }}
            disabled={isRunning}
          />
          {isRunning ? (
            <Button label="Stop" onClick={handleStop} />
          ) : (
            <Button primary label="Send" onClick={() => void handleSend()} disabled={!input.trim()} />
          )}
        </div>
      </div>
    </div>
  )
})

AssistantView.displayName = 'AssistantView'

const MessageBubble = ({ message }: { message: UIMessage }) => {
  if (message.kind === 'user') {
    return (
      <div className="self-end max-w-[85%] rounded-lg bg-info px-3 py-2 text-sm text-info-contrast">
        {message.text}
      </div>
    )
  }

  if (message.kind === 'error') {
    return (
      <div className="max-w-[85%] rounded-lg border border-danger bg-default px-3 py-2 text-sm text-danger">
        {message.text}
      </div>
    )
  }

  return (
    <div className="max-w-[85%] self-start">
      {message.tools.length > 0 && (
        <div className="mb-1 flex flex-col gap-1">
          {message.tools.map((tool) => (
            <div key={tool.id} className="rounded border border-border bg-contrast px-2 py-1 text-xs text-neutral">
              <div className="flex items-center gap-1 font-semibold">
                <Icon type="dashboard" size="small" />
                {tool.name}
              </div>
              {tool.result !== undefined && (
                <div className={classNames('mt-0.5 truncate', tool.isError ? 'text-danger' : 'text-passive-0')}>
                  {tool.result}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {(message.text || message.streaming) && (
        <div className="whitespace-pre-wrap rounded-lg bg-contrast px-3 py-2 text-sm text-text">
          {message.text}
          {message.streaming && <span className="ml-0.5 animate-pulse">▍</span>}
        </div>
      )}
    </div>
  )
}

export default observer(AssistantView)
