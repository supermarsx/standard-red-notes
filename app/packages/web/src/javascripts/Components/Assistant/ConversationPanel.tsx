import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { AssistantTools, AssistantToolContext, TodoItem } from '@/Assistant/tools'
import { ASSISTANT_SYSTEM_PROMPT, SUB_AGENT_SYSTEM_PROMPT } from '@/Assistant/prompts'
import ContextSelector from './ContextSelector'
import { AssistantContextScope } from '@/Assistant/assistantContext'
import { AssistantContextSelection, buildContextForSelection } from '@/Assistant/assistantContextSource'

type ToolEntry = {
  id: string
  name: string
  args: unknown
  result?: string
  isError?: boolean
}

type UIMessage =
  | { kind: 'user'; id: string; text: string; steered?: boolean }
  | { kind: 'assistant'; id: string; text: string; tools: ToolEntry[]; streaming?: boolean }
  | { kind: 'error'; id: string; text: string }

type Props = {
  application: WebApplication
  /** Called the first time the user sends a message in this conversation. */
  onFirstUserMessage?: (text: string) => void
  /** Called when usage stats refresh, so the shell can show them in the header. */
  onUsageChange?: (usage: { used: number; limit: number } | null) => void
}

// "Don't show again" for the data-exposure notice is kept in localStorage rather
// than a synced PrefKey so this view stays out of the models package.
const DATA_EXPOSURE_NOTICE_DISMISSED_KEY = 'assistant-data-exposure-notice-dismissed'

// Last-used context scope is likewise persisted in localStorage (cheap, local,
// avoids touching the synced models package). Collection sub-selections are not
// persisted — only the high-level scope, defaulting to the current note.
const CONTEXT_SCOPE_KEY = 'assistant-context-scope'

const readNoticeDismissed = () => {
  try {
    return localStorage.getItem(DATA_EXPOSURE_NOTICE_DISMISSED_KEY) === 'true'
  } catch {
    return false
  }
}

const isContextScope = (value: string | null): value is AssistantContextScope =>
  value === 'current-note' || value === 'all-notes' || value === 'collection'

const readContextScope = (): AssistantContextScope => {
  try {
    const stored = localStorage.getItem(CONTEXT_SCOPE_KEY)
    return isContextScope(stored) ? stored : 'current-note'
  } catch {
    return 'current-note'
  }
}

function ConversationPanelImpl({ application, onFirstUserMessage, onUsageChange }: Props) {
  const { presentPane } = useResponsiveAppPane()

  const [messages, setMessages] = useState<UIMessage[]>([])
  const [input, setInput] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [usage, setUsage] = useState<{ used: number; limit: number } | null>(null)
  const [queue, setQueue] = useState<string[]>([])
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [noticeDismissed, setNoticeDismissed] = useState(() => readNoticeDismissed())
  const [contextSelection, setContextSelection] = useState<AssistantContextSelection>(() => ({
    scope: readContextScope(),
  }))
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Mirror of `messages` kept in sync synchronously so a queued run started from
  // the previous run's finally block builds history from the latest transcript.
  const messagesRef = useRef<UIMessage[]>([])
  // Steering messages awaiting injection into the in-flight run.
  const steerQueueRef = useRef<string[]>([])
  // Pending follow-up prompts to run after the current run finishes.
  const queueRef = useRef<string[]>([])
  // Stable handle so a run can recursively start the next queued prompt.
  const runPromptRef = useRef<((text: string) => Promise<void>) | null>(null)
  // Whether the user has sent at least one message in this conversation.
  const hasSentRef = useRef(false)

  const setMessagesSynced = useCallback((updater: (prev: UIMessage[]) => UIMessage[]) => {
    setMessages((prev) => {
      const next = updater(prev)
      messagesRef.current = next
      return next
    })
  }, [])

  // Mirror the context selection so an in-flight run reads the latest scope
  // without re-creating runPrompt on every selection change.
  const contextSelectionRef = useRef<AssistantContextSelection>(contextSelection)
  contextSelectionRef.current = contextSelection

  const handleContextChange = useCallback((next: AssistantContextSelection) => {
    setContextSelection(next)
    try {
      localStorage.setItem(CONTEXT_SCOPE_KEY, next.scope)
    } catch {
      // Persisting the scope is best-effort; ignore storage failures.
    }
  }, [])

  // A live preview of what the current scope would send, used to (a) surface the
  // active context in the UI and (b) make the data-exposure warning concrete.
  const contextPreview = useMemo(
    () => buildContextForSelection(application, contextSelection),
    [application, contextSelection],
  )

  const connectionMode = application.getPreference(PrefKey.AssistantConnectionMode, 'direct')

  const refreshUsage = useCallback(async () => {
    if (connectionMode !== 'proxy') {
      setUsage(null)
      return
    }
    try {
      const result = await application.assistantConfigRequest<{ used: number; limit: number; resetsAt: string }>(
        '/v1/assistant/usage',
      )
      if (typeof result?.used === 'number' && typeof result?.limit === 'number') {
        setUsage({ used: result.used, limit: result.limit })
      }
    } catch {
      // Usage display is best-effort; ignore failures.
    }
  }, [application, connectionMode])

  useEffect(() => {
    void refreshUsage()
  }, [refreshUsage])

  useEffect(() => {
    onUsageChange?.(usage)
  }, [usage, onUsageChange])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages])

  const newId = () => Math.random().toString(36).slice(2)

  const runPrompt = useCallback(
    async (promptText: string) => {
      const provider = application.getPreference(PrefKey.AssistantProvider, '')
      const baseURL = application.getPreference(PrefKey.AssistantBaseUrl, '')
      const apiKey = application.getPreference(PrefKey.AssistantApiKey, '')
      const model = application.getPreference(PrefKey.AssistantModel, '')
      const confirmBeforeWrite = application.getPreference(PrefKey.AssistantConfirmBeforeWrite, true)

      const assistantId = newId()

      // History is the transcript BEFORE this prompt (read from the synced ref so
      // a queued run sees the previous run's messages).
      const priorHistory: AgentChatMessage[] = messagesRef.current.flatMap((message): AgentChatMessage[] => {
        if (message.kind === 'user') {
          return [{ role: 'user', content: message.text }]
        }
        if (message.kind === 'assistant' && message.text) {
          return [{ role: 'assistant', content: message.text }]
        }
        return []
      })

      setMessagesSynced((prev) => [
        ...prev,
        { kind: 'user', id: newId(), text: promptText },
        { kind: 'assistant', id: assistantId, text: '', tools: [], streaming: true },
      ])
      setTodos([])
      setIsRunning(true)

      const updateAssistant = (updater: (message: Extract<UIMessage, { kind: 'assistant' }>) => void) => {
        setMessagesSynced((prev) =>
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

      // Sub-agent runner backing the "delegate" tool: a focused nested run that
      // shares the provider and tools but cannot itself delegate (recursion guard).
      const runSubAgent = async (task: string, contextText?: string): Promise<string> => {
        // Sub-agents share the tools but report neither todos nor delegation to the
        // UI (the top-level run owns the visible plan).
        const subContext: AssistantToolContext = { ...toolContext, onTodosChanged: undefined }
        const subTools = new AssistantTools(application, subContext, false)
        const subPrompt = contextText ? `${task}\n\nContext:\n${contextText}` : task
        const sub = await run([{ role: 'user', content: subPrompt }], {
          provider: agentProvider,
          session: subTools,
          systemPrompt: SUB_AGENT_SYSTEM_PROMPT,
          maxSteps: 6,
          signal: controller.signal,
        })
        return sub.finalText || '(sub-agent finished with no summary)'
      }

      const toolContext: AssistantToolContext = {
        confirmBeforeWrite,
        requestConfirmation: (description) =>
          confirmDialog({
            title: 'Assistant action',
            text: description,
            confirmButtonText: 'Allow',
            cancelButtonText: 'Deny',
          }),
        presentPane: (paneId: AppPaneId) => presentPane(paneId),
        runSubAgent,
        onTodosChanged: (next) => setTodos(next),
      }

      const tools = new AssistantTools(application, toolContext)

      // Assemble the user-chosen context (current note / all notes / collection)
      // and append it to the system prompt so the model can answer about the
      // selected notes without first calling tools. Bounded by a character budget
      // inside buildAssistantContext so broad scopes can't blow the token budget.
      const builtContext = buildContextForSelection(application, contextSelectionRef.current)
      const systemPrompt = builtContext.text
        ? `${ASSISTANT_SYSTEM_PROMPT}\n\n--- NOTE CONTEXT ---\n${builtContext.text}`
        : ASSISTANT_SYSTEM_PROMPT

      try {
        const result = await run([...priorHistory, { role: 'user', content: promptText }], {
          provider: agentProvider,
          session: tools,
          systemPrompt,
          signal: controller.signal,
          control: {
            // Drain and inject any steering messages queued during this run.
            drainSteers: () => {
              const pending = steerQueueRef.current
              steerQueueRef.current = []
              return pending
            },
          },
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
          setMessagesSynced((prev) => [
            ...prev,
            { kind: 'error', id: newId(), text: result.finalText || 'The assistant encountered an error.' },
          ])
        }
      } catch (error) {
        updateAssistant((message) => (message.streaming = false))
        setMessagesSynced((prev) => [
          ...prev,
          { kind: 'error', id: newId(), text: error instanceof Error ? error.message : String(error) },
        ])
      } finally {
        setIsRunning(false)
        abortRef.current = null
        void refreshUsage()
        // Chain into the next queued prompt unless the user interrupted.
        if (!controller.signal.aborted && queueRef.current.length > 0) {
          const [next, ...rest] = queueRef.current
          queueRef.current = rest
          setQueue(rest)
          void runPromptRef.current?.(next)
        }
      }
    },
    [application, connectionMode, presentPane, refreshUsage, setMessagesSynced],
  )

  runPromptRef.current = runPrompt

  const notifyFirstMessage = useCallback(
    (text: string) => {
      if (!hasSentRef.current) {
        hasSentRef.current = true
        onFirstUserMessage?.(text)
      }
    },
    [onFirstUserMessage],
  )

  const handleSend = useCallback(() => {
    const trimmed = input.trim()
    if (!trimmed || isRunning) {
      return
    }
    notifyFirstMessage(trimmed)
    setInput('')
    void runPrompt(trimmed)
  }, [input, isRunning, notifyFirstMessage, runPrompt])

  // Steer: inject guidance into the in-flight run without restarting it.
  const handleSteer = useCallback(() => {
    const trimmed = input.trim()
    if (!trimmed || !isRunning) {
      return
    }
    steerQueueRef.current = [...steerQueueRef.current, trimmed]
    setMessagesSynced((prev) => [...prev, { kind: 'user', id: newId(), text: trimmed, steered: true }])
    setInput('')
  }, [input, isRunning, setMessagesSynced])

  // Queue: line up a follow-up prompt to run after the current one finishes.
  const handleQueue = useCallback(() => {
    const trimmed = input.trim()
    if (!trimmed) {
      return
    }
    notifyFirstMessage(trimmed)
    queueRef.current = [...queueRef.current, trimmed]
    setQueue(queueRef.current)
    setInput('')
  }, [input, notifyFirstMessage])

  const dismissNotice = useCallback(() => {
    setNoticeDismissed(true)
    try {
      localStorage.setItem(DATA_EXPOSURE_NOTICE_DISMISSED_KEY, 'true')
    } catch {
      // Persisting the dismissal is best-effort; ignore storage failures.
    }
  }, [])

  const removeQueued = useCallback((index: number) => {
    queueRef.current = queueRef.current.filter((_, i) => i !== index)
    setQueue(queueRef.current)
  }, [])

  // Interrupt: abort the current run and drop any pending steers/queue.
  const handleStop = useCallback(() => {
    queueRef.current = []
    setQueue([])
    steerQueueRef.current = []
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

  // A short, human-readable summary of what the active scope would send, shared
  // by the inline warning and the data-exposure notice so the user always knows
  // how much note content reaches the AI provider.
  const contextSummary = useMemo(() => {
    const { scope, noteCount, characters, truncated } = contextPreview
    if (noteCount === 0) {
      return scope === 'current-note'
        ? 'No active note — only your message will be sent.'
        : 'No notes in this context yet — only your message will be sent.'
    }
    const noteLabel = `${noteCount} note${noteCount === 1 ? '' : 's'}`
    const sizeLabel = `~${characters.toLocaleString()} chars`
    return `Sending ${noteLabel} / ${sizeLabel}${truncated ? ' (truncated)' : ''} to the AI provider.`
  }, [contextPreview])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ContextSelector
        application={application}
        selection={contextSelection}
        onChange={handleContextChange}
        disabled={isRunning}
      />
      {todos.length > 0 && (
        <div className="border-b border-border bg-default px-4 py-2">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-passive-1">Plan</div>
          <ul className="flex flex-col gap-1">
            {todos.map((todo, index) => (
              <li key={index} className="flex items-start gap-2 text-sm">
                <span
                  className={classNames(
                    'mt-0.5 w-4 flex-shrink-0 text-center',
                    todo.status === 'completed' && 'text-success',
                    todo.status === 'in_progress' && 'text-info',
                    todo.status === 'pending' && 'text-passive-1',
                  )}
                  aria-hidden
                >
                  {todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '◐' : '○'}
                </span>
                <span
                  className={classNames(
                    todo.status === 'completed' && 'text-passive-1 line-through',
                    todo.status === 'in_progress' && 'font-medium text-text',
                    todo.status === 'pending' && 'text-neutral',
                  )}
                >
                  {todo.content}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div ref={scrollRef} className="flex-grow overflow-y-auto px-4 py-4">
        {!noticeDismissed && (
          <div className="mb-4 rounded border border-solid border-warning bg-warning-faded p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="text-sm font-semibold text-warning">Your messages and note content are sent to an AI provider</div>
              <button
                className="-mr-1 -mt-1 flex-shrink-0 rounded p-1 text-warning hover:bg-warning-faded"
                onClick={dismissNotice}
                aria-label="Dismiss notice"
                title="Dismiss"
              >
                <Icon type="close" size="small" />
              </button>
            </div>
            <div className="mt-1 text-sm text-warning">
              Tools run locally in your browser, but model calls do not. Whatever you type and any note content the
              assistant reads is sent to your configured AI provider, which may expose information you did not intend to
              share — especially with cloud providers.
            </div>
            <div className="mt-2 text-sm font-semibold text-warning">{contextSummary}</div>
          </div>
        )}
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

      <div className="border-t border-border bg-contrast p-3">
        <div className="mb-2 text-xs text-warning">
          Messages and note content the assistant reads are sent to your configured AI provider. {contextSummary}
        </div>
        {queue.length > 0 && (
          <div className="mb-2 flex flex-col gap-1">
            {queue.map((item, index) => (
              <div
                key={index}
                className="flex items-center justify-between gap-2 rounded border border-border bg-default px-2 py-1 text-xs text-passive-0"
              >
                <span className="truncate">
                  <span className="mr-1 font-semibold text-neutral">Queued:</span>
                  {item}
                </span>
                <button
                  className="rounded p-0.5 hover:bg-contrast"
                  onClick={() => removeQueued(index)}
                  aria-label="Remove from queue"
                  title="Remove from queue"
                >
                  <Icon type="close" size="small" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            className="min-h-[2.5rem] flex-grow resize-none rounded border border-border bg-default px-3 py-2 text-sm focus:border-info focus:outline-none"
            placeholder={isRunning ? 'Steer the task, or queue a follow-up…' : 'Message the assistant…'}
            value={input}
            rows={1}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                if (isRunning) {
                  handleSteer()
                } else {
                  handleSend()
                }
              }
            }}
          />
          {isRunning ? (
            <div className="flex items-center gap-1">
              <Button primary label="Steer" onClick={handleSteer} disabled={!input.trim()} />
              <Button label="Queue" onClick={handleQueue} disabled={!input.trim()} />
              <Button label="Stop" onClick={handleStop} />
            </div>
          ) : (
            <Button primary label="Send" onClick={handleSend} disabled={!input.trim()} />
          )}
        </div>
      </div>
    </div>
  )
}

const MessageBubble = ({ message }: { message: UIMessage }) => {
  if (message.kind === 'user') {
    return (
      <div className="self-end max-w-[85%] rounded-lg bg-info px-3 py-2 text-sm text-info-contrast">
        {message.steered && <div className="mb-0.5 text-xs font-semibold opacity-80">↳ Steer</div>}
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

const ConversationPanelObserved = observer(ConversationPanelImpl)

export default ConversationPanelObserved
