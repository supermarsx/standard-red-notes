import {
  AssistantAttachment,
  assertAttachmentBudget,
  attachmentImages,
  attachmentUserText,
  declaredDirectImageSupport,
  prepareAssistantAttachment,
} from '@/Assistant/attachments'
import { AttachmentPreview } from './ComposerAttachments'
import AssistantMessageContent from './AssistantMessageContent'
import AssistantActivityGroup from './AssistantActivityGroup'
import { AssistantActionNotAllowedError } from '@/Assistant/AssistantActionNotAllowedError'
import type { AssistantChatContextSnapshot } from '@/Assistant/assistantDirectiveContext'
import AssistantComposer from './AssistantComposer'
import AssistantModeSelector from './AssistantModeSelector'
import type { AssistantConversationMode } from '@/Assistant/conversationModes'
import { runConversationMode } from '@/Assistant/conversationModeRunner'
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { ApplicationEvent, ContentType, PrefKey, SNNote, isNote } from '@standardnotes/snjs'
import { classNames } from '@standardnotes/utils'
import { addToast, ToastType } from '@standardnotes/toast'
import { confirmDialog } from '@standardnotes/ui-services'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import Button from '@/Components/Button/Button'
import { useResponsiveAppPane } from '../Panes/ResponsivePaneProvider'
import { AppPaneId } from '../Panes/AppPaneMetadata'
import { ChatMessage as AgentChatMessage, Provider, ToolExecutionOutcome } from '@/Assistant/types'
import { run } from '@/Assistant/agent'
import { achievements, METRICS } from '@/Achievements'
import { AssistantTools, AssistantToolContext, TodoItem, TOOL_DEFINITIONS } from '@/Assistant/tools'
import { ASSISTANT_SYSTEM_PROMPT, SUB_AGENT_SYSTEM_PROMPT, wrapUntrustedNoteContext } from '@/Assistant/prompts'
import { composeSystemPromptWithPersona, getAssistantAccountScope, getPersona } from '@/Assistant/personaSettings'
import ContextSelector from './ContextSelector'
import AssistantUsageMeter from './AssistantUsageMeter'
import AssistantNoticeDismissal from './AssistantNoticeDismissal'
import { AssistantUsageResponse, TokenWindowUsage } from '@/Assistant/usageMeter'
import {
  accumulateChatTokenUsage,
  EMPTY_CHAT_TOKEN_USAGE,
  observeProviderTokenUsage,
} from '@/Assistant/usageMeterProvider'
import {
  AssistantContextSelection,
  assistantContextOwnerKey,
  buildContextForSelection,
  resolveContextNoteUuids,
  captureAssistantTextSelection,
} from '@/Assistant/assistantContextSource'
import {
  resolveActiveProfileOverrides,
  buildAssistantProvider,
  getSelectionAIAvailability,
} from '@/Assistant/selectionActions'
import {
  AssistantChatHistoryCheckpoint,
  PersistedAssistantMessage,
  createAssistantChatHistoryCheckpoint,
  persistAssistantChatHistoryStrict,
  sanitizeAssistantChatMessages,
  readAssistantChatHistoryResult,
} from '@/Assistant/assistantChatHistory'
import { getMaxRunTimeMs, loadSamplingSettings } from '@/Assistant/samplingSettings'
import {
  canPreflightAutoAllow,
  legacyConfirmBeforeWriteForMode,
  reviewAssistantAction,
  shouldConfirmAssistantTool,
  AssistantToolPermissionMode,
} from '@/Assistant/assistantActionReview'
import {
  describeAssistantTool,
  describeAssistantToolConfirmation,
  AssistantConfirmationPresentation,
  AssistantToolConfirmation,
  isIrreversibleAssistantTool,
} from '@/Assistant/assistantPresentation'
import {
  persistAssistantContextScope,
  persistAssistantNoticeDismissed,
  readAssistantContextScope,
  readAssistantNoticeDismissed,
  readAssistantNoticeReminderAt,
  AssistantNoticeDismissal as NoticeDismissalChoice,
  ASSISTANT_DATA_EXPOSURE_NOTICE_KEY,
} from '@/Assistant/assistantLocalSettings'
import { createAssistantTextDeltaBatcher } from '@/Assistant/assistantTextDeltaBatcher'
import { boundProviderHistory, DEFAULT_PROVIDER_HISTORY_CHARACTER_BUDGET } from '@/Assistant/providerHistory'
import { AssistantChatDirective, parseAssistantDirectivePrompt } from '@/Assistant/assistantDirectives'
import {
  assistantSessionPrincipalMatches,
  captureAssistantSessionPrincipal,
} from '@/Assistant/assistantSessionPrincipal'
import {
  AssistantNoteChange,
  AssistantNoteChangeDirection,
  captureAssistantNoteSnapshot,
  flushAssistantNoteEditors,
} from '@/Assistant/assistantNoteChanges'
import { applyAssistantChangeHistory } from '@/Assistant/assistantChangeLedger'
import AssistantMessageActions from './AssistantMessageActions'
import type { AssistantSharedChatBinding } from '@/Assistant/assistantSyncedChats'
import { acquireAssistantChatRun, AssistantChatRunGuard } from '@/Assistant/assistantChatRunLease'
import {
  acknowledgeAssistantSharedVersions,
  reconcileAssistantSharedMessages,
} from '@/Assistant/assistantSharedHistory'
import { serializeAssistantProvider } from '@/Assistant/serializedProvider'

export type ToolEntry = {
  id: string
  /** Provider ids can repeat between responses; never use this as a UI identity. */
  providerCallId?: string
  name: string
  args: unknown
  /** Static client-generated label restored from the redacted audit record. */
  persistedLabel?: string
  outcome?: ToolExecutionOutcome
  authorization?: {
    decision: 'allow' | 'deny'
    source: 'policy' | 'safety-review' | 'user-once' | 'user-chat'
  }
  noteChange?: AssistantNoteChange
  noteChangePosition?: 'before' | 'after'
  noteChangePending?: boolean
  noteChangeError?: string
}

type UIMessage =
  | { kind: 'user'; id: string; text: string; steered?: boolean; attachments?: AssistantAttachment[] }
  | { kind: 'assistant'; id: string; text: string; tools: ToolEntry[]; streaming?: boolean }
  | { kind: 'error'; id: string; text: string }

const hydrateAssistantHistory = (history: PersistedAssistantMessage[]): UIMessage[] =>
  history.map((message): UIMessage => {
    if (message.kind === 'assistant') {
      return {
        kind: 'assistant',
        id: message.id,
        text: message.text,
        tools: (message.activities ?? []).map((activity) => {
          const persistedChange = activity.noteChange
          return {
            id: activity.id,
            name: activity.name,
            args: {},
            persistedLabel: activity.label,
            authorization: activity.authorization,
            outcome: activity.outcome,
            ...(persistedChange
              ? {
                  noteChange: {
                    noteUuid: persistedChange.noteUuid,
                    noteTitle: persistedChange.noteTitle,
                    before: persistedChange.before,
                    after: persistedChange.after,
                    patch: persistedChange.patch,
                    addedLines: persistedChange.addedLines,
                    removedLines: persistedChange.removedLines,
                    truncated: persistedChange.truncated,
                  } as AssistantNoteChange,
                  noteChangePosition: persistedChange.position,
                }
              : {}),
          }
        }),
      }
    }
    if (message.kind === 'user') {
      return {
        kind: 'user',
        id: message.id,
        text: message.text,
        steered: message.steered,
        attachments: message.attachments,
      }
    }
    return { kind: 'error', id: message.id, text: message.text }
  })

type ConversationPrompt = {
  attachments?: AssistantAttachment[]
  providerPrompt: string
  directive?: AssistantChatDirective
  mode?: AssistantConversationMode
}

const KNOWN_ASSISTANT_TOOL_NAMES = new Set([...TOOL_DEFINITIONS.map((tool) => tool.name), 'delegate'])
const MAX_LIVE_ASSISTANT_NOTE_CHANGES = 6

const retainNewestAssistantNoteChanges = (messages: UIMessage[]): UIMessage[] => {
  let retained = 0
  return messages
    .slice()
    .reverse()
    .map((message) => {
      if (message.kind !== 'assistant') {
        return message
      }
      const tools = message.tools
        .slice()
        .reverse()
        .map((tool) => {
          if (!tool.noteChange) {
            return tool
          }
          retained++
          return retained <= MAX_LIVE_ASSISTANT_NOTE_CHANGES
            ? tool
            : {
                ...tool,
                noteChange: undefined,
                noteChangePosition: undefined,
                noteChangePending: undefined,
                noteChangeError: undefined,
              }
        })
        .reverse()
      return { ...message, tools }
    })
    .reverse()
}

const describeContextPreview = (preview: {
  scope: AssistantContextSelection['scope']
  noteCount: number
  characters: number
  truncated: boolean
  noteTitles: string[]
}) => {
  const { scope, noteCount, characters, truncated, noteTitles } = preview
  if (noteCount === 0) {
    return scope === 'current-note'
      ? 'No active note — only your message will be sent.'
      : 'No notes in this context yet — only your message will be sent.'
  }
  const noteLabel = `${noteCount} note${noteCount === 1 ? '' : 's'}`
  const sizeLabel = `~${characters.toLocaleString()} chars`
  const titleLabel =
    noteTitles.length === 1
      ? ` In context: “${noteTitles[0]}”.`
      : noteTitles.length > 1
        ? ` In context: ${noteTitles
            .slice(0, 2)
            .map((title) => `“${title}”`)
            .join(', ')}${noteTitles.length > 2 ? `, and ${noteTitles.length - 2} more` : ''}.`
        : ''
  return `Sending ${noteLabel} / ${sizeLabel}${truncated ? ' (truncated)' : ''} to the AI provider.${titleLabel}`
}

type Props = {
  application: WebApplication
  tabId: string
  /** Stable owner scope supplied by AssistantView during account transitions. */
  accountScope: string
  /** False when this browsing context cannot safely own durable chat storage. */
  persistenceAllowed: boolean
  /** Only the visible chat computes its potentially expensive live context preview. */
  isActive?: boolean
  runPersistence?: (operation: () => Promise<void>) => Promise<boolean>
  registerPersistenceFinalizer?: (finalizer: () => Promise<void>) => () => void
  /** Called the first time the user sends a message in this conversation. */
  onFirstUserMessage?: (text: string) => void
  /** One-shot editor action routed by AssistantView into the active chat only. */
  directive?: AssistantChatDirective
  onDirectiveConsumed?: (directiveId: string) => void
  recentChats?: ReactNode
  onContextSnapshot?: (snapshot: AssistantChatContextSnapshot) => void
  conversationMode?: AssistantConversationMode
  onModeChange?: (mode: AssistantConversationMode) => void
  sharedChat?: AssistantSharedChatBinding
}

function ConversationPanelImpl({
  application,
  tabId,
  accountScope,
  persistenceAllowed,
  isActive = true,
  runPersistence,
  registerPersistenceFinalizer,
  onFirstUserMessage,
  directive,
  onDirectiveConsumed,
  recentChats,
  sharedChat,
  onContextSnapshot,
  conversationMode = 'agent',
  onModeChange,
}: Props) {
  const { presentPane } = useResponsiveAppPane()

  const initialHistoryRead = useRef(
    sharedChat?.history
      ? {
          status: 'found' as const,
          messages: sharedChat.history.messages,
          deniedToolNames: sharedChat.history.deniedToolNames,
        }
      : persistenceAllowed
        ? readAssistantChatHistoryResult(application.storage, accountScope, tabId)
        : ({ status: 'missing' } as const),
  ).current
  const historyReadFailed = initialHistoryRead.status === 'error'
  const [historyPersistenceFailed, setHistoryPersistenceFailed] = useState(historyReadFailed)
  const effectivePersistenceAllowed = persistenceAllowed && !historyPersistenceFailed
  const [messages, setMessages] = useState<UIMessage[]>(() =>
    hydrateAssistantHistory(initialHistoryRead.status === 'found' ? initialHistoryRead.messages : []),
  )
  const [input, setInput] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  // Per-user rolling-window TOKEN usage (5h + weekly) for the in-chat meter.
  const [tokenWindows, setTokenWindows] = useState<{
    fiveHour?: TokenWindowUsage
    weekly?: TokenWindowUsage
  } | null>(null)
  const [chatTokenUsage, setChatTokenUsage] = useState(EMPTY_CHAT_TOKEN_USAGE)
  useEffect(() => {
    setChatTokenUsage(EMPTY_CHAT_TOKEN_USAGE)
    setTokenWindows(null)
  }, [accountScope])
  const [attachments, setAttachments] = useState<AssistantAttachment[]>([])
  const attachmentsRef = useRef<AssistantAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState('')
  const [attachmentsBusy, setAttachmentsBusy] = useState(false)
  const attachmentTaskRef = useRef(0)
  const [proxyImagesAllowed, setProxyImagesAllowed] = useState(false)
  const [queue, setQueue] = useState<ConversationPrompt[]>([])
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [noticeStoredDismissed, setNoticeStoredDismissed] = useState(() => readAssistantNoticeDismissed(accountScope))
  const [noticeSessionDismissed, setNoticeSessionDismissed] = useState(false)
  const [noticeDismissalOpen, setNoticeDismissalOpen] = useState(false)
  const noticeDismissed = noticeSessionDismissed || noticeStoredDismissed
  useEffect(() => {
    setNoticeSessionDismissed(false)
    setNoticeDismissalOpen(false)
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => {
      clearTimeout(timer)
      setNoticeStoredDismissed(readAssistantNoticeDismissed(accountScope))
      const remindAt = readAssistantNoticeReminderAt(accountScope)
      if (remindAt && remindAt > Date.now()) {
        timer = setTimeout(refresh, Math.min(remindAt - Date.now(), 2_147_483_647))
      }
    }
    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key === `${ASSISTANT_DATA_EXPOSURE_NOTICE_KEY}:${encodeURIComponent(accountScope)}`) {
        refresh()
      }
    }
    const onNoticeChange = (event: Event) => {
      if ((event as CustomEvent<{ accountScope: string }>).detail?.accountScope === accountScope) {
        refresh()
      }
    }
    refresh()
    window.addEventListener('storage', onStorage)
    window.addEventListener('assistant-notice-changed', onNoticeChange)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('assistant-notice-changed', onNoticeChange)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [accountScope])
  const [contextSelection, setContextSelection] = useState<AssistantContextSelection>(() => ({
    scope: readAssistantContextScope(accountScope),
  }))
  const [contextItemsRevision, setContextItemsRevision] = useState(0)
  const [pendingConfirmation, setPendingConfirmation] = useState<{
    presentation: AssistantConfirmationPresentation
    request: AssistantToolConfirmation
  } | null>(null)
  const [safetyReview, setSafetyReview] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const runLeaseRef = useRef<AssistantChatRunGuard | null>(null)
  const sharedChatRef = useRef(sharedChat)
  sharedChatRef.current = sharedChat
  const sharedDirtyRef = useRef(false)
  const sharedDirtyIdsRef = useRef(new Map<string, number>())
  const sharedLocalRevisionRef = useRef(0)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Mirror of `messages` kept in sync synchronously so a queued run started from
  // the previous run's finally block builds history from the latest transcript.
  const messagesRef = useRef<UIMessage[]>(messages)
  // Steering messages awaiting injection into the in-flight run.
  const steerQueueRef = useRef<string[]>([])
  // Pending follow-up prompts to run after the current run finishes.
  const queueRef = useRef<ConversationPrompt[]>([])
  // Stable handle so a run can recursively start the next queued prompt.
  const runPromptRef = useRef<((request: ConversationPrompt) => Promise<void>) | null>(null)
  // Whether the user has sent at least one message in this conversation.
  const hasSentRef = useRef(messages.some((message) => message.kind === 'user'))
  const confirmationResolverRef = useRef<((approved: boolean) => void) | null>(null)
  const sessionToolDecisionsRef = useRef(
    new Map<string, boolean>([
      ...(initialHistoryRead.status === 'found'
        ? initialHistoryRead.deniedToolNames
            .filter((name) => KNOWN_ASSISTANT_TOOL_NAMES.has(name))
            .map((name): [string, boolean] => [name, false])
        : []),
      ...messages.flatMap((message) => {
        return message.kind === 'assistant'
          ? message.tools
              .filter((tool) => tool.authorization?.decision === 'deny' && tool.authorization.source === 'user-chat')
              .map((tool): [string, boolean] => [tool.name, false])
          : []
      }),
    ]),
  )
  const activeToolActivityIdsRef = useRef(new Map<string, string>())
  const preflightProviderRef = useRef<Provider | null>(null)
  const runIntentRef = useRef('')
  const toolPermissionModeRef = useRef<AssistantToolPermissionMode>(
    application.getPreference(PrefKey.AssistantToolPermissionMode, 'allow-read'),
  )
  const historyCheckpointRef = useRef<AssistantChatHistoryCheckpoint | null>(null)
  const historyWriterRef = useRef<() => Promise<void>>(async () => undefined)
  const mountedRef = useRef(true)
  const persistableHistoryRef = useRef<{
    accountScope: string
    tabId: string
  } | null>(null)
  const persistenceAllowedRef = useRef(effectivePersistenceAllowed)
  persistenceAllowedRef.current = effectivePersistenceAllowed
  const runPersistenceRef = useRef(runPersistence)
  runPersistenceRef.current = runPersistence
  const conversationIdentityRef = useRef({ accountScope, tabId })
  conversationIdentityRef.current = { accountScope, tabId }
  const consumedDirectiveIdsRef = useRef(new Set<string>())
  const sessionEpochRef = useRef(0)
  const observedPrincipalRef = useRef(captureAssistantSessionPrincipal(application.sessions))

  useEffect(() => {
    const incoming = sharedChat?.history
    if (!incoming) {
      return
    }
    const restored = hydrateAssistantHistory(incoming.messages)
    const local = messagesRef.current
    const merged = reconcileAssistantSharedMessages(restored, local, new Set(sharedDirtyIdsRef.current.keys()))
    if (JSON.stringify(local) !== JSON.stringify(merged)) {
      messagesRef.current = merged
      setMessages(merged)
    }
    for (const name of incoming.deniedToolNames) {
      if (KNOWN_ASSISTANT_TOOL_NAMES.has(name)) {
        sessionToolDecisionsRef.current.set(name, false)
      }
    }
  }, [sharedChat?.history])

  const markHistoryPersistenceFailed = useCallback(() => {
    persistenceAllowedRef.current = false
    persistableHistoryRef.current = null
    if (mountedRef.current) {
      setHistoryPersistenceFailed(true)
    }
  }, [])

  const setMessagesSynced = useCallback((updater: (prev: UIMessage[]) => UIMessage[]) => {
    const previous = new Map(messagesRef.current.map((message) => [message.id, JSON.stringify(message)]))
    const next = updater(messagesRef.current)
    const revision = ++sharedLocalRevisionRef.current
    const nextIds = new Set(next.map((message) => message.id))
    for (const message of next) {
      if (previous.get(message.id) !== JSON.stringify(message)) {
        sharedDirtyIdsRef.current.set(message.id, revision)
      }
    }
    for (const id of previous.keys()) {
      if (!nextIds.has(id)) {
        sharedDirtyIdsRef.current.set(id, revision)
      }
    }
    sharedDirtyRef.current = sharedDirtyIdsRef.current.size > 0
    messagesRef.current = next
    setMessages(next)
  }, [])

  const recordToolAuthorization = useCallback(
    (callId: string | undefined, authorization: NonNullable<ToolEntry['authorization']>) => {
      if (!callId) {
        return
      }
      const activityId = activeToolActivityIdsRef.current.get(callId) ?? callId
      setMessagesSynced((current) =>
        current.map((message) => {
          return message.kind === 'assistant' && message.tools.some((tool) => tool.id === activityId)
            ? {
                ...message,
                tools: message.tools.map((tool) => (tool.id === activityId ? { ...tool, authorization } : tool)),
              }
            : message
        }),
      )
    },
    [setMessagesSynced],
  )

  const applyNoteChangeHistory = useCallback(
    async (toolId: string, direction: AssistantNoteChangeDirection) => {
      const currentScope = application.sessions.getUser()?.uuid ?? `anonymous:${application.identifier}`
      if (currentScope !== accountScope) {
        return
      }
      const tool = messagesRef.current
        .flatMap((message) => (message.kind === 'assistant' ? message.tools : []))
        .find((entry) => entry.id === toolId)
      if (!tool?.noteChange || tool.noteChangePending) {
        return
      }
      setMessagesSynced((current) =>
        current.map((message) => {
          if (message.kind !== 'assistant') {
            return message
          }
          return {
            ...message,
            tools: message.tools.map((entry) => {
              return entry.id === toolId ? { ...entry, noteChangePending: true, noteChangeError: undefined } : entry
            }),
          }
        }),
      )
      try {
        const result = await applyAssistantChangeHistory(application, tool.noteChange, direction)
        setMessagesSynced((current) =>
          current.map((message) => {
            if (message.kind !== 'assistant') {
              return message
            }
            return {
              ...message,
              tools: message.tools.map((entry) => {
                return entry.id === toolId
                  ? { ...entry, noteChangePending: false, noteChangePosition: result.position }
                  : entry
              }),
            }
          }),
        )
      } catch (error) {
        setMessagesSynced((current) =>
          current.map((message) => {
            if (message.kind !== 'assistant') {
              return message
            }
            return {
              ...message,
              tools: message.tools.map((entry) => {
                return entry.id === toolId
                  ? {
                      ...entry,
                      noteChangePending: false,
                      noteChangeError: error instanceof Error ? error.message : String(error),
                    }
                  : entry
              }),
            }
          }),
        )
      }
    },
    [accountScope, application, setMessagesSynced],
  )

  const writeChatHistory = useCallback(async () => {
    const history = persistableHistoryRef.current
    const persist = runPersistenceRef.current
    const shared = sharedChatRef.current
    if (!shared && (!history || !persistenceAllowedRef.current || !persist)) {
      return
    }
    const checkpointSource = messagesRef.current
    const dirtyVersions = new Map(sharedDirtyIdsRef.current)
    const latestMessages: PersistedAssistantMessage[] = checkpointSource.map((message) => {
      if (message.kind === 'assistant') {
        return {
          kind: message.kind,
          id: message.id,
          text: message.text,
          activities: message.tools.map((tool) => ({
            id: tool.id,
            name: tool.name,
            // Persist only the static mapping, never argument-derived details.
            label: tool.persistedLabel ?? describeAssistantTool(tool.name, {}).label,
            ...(tool.authorization ? { authorization: tool.authorization } : {}),
            outcome: tool.outcome ?? 'interrupted',
            ...(tool.noteChange
              ? {
                  noteChange: {
                    ...tool.noteChange,
                    position: tool.noteChangePosition ?? 'after',
                  },
                }
              : {}),
          })),
        }
      }
      return message
    })
    const normalizedMessages = sanitizeAssistantChatMessages(latestMessages)
    for (const message of latestMessages) {
      if (
        message.attachments?.length &&
        JSON.stringify(normalizedMessages.find((item) => item.id === message.id)?.attachments) !==
          JSON.stringify(message.attachments)
      ) {
        throw new Error(
          'This conversation cannot retain another attachment safely. Remove earlier attachments or start a new chat.',
        )
      }
    }
    if (shared) {
      if (!sharedDirtyRef.current || !shared.ready) {
        return
      }
      if (runLeaseRef.current && !runLeaseRef.current.isCurrent()) {
        throw new Error('Chat generation ownership expired before checkpointing.')
      }
      const acknowledged = await shared.checkpoint(
        latestMessages,
        [...sessionToolDecisionsRef.current.entries()]
          .filter(([, decision]) => decision === false)
          .map(([name]) => name),
      )
      acknowledgeAssistantSharedVersions(sharedDirtyIdsRef.current, dirtyVersions)
      sharedDirtyRef.current = sharedDirtyIdsRef.current.size > 0
      if (acknowledged && mountedRef.current && sharedChatRef.current) {
        const current = messagesRef.current
        const merged = reconcileAssistantSharedMessages(
          hydrateAssistantHistory(acknowledged.messages),
          current,
          new Set(sharedDirtyIdsRef.current.keys()),
        )
        if (JSON.stringify(current) !== JSON.stringify(merged)) {
          messagesRef.current = merged
          setMessages(merged)
        }
      }
      return
    }
    try {
      const persisted = await persist!(() =>
        persistAssistantChatHistoryStrict(
          application.storage,
          history!.accountScope,
          history!.tabId,
          latestMessages,
          [...sessionToolDecisionsRef.current.entries()]
            .filter(([, decision]) => decision === false)
            .map(([name]) => name),
        ),
      )
      if (!persisted) {
        throw new Error('Assistant chat persistence ownership was lost before the write completed.')
      }
    } catch (error) {
      markHistoryPersistenceFailed()
      throw error
    }
  }, [application, markHistoryPersistenceFailed])
  historyWriterRef.current = writeChatHistory
  if (!historyCheckpointRef.current) {
    historyCheckpointRef.current = createAssistantChatHistoryCheckpoint(() => historyWriterRef.current())
  }

  const flushChatHistory = useCallback(async (): Promise<boolean> => {
    try {
      await historyCheckpointRef.current!.flush()
      return true
    } catch {
      markHistoryPersistenceFailed()
      return false
    }
  }, [markHistoryPersistenceFailed])

  useEffect(() => {
    if (!effectivePersistenceAllowed || !registerPersistenceFinalizer) {
      return
    }
    return registerPersistenceFinalizer(async () => {
      await flushChatHistory()
    })
  }, [effectivePersistenceAllowed, flushChatHistory, registerPersistenceFinalizer])

  const removeMessage = useCallback(
    async (messageId: string) => {
      const message = messagesRef.current.find((candidate) => candidate.id === messageId)
      if (!message || (message.kind === 'assistant' && message.streaming)) {
        return
      }
      const removalIdentity = conversationIdentityRef.current
      const removalSessionEpoch = sessionEpochRef.current
      const removalPrincipal = captureAssistantSessionPrincipal(application.sessions)

      if (message.kind === 'assistant' && message.tools.length > 0) {
        const includesNoteChanges = message.tools.some((tool) => tool.noteChange)
        let confirmed: boolean
        try {
          confirmed = await confirmDialog({
            title: 'Remove assistant message?',
            text: includesNoteChanges
              ? 'This message contains tool activity and note-change undo/redo history. Removing it hides that audit trail and its note-change controls from this chat.'
              : 'This message contains tool activity. Removing it hides that activity audit trail from this chat.',
            confirmButtonText: 'Remove',
            confirmButtonStyle: 'danger',
          })
        } catch {
          addToast({ type: ToastType.Error, message: 'Could not open the removal confirmation.' })
          return
        }
        if (!confirmed) {
          return
        }
      }

      const currentIdentity = conversationIdentityRef.current
      const currentMessage = messagesRef.current.find((candidate) => candidate.id === messageId)
      if (
        !mountedRef.current ||
        currentIdentity.accountScope !== removalIdentity.accountScope ||
        currentIdentity.tabId !== removalIdentity.tabId ||
        sessionEpochRef.current !== removalSessionEpoch ||
        !assistantSessionPrincipalMatches(removalPrincipal, captureAssistantSessionPrincipal(application.sessions)) ||
        currentMessage !== message ||
        (currentMessage.kind === 'assistant' && currentMessage.streaming)
      ) {
        return
      }

      const expectedDurableWrite = Boolean(
        persistenceAllowedRef.current && persistableHistoryRef.current && runPersistenceRef.current,
      )
      if (sharedChatRef.current?.removeMessage) {
        try {
          await sharedChatRef.current.removeMessage(messageId)
        } catch {
          await application.alerts.alert(
            'The message could not be removed from synced history. Try again when the connection is available.',
          )
          return
        }
      }
      setMessagesSynced((current) => current.filter((candidate) => candidate.id !== messageId))
      const persisted = await flushChatHistory()
      if (expectedDurableWrite && !persisted) {
        addToast({
          type: ToastType.Error,
          message: 'Message was removed from this session, but saved chat history could not be updated.',
        })
      }
    },
    [application, flushChatHistory, setMessagesSynced],
  )

  useEffect(() => {
    persistableHistoryRef.current = effectivePersistenceAllowed ? { accountScope, tabId } : null
    if (effectivePersistenceAllowed || sharedChatRef.current) {
      historyCheckpointRef.current!.schedule()
    }
  }, [accountScope, effectivePersistenceAllowed, messages, tabId])

  useEffect(
    () => () => {
      void flushChatHistory()
    },
    [flushChatHistory],
  )

  useEffect(() => {
    const flushBeforeSuspension = () => void flushChatHistory()
    const flushWhenHidden = () => {
      if (document.visibilityState === 'hidden') {
        flushBeforeSuspension()
      }
    }
    window.addEventListener('pagehide', flushBeforeSuspension)
    document.addEventListener('visibilitychange', flushWhenHidden)
    return () => {
      window.removeEventListener('pagehide', flushBeforeSuspension)
      document.removeEventListener('visibilitychange', flushWhenHidden)
    }
  }, [flushChatHistory])

  // Mirror the context selection so an in-flight run reads the latest scope
  // without re-creating runPrompt on every selection change.
  const contextSelectionRef = useRef<AssistantContextSelection>(contextSelection)
  contextSelectionRef.current = contextSelection
  const conversationModeRef = useRef(conversationMode)
  conversationModeRef.current = conversationMode
  const activeRunModeRef = useRef(conversationMode)

  const handleContextChange = useCallback(
    (next: AssistantContextSelection) => {
      setContextSelection((previous) => ({ ...next, excerpt: previous.excerpt }))
      persistAssistantContextScope(accountScope, next.scope)
    },
    [accountScope],
  )

  const resolveConfirmation = useCallback(
    (approved: boolean, rememberForThisChat = false) => {
      const request = pendingConfirmation?.request
      if (request) {
        recordToolAuthorization(request.callId, {
          decision: approved ? 'allow' : 'deny',
          source: rememberForThisChat ? 'user-chat' : 'user-once',
        })
      }
      if (rememberForThisChat && request) {
        if (!approved) {
          sessionToolDecisionsRef.current.set(request.name, false)
          historyCheckpointRef.current?.schedule()
        } else if (canPreflightAutoAllow(request)) {
          // "Allow all" selects the synced, safety-reviewed permission mode; it
          // never caches an approval that could bypass review for later args.
          sessionToolDecisionsRef.current.clear()
          historyCheckpointRef.current?.schedule()
          toolPermissionModeRef.current = 'allow-all'
          void Promise.all([
            application.setPreference(PrefKey.AssistantToolPermissionMode, 'allow-all'),
            // Older clients know only this boolean and cannot run the new
            // independent safety review, so they must continue asking.
            application.setPreference(
              PrefKey.AssistantConfirmBeforeWrite,
              legacyConfirmBeforeWriteForMode('allow-all'),
            ),
          ])
        }
      }
      const resolve = confirmationResolverRef.current
      confirmationResolverRef.current = null
      setPendingConfirmation(null)
      resolve?.(approved)
    },
    [application, pendingConfirmation, recordToolAuthorization],
  )

  const requestConfirmation = useCallback(
    (request: AssistantToolConfirmation, toolSignal?: AbortSignal) => {
      // The agent installs its combined user/deadline signal into AssistantTools.
      // Use it here so an expired run also cancels an in-flight safety review and
      // removes a stale approval card.
      const runSignal = toolSignal ?? abortRef.current?.signal
      const permissionMode = toolPermissionModeRef.current
      if (permissionMode === 'bypass') {
        if (!mountedRef.current || runSignal?.aborted) {
          return Promise.resolve(false)
        }
        recordToolAuthorization(request.callId, { decision: 'allow', source: 'policy' })
        return Promise.resolve(true)
      }
      const remembered = sessionToolDecisionsRef.current.get(request.name)
      if (remembered === false) {
        recordToolAuthorization(request.callId, { decision: 'deny', source: 'user-chat' })
        return Promise.resolve(false)
      }
      const ask = (reviewReason?: string) => {
        if (!mountedRef.current || runSignal?.aborted) {
          return Promise.resolve(false)
        }
        // Only one tool can be awaiting approval in a single agent run. Should a
        // provider violate that invariant, fail the older pending request closed.
        confirmationResolverRef.current?.(false)
        return new Promise<boolean>((resolve) => {
          let settled = false
          const finish = (approved: boolean) => {
            if (settled) {
              return
            }
            settled = true
            runSignal?.removeEventListener('abort', handleAbort)
            resolve(approved)
          }
          const handleAbort = () => {
            if (confirmationResolverRef.current === finish) {
              confirmationResolverRef.current = null
              if (mountedRef.current) {
                setPendingConfirmation(null)
              }
            }
            finish(false)
          }
          confirmationResolverRef.current = finish
          const presentation = describeAssistantToolConfirmation(request)
          setPendingConfirmation({
            presentation: reviewReason
              ? { ...presentation, detail: `${presentation.detail ?? ''} ${reviewReason}`.trim() }
              : presentation,
            request,
          })
          runSignal?.addEventListener('abort', handleAbort, { once: true })
          if (runSignal?.aborted) {
            handleAbort()
          }
        })
      }

      if (permissionMode === 'allow-all' && canPreflightAutoAllow(request) && preflightProviderRef.current) {
        return reviewAssistantAction(preflightProviderRef.current, request, {
          signal: runSignal,
          userIntent: runIntentRef.current,
        }).then((review) => {
          if (!mountedRef.current || runSignal?.aborted) {
            return false
          }
          if (toolPermissionModeRef.current !== 'allow-all') {
            if (toolPermissionModeRef.current === 'bypass') {
              recordToolAuthorization(request.callId, { decision: 'allow', source: 'policy' })
              return true
            }
            return ask('Permission mode changed while the safety check was running.')
          }
          if (review.decision === 'allow') {
            recordToolAuthorization(request.callId, { decision: 'allow', source: 'safety-review' })
            setSafetyReview(`Safety check: allowed — ${review.reason}`)
            return true
          }
          return ask(`Safety check: ${review.reason}`)
        })
      }
      return ask()
    },
    [recordToolAuthorization],
  )

  const shouldRequestConfirmation = useCallback((request: AssistantToolConfirmation, mutating: boolean) => {
    return shouldConfirmAssistantTool(toolPermissionModeRef.current, request, mutating)
  }, [])

  // A pane can be closed while its tool call is awaiting approval. Resolve the
  // outstanding promise so the agent run cannot remain suspended after unmount.
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      confirmationResolverRef.current?.(false)
      confirmationResolverRef.current = null
      abortRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    if (!isActive) {
      return
    }
    return application.items.addObserver(ContentType.TYPES.Note, () => {
      setContextItemsRevision((revision) => revision + 1)
    })
  }, [application, isActive])

  // Keep the disclosure preview live when notes or the active editor change,
  // without rescanning/extracting a large vault for every 40ms stream delta.
  // runPrompt separately builds a fresh context exactly once at send time.
  const contextOwnerKey = assistantContextOwnerKey(application, contextSelection.scope)
  useEffect(() => {
    if (!isActive) {
      return
    }
    const capture = () => {
      const excerpt = captureAssistantTextSelection(application)
      const anchor = document.getSelection()?.anchorNode
      const element = anchor?.nodeType === Node.ELEMENT_NODE ? (anchor as Element) : anchor?.parentElement
      const insideEditor = Boolean(element?.closest('[data-assistant-note-uuid]'))
      if (excerpt || insideEditor) {
        setContextSelection((previous) => {
          if (previous.excerpt?.noteUuid === excerpt?.noteUuid && previous.excerpt?.text === excerpt?.text) {
            return previous
          }
          return { ...previous, excerpt }
        })
      }
    }
    capture()
    document.addEventListener('selectionchange', capture)
    return () => document.removeEventListener('selectionchange', capture)
  }, [application, isActive, contextOwnerKey])

  useEffect(() => {
    if (!isActive || !['current-note', 'open-notes', 'selection'].includes(contextSelection.scope)) {
      return
    }
    let previous = contextOwnerKey
    return application.itemControllerGroup.addActiveControllerChangeObserver(() => {
      const next = assistantContextOwnerKey(application, contextSelection.scope)
      if (next !== previous) {
        previous = next
        setContextItemsRevision((revision) => revision + 1)
      }
    })
  }, [application, contextOwnerKey, contextSelection.scope, isActive])
  const contextPreview = useMemo(() => {
    // These lightweight revision keys intentionally invalidate the expensive
    // preview without becoming part of the returned disclosure payload.
    void contextItemsRevision
    void contextOwnerKey
    return isActive
      ? buildContextForSelection(application, contextSelection)
      : { scope: contextSelection.scope, noteCount: 0, characters: 0, truncated: false, noteTitles: [], noteUuids: [] }
  }, [application, contextItemsRevision, contextOwnerKey, contextSelection, isActive])
  useEffect(() => {
    if (isActive) {
      onContextSnapshot?.({
        noteUuids: contextPreview.noteUuids ?? [],
        ...(contextSelection.scope === 'selection' ? { selectedText: contextSelection.excerpt?.text ?? '' } : {}),
      })
    }
  }, [contextPreview, contextSelection, isActive, onContextSnapshot])

  // Assistant preferences are synced items rather than MobX observables. Keep
  // this mounted panel live when Preferences changes the endpoint/mode/model;
  // otherwise it keeps displaying the old "not configured" state and can send
  // one request with stale connection details.
  const [, setPreferenceRevision] = useState(0)
  useEffect(
    () =>
      application.addEventObserver(async (event) => {
        if (
          event === ApplicationEvent.PreferencesChanged ||
          event === ApplicationEvent.SignedIn ||
          event === ApplicationEvent.SignedOut ||
          event === ApplicationEvent.KeyStatusChanged
        ) {
          toolPermissionModeRef.current = application.getPreference(PrefKey.AssistantToolPermissionMode, 'allow-read')
          const nextPrincipal = captureAssistantSessionPrincipal(application.sessions)
          const accountChanged = !assistantSessionPrincipalMatches(observedPrincipalRef.current, nextPrincipal)
          observedPrincipalRef.current = nextPrincipal
          if (event === ApplicationEvent.KeyStatusChanged || accountChanged) {
            setChatTokenUsage(EMPTY_CHAT_TOKEN_USAGE)
            setTokenWindows(null)
            // Account changes and root-key changes are hard privacy boundaries.
            sessionEpochRef.current += 1
            queueRef.current = []
            steerQueueRef.current = []
            setQueue([])
            attachmentTaskRef.current += 1
            attachmentsRef.current = []
            setAttachments([])
            setAttachmentError('')
            setAttachmentsBusy(false)
            setProxyImagesAllowed(false)
            sessionToolDecisionsRef.current.clear()
            historyCheckpointRef.current?.schedule()
            confirmationResolverRef.current?.(false)
            confirmationResolverRef.current = null
            setPendingConfirmation(null)
            abortRef.current?.abort()
          }
          setPreferenceRevision((revision) => revision + 1)
          setAttachmentPreferenceRevision((revision) => revision + 1)
        }
      }),
    [application],
  )

  const [preferenceRevision, setAttachmentPreferenceRevision] = useState(0)
  const connectionMode = application.getPreference(PrefKey.AssistantConnectionMode, 'direct')
  const directAttachmentProfile = resolveActiveProfileOverrides(application)
  const imagesAllowed =
    connectionMode === 'proxy'
      ? proxyImagesAllowed
      : declaredDirectImageSupport(application, directAttachmentProfile.baseURL, directAttachmentProfile.model)
  useEffect(() => {
    let current = true
    setProxyImagesAllowed(false)
    if (connectionMode === 'proxy') {
      const principal = captureAssistantSessionPrincipal(application.sessions)
      void application
        .assistantConfigRequest<{
          supportsImageInputs?: boolean
          effectiveProfile?: { supportsImageInputs?: boolean }
        }>('/v1/assistant/config')
        .then((config) => {
          if (
            current &&
            assistantSessionPrincipalMatches(principal, captureAssistantSessionPrincipal(application.sessions))
          ) {
            setProxyImagesAllowed(
              config?.supportsImageInputs === true || config?.effectiveProfile?.supportsImageInputs === true,
            )
          }
        })
        .catch(() => undefined)
    }
    return () => {
      current = false
    }
  }, [application, connectionMode, preferenceRevision])
  const handleFiles = async (files: File[]) => {
    if (attachmentsBusy) {
      return
    }
    const task = ++attachmentTaskRef.current
    const principal = captureAssistantSessionPrincipal(application.sessions)
    setAttachmentsBusy(true)
    setAttachmentError('')
    try {
      if (files.length + attachmentsRef.current.length > 3) {
        throw new Error('Attach at most three files per message.')
      }
      const prepared = await Promise.all(files.map((file) => prepareAssistantAttachment(file, imagesAllowed)))
      if (
        !mountedRef.current ||
        task !== attachmentTaskRef.current ||
        !assistantSessionPrincipalMatches(principal, captureAssistantSessionPrincipal(application.sessions))
      ) {
        return
      }
      const next = [...attachmentsRef.current, ...prepared]
      assertAttachmentBudget([
        next,
        ...messagesRef.current.map((message) => (message.kind === 'user' ? message.attachments : undefined)),
        ...queueRef.current.map((request) => request.attachments),
      ])
      attachmentsRef.current = next
      setAttachments(next)
    } catch (error) {
      if (mountedRef.current && task === attachmentTaskRef.current) {
        setAttachmentError(error instanceof Error ? error.message : 'The attachment could not be read.')
      }
    } finally {
      if (mountedRef.current && task === attachmentTaskRef.current) {
        setAttachmentsBusy(false)
      }
    }
  }
  const toolPermissionMode = application.getPreference(PrefKey.AssistantToolPermissionMode, 'allow-read')
  toolPermissionModeRef.current = toolPermissionMode
  const previousToolPermissionModeRef = useRef(toolPermissionMode)
  const assistantAvailability = getSelectionAIAvailability(application)

  useEffect(() => {
    // Remembered per-chat decisions are valid only under the policy in which
    // they were made. Tightening or otherwise changing modes revokes them.
    if (previousToolPermissionModeRef.current !== toolPermissionMode) {
      sessionToolDecisionsRef.current.clear()
      historyCheckpointRef.current?.schedule()
      previousToolPermissionModeRef.current = toolPermissionMode
    }
  }, [toolPermissionMode])

  const refreshUsage = useCallback(async () => {
    if (connectionMode !== 'proxy') {
      setTokenWindows(null)
      return
    }
    const requestEpoch = sessionEpochRef.current
    const requestPrincipal = captureAssistantSessionPrincipal(application.sessions)
    try {
      const result = await application.assistantConfigRequest<AssistantUsageResponse>('/v1/assistant/usage')
      if (
        !mountedRef.current ||
        requestEpoch !== sessionEpochRef.current ||
        !assistantSessionPrincipalMatches(requestPrincipal, captureAssistantSessionPrincipal(application.sessions)) ||
        application.getPreference(PrefKey.AssistantConnectionMode, 'direct') !== 'proxy'
      ) {
        return
      }
      // Token windows are only present on servers that ship token metering; older
      // servers omit them and the meter simply hides.
      if (result?.tokens && (result.tokens.fiveHour || result.tokens.weekly)) {
        setTokenWindows({ fiveHour: result.tokens.fiveHour, weekly: result.tokens.weekly })
      } else {
        setTokenWindows(null)
      }
    } catch {
      // Usage display is best-effort; ignore failures.
    }
  }, [application, connectionMode])

  useEffect(() => {
    void refreshUsage()
  }, [refreshUsage])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages])

  const newId = () => Math.random().toString(36).slice(2)

  const runPrompt = useCallback(
    async (request: ConversationPrompt) => {
      if (request.attachments?.length) {
        try {
          const currentProfile = resolveActiveProfileOverrides(application)
          const capability =
            application.getPreference(PrefKey.AssistantConnectionMode, 'direct') === 'proxy'
              ? proxyImagesAllowed
              : declaredDirectImageSupport(application, currentProfile.baseURL, currentProfile.model)
          if (attachmentImages(request.attachments).length && !capability) {
            throw new Error(
              'Image input is not enabled for the current model. Remove the image or choose a confirmed image-capable model.',
            )
          }
          assertAttachmentBudget([
            request.attachments,
            ...messagesRef.current.map((message) => (message.kind === 'user' ? message.attachments : undefined)),
          ])
        } catch (error) {
          setMessagesSynced((previous) => [
            ...previous,
            {
              kind: 'error',
              id: newId(),
              text: error instanceof Error ? error.message : 'Attachment validation failed.',
            },
          ])
          if (!attachmentsRef.current.length) {
            attachmentsRef.current = request.attachments
            setAttachments(request.attachments)
          }
          return
        }
      }
      const runMode = request.mode ?? conversationModeRef.current
      request = { ...request, mode: runMode }
      // React state is not a mutex. Two same-tick callers can both observe
      // `isRunning=false`; the live controller is the synchronous owner token.
      if (abortRef.current) {
        if (!abortRef.current.signal.aborted) {
          queueRef.current = [...queueRef.current, request]
          setQueue(queueRef.current)
        }
        return
      }
      activeRunModeRef.current = runMode
      const promptText = request.providerPrompt
      const runPrincipal = captureAssistantSessionPrincipal(application.sessions)
      const runSessionEpoch = sessionEpochRef.current
      const isSessionCurrent = () =>
        runSessionEpoch === sessionEpochRef.current &&
        assistantSessionPrincipalMatches(runPrincipal, captureAssistantSessionPrincipal(application.sessions)) &&
        (!runLeaseRef.current || runLeaseRef.current.isCurrent())
      if (!runPrincipal.valid || !isSessionCurrent()) {
        setMessagesSynced((prev) => [
          ...prev,
          { kind: 'error', id: newId(), text: 'The assistant could not verify the active account for this request.' },
        ])
        return
      }
      const assistantSettingsScope = getAssistantAccountScope(application)
      if (!assistantSettingsScope) {
        setMessagesSynced((prev) => [
          ...prev,
          { kind: 'error', id: newId(), text: 'The assistant could not isolate settings for the active account.' },
        ])
        return
      }
      const runPersona = getPersona(assistantSettingsScope)
      const runSampling = loadSamplingSettings(assistantSettingsScope)
      const availability = getSelectionAIAvailability(application)
      if (!availability.available) {
        setMessagesSynced((prev) => [
          ...prev,
          { kind: 'error', id: newId(), text: availability.reason || 'The assistant is not configured.' },
        ])
        return
      }

      const currentAccountScope = application.sessions.getUser()?.uuid ?? `anonymous:${application.identifier}`
      if (request.directive && request.directive.accountScope !== currentAccountScope) {
        setMessagesSynced((prev) => [
          ...prev,
          { kind: 'error', id: newId(), text: 'That editor request expired when the signed-in account changed.' },
        ])
        return
      }

      let confirmBeforeWrite = application.getPreference(PrefKey.AssistantConfirmBeforeWrite, true)
      const activeContextSelection: AssistantContextSelection = request.directive
        ? {
            scope: 'collection',
            collection: { type: 'notes', uuids: request.directive.noteUuid ? [request.directive.noteUuid] : [] },
          }
        : contextSelectionRef.current
      const resolvedNoteUuids = new Set(resolveContextNoteUuids(application, activeContextSelection))
      if (request.directive?.noteUuid && !resolvedNoteUuids.has(request.directive.noteUuid)) {
        setMessagesSynced((prev) => [
          ...prev,
          {
            kind: 'error',
            id: newId(),
            text: 'The source note changed or is no longer available, so the Assistant directive was not sent.',
          },
        ])
        return
      }
      try {
        for (const noteUuid of resolvedNoteUuids) {
          await flushAssistantNoteEditors(application, noteUuid)
        }
      } catch {
        setMessagesSynced((prev) => [
          ...prev,
          {
            kind: 'error',
            id: newId(),
            text: 'The assistant could not safely flush the selected note context. Save the note and try again.',
          },
        ])
        return
      }
      if (!isSessionCurrent()) {
        return
      }
      const expectedNoteSnapshots = new Map<string, ReturnType<typeof captureAssistantNoteSnapshot>>()
      for (const noteUuid of resolvedNoteUuids) {
        const selected = application.items.findItem<SNNote>(noteUuid)
        if (selected && isNote(selected) && application.isAuthorizedToRenderItem(selected)) {
          expectedNoteSnapshots.set(noteUuid, captureAssistantNoteSnapshot(selected))
        }
      }
      // Editor directives authorize disclosure of the visible selection only.
      // The source UUID validates that attachment but does not grant a model
      // permission to read or mutate the rest of the note through tools.
      const selectedNoteUuids =
        request.directive || activeContextSelection.scope === 'selection' ? new Set<string>() : resolvedNoteUuids
      // A selection directive visibly attaches only the selected excerpt. Its
      // note UUID validates the source only; it grants neither model context nor
      // tool access to the rest of that note.
      let builtContext = request.directive
        ? buildContextForSelection(application, {
            scope: 'collection',
            collection: { type: 'notes', uuids: [] },
          })
        : buildContextForSelection(application, activeContextSelection)

      // Achievements: one validated user message sent to the AI assistant (web-local).
      achievements.increment(METRICS.aiAssistantMessages)
      runIntentRef.current = promptText

      const controller = new AbortController()
      abortRef.current = controller
      setIsRunning(true)
      const shared = sharedChatRef.current
      if (shared) {
        try {
          if (!shared.ready) {
            throw new Error('Your encrypted chat history is still loading. Try again shortly.')
          }
          const guard = await acquireAssistantChatRun(application, tabId, controller)
          runLeaseRef.current = guard
          const canonical = await shared.refresh()
          if (shared.history && !canonical) {
            throw new Error('This chat was deleted on another device.')
          }
          for (const noteUuid of resolvedNoteUuids) {
            await flushAssistantNoteEditors(application, noteUuid)
          }
          const freshScope = new Set(resolveContextNoteUuids(application, activeContextSelection))
          if (
            !isSessionCurrent() ||
            freshScope.size !== resolvedNoteUuids.size ||
            [...freshScope].some((uuid) => !resolvedNoteUuids.has(uuid))
          ) {
            throw new Error(
              'The selected note context changed while this chat was connecting. Review the context and send again.',
            )
          }
          expectedNoteSnapshots.clear()
          for (const noteUuid of freshScope) {
            const selected = application.items.findItem<SNNote>(noteUuid)
            if (selected && isNote(selected) && application.isAuthorizedToRenderItem(selected)) {
              expectedNoteSnapshots.set(noteUuid, captureAssistantNoteSnapshot(selected))
            }
          }
          builtContext = request.directive
            ? buildContextForSelection(application, { scope: 'collection', collection: { type: 'notes', uuids: [] } })
            : buildContextForSelection(application, activeContextSelection)
          confirmBeforeWrite = application.getPreference(PrefKey.AssistantConfirmBeforeWrite, true)
          if (canonical && isSessionCurrent()) {
            const restored = hydrateAssistantHistory(canonical.messages)
            messagesRef.current = restored
            setMessages(restored)
            for (const name of canonical.deniedToolNames) {
              sessionToolDecisionsRef.current.set(name, false)
            }
          }
          if (!isSessionCurrent() || controller.signal.aborted) {
            await guard.release()
            runLeaseRef.current = null
            if (abortRef.current === controller) {
              abortRef.current = null
            }
            setIsRunning(false)
            return
          }
        } catch (error) {
          await runLeaseRef.current?.release()
          runLeaseRef.current = null
          if (abortRef.current === controller) {
            abortRef.current = null
          }
          setIsRunning(false)
          if (isSessionCurrent()) {
            setMessagesSynced((previous) => [
              ...previous,
              {
                kind: 'error',
                id: newId(),
                text: error instanceof Error ? error.message : 'Could not reserve this chat.',
              },
            ])
          }
          return
        }
      }
      const assistantId = newId()

      // History is the transcript BEFORE this prompt (read from the synced ref so
      // a queued run sees the previous run's messages).
      const priorHistory = boundProviderHistory(
        messagesRef.current.flatMap((message): AgentChatMessage[] => {
          if (message.kind === 'user') {
            return [
              {
                role: 'user',
                content: attachmentUserText(message.text, message.attachments),
                ...(attachmentImages(message.attachments).length
                  ? { images: attachmentImages(message.attachments) }
                  : {}),
              },
            ]
          }
          if (message.kind === 'assistant' && message.text) {
            return [{ role: 'assistant', content: message.text }]
          }
          return []
        }),
        Math.max(4_000, DEFAULT_PROVIDER_HISTORY_CHARACTER_BUDGET - builtContext.characters),
      )

      const messagesWithTurn: UIMessage[] = [
        ...messagesRef.current,
        {
          kind: 'user',
          id: newId(),
          text: promptText,
          ...(request.attachments?.length ? { attachments: request.attachments } : {}),
        },
        { kind: 'assistant', id: assistantId, text: '', tools: [], streaming: true },
      ]
      setMessagesSynced(() => messagesWithTurn)
      setTodos([])
      setSafetyReview(null)
      setIsRunning(true)
      // Make the user's turn durable before the provider request begins; later
      // streaming changes are checkpointed on a bounded throttle.
      const initiallyPersisted = await flushChatHistory()
      if (
        ((shared || messagesWithTurn.some((message) => message.kind === 'user' && message.attachments?.length)) &&
          !initiallyPersisted) ||
        !isSessionCurrent() ||
        controller.signal.aborted ||
        abortRef.current !== controller
      ) {
        await runLeaseRef.current?.release()
        runLeaseRef.current = null
        if (abortRef.current === controller) {
          abortRef.current = null
        }
        if (mountedRef.current) {
          setIsRunning(false)
        }
        return
      }

      let activeAssistantId = assistantId
      let hasActiveText = false
      let hasRunText = false
      let textAfterTools = false
      let actionDenied = false
      let waitingForSteeredResponse = false
      const updateAssistant = (updater: (message: Extract<UIMessage, { kind: 'assistant' }>) => void) => {
        setMessagesSynced((prev) => {
          const existingIndex = prev.findIndex(
            (message) => message.id === activeAssistantId && message.kind === 'assistant',
          )
          if (existingIndex < 0) {
            const next: Extract<UIMessage, { kind: 'assistant' }> = {
              kind: 'assistant',
              id: activeAssistantId,
              text: '',
              tools: [],
              streaming: true,
            }
            updater(next)
            return [...prev, next]
          }
          return prev.map((message, index) => {
            if (index === existingIndex && message.kind === 'assistant') {
              const next = { ...message, tools: [...message.tools] }
              updater(next)
              return next
            }
            return message
          })
        })
      }
      const textDeltas = createAssistantTextDeltaBatcher((text) => {
        if (!isSessionCurrent()) {
          return
        }
        updateAssistant((message) => {
          message.text += text
        })
      })
      const beginSteeredResponse = () => {
        textDeltas.flush()
        updateAssistant((message) => {
          message.streaming = false
        })
        activeAssistantId = newId()
        hasActiveText = false
        textAfterTools = false
      }
      const finishRunActivities = () => {
        const activityIds = new Set(activeToolActivityIdsRef.current.values())
        setMessagesSynced((current) =>
          current.map((message) => {
            if (message.kind !== 'assistant') {
              return message
            }
            if (message.id !== activeAssistantId && !message.tools.some((tool) => activityIds.has(tool.id))) {
              return message
            }
            return {
              ...message,
              streaming: false,
              tools: message.tools.map((tool) => {
                return activityIds.has(tool.id) && tool.outcome === undefined
                  ? { ...tool, outcome: 'interrupted' as const }
                  : tool
              }),
            }
          }),
        )
      }

      const baseProvider = buildAssistantProvider(application, controller.signal, runLeaseRef.current?.proof)
      const agentProvider: Provider = observeProviderTokenUsage(
        runLeaseRef.current ? serializeAssistantProvider(baseProvider) : baseProvider,
        (usage) => {
          if (mountedRef.current && isSessionCurrent()) {
            setChatTokenUsage((current) => accumulateChatTokenUsage(current, usage))
          }
        },
      )
      preflightProviderRef.current = agentProvider

      // Sub-agent runner backing the "delegate" tool: a focused nested run that
      // shares the provider and tools but cannot itself delegate (recursion guard).
      const runSubAgent = async (task: string, contextText?: string): Promise<string> => {
        // Sub-agents share the tools but report neither todos nor delegation to the
        // UI (the top-level run owns the visible plan).
        const subContext: AssistantToolContext = {
          ...toolContext,
          allowMutatingTools: false,
          onAuthorization: undefined,
          onTodosChanged: undefined,
          onNoteChange: undefined,
        }
        const subTools = new AssistantTools(application, subContext, false)
        const subPrompt = contextText ? `${task}\n\nContext:\n${contextText}` : task
        const sub = await run([{ role: 'user', content: subPrompt }], {
          provider: agentProvider,
          session: subTools,
          systemPrompt: composeSystemPromptWithPersona(SUB_AGENT_SYSTEM_PROMPT, runPersona),
          maxSteps: 6,
          signal: controller.signal,
        })
        if (sub.errorCode === 'ACTION_NOT_ALLOWED') {
          throw new AssistantActionNotAllowedError(sub.finalText)
        }
        return sub.finalText || '(sub-agent finished with no summary)'
      }

      const toolContext: AssistantToolContext = {
        allowMutatingTools: runMode !== 'plan' && runMode !== 'chat',
        selectedNoteUuids,
        expectedNoteSnapshots,
        getAssistantMessageId: () => activeAssistantId,
        assistantRunId: assistantId,
        isSessionCurrent,
        confirmBeforeWrite,
        requestConfirmation,
        shouldRequestConfirmation,
        onAuthorization: recordToolAuthorization,
        presentPane: (paneId: AppPaneId) => presentPane(paneId),
        runSubAgent,
        onTodosChanged: (next) => setTodos(next),
        onNoteChange: (callId, change) => {
          if (!callId || !isSessionCurrent()) {
            return
          }
          const activityId = activeToolActivityIdsRef.current.get(callId)
          if (!activityId) {
            return
          }
          setMessagesSynced((current) =>
            retainNewestAssistantNoteChanges(
              current.map((message) => {
                if (message.kind !== 'assistant' || !message.tools.some((entry) => entry.id === activityId)) {
                  return message
                }
                return {
                  ...message,
                  tools: message.tools.map((entry) => {
                    return entry.id === activityId
                      ? {
                          ...entry,
                          noteChange: change,
                          noteChangePosition: 'after',
                          noteChangeError: undefined,
                        }
                      : entry
                  }),
                }
              }),
            ),
          )
        },
      }

      const tools = new AssistantTools(application, toolContext)
      activeToolActivityIdsRef.current.clear()

      // Assemble the user-chosen context (current note / all notes / collection)
      // and append it to the system prompt so the model can answer about the
      // selected notes without first calling tools. Bounded by a character budget
      // inside buildAssistantContext so broad scopes can't blow the token budget.
      // Layer the user's persona (style only) onto the immutable safety base prompt
      // FIRST, then append the note context. The persona can never override the
      // safety/anti-injection rules baked into ASSISTANT_SYSTEM_PROMPT (enforced by
      // composeSystemPromptWithPersona).
      const basePrompt = composeSystemPromptWithPersona(ASSISTANT_SYSTEM_PROMPT, runPersona)
      const systemPrompt = builtContext.text
        ? `${basePrompt}\n\n${wrapUntrustedNoteContext(builtContext.text)}`
        : basePrompt

      try {
        const result = await runConversationMode(
          runMode,
          [
            ...priorHistory,
            {
              role: 'user',
              content: attachmentUserText(promptText, request.attachments),
              ...(attachmentImages(request.attachments).length
                ? { images: attachmentImages(request.attachments) }
                : {}),
            },
          ],
          {
            provider: agentProvider,
            session: tools,
            systemPrompt,
            maxSteps: runSampling.maxSteps,
            maxRunTimeMs: getMaxRunTimeMs(runSampling),
            signal: controller.signal,
            control: {
              // Drain and inject any steering messages queued during this run.
              drainSteers: () => {
                const pending = steerQueueRef.current
                steerQueueRef.current = []
                return pending
              },
            },
            onTextDelta: (delta) => {
              if (!isSessionCurrent() || !delta) {
                return
              }
              if (textAfterTools && hasActiveText) {
                textDeltas.push('\n\n')
              }
              textAfterTools = false
              hasActiveText = true
              hasRunText = true
              waitingForSteeredResponse = false
              textDeltas.push(delta)
            },
            onSteer: () => {
              if (!isSessionCurrent()) {
                return
              }
              // The steer bubble is inserted immediately when the user submits it.
              // Start the model's revised response in a fresh assistant bubble so
              // it cannot be concatenated ahead of that user guidance. Multiple
              // steers drained at one boundary still share one response bubble.
              if (!waitingForSteeredResponse) {
                beginSteeredResponse()
                waitingForSteeredResponse = true
              }
            },
            onToolCall: (call) => {
              if (!isSessionCurrent()) {
                return
              }
              waitingForSteeredResponse = false
              textDeltas.flush()
              textAfterTools = true
              const activityId = newId()
              activeToolActivityIdsRef.current.set(call.id, activityId)
              updateAssistant((message) =>
                message.tools.push({ id: activityId, providerCallId: call.id, name: call.name, args: call.args }),
              )
            },
            onToolResult: (callId, _toolResult, outcome) => {
              if (!isSessionCurrent()) {
                return
              }
              const activityId = activeToolActivityIdsRef.current.get(callId)
              if (activityId) {
                setMessagesSynced((current) =>
                  current.map((message) => {
                    if (message.kind !== 'assistant' || !message.tools.some((tool) => tool.id === activityId)) {
                      return message
                    }
                    return {
                      ...message,
                      tools: message.tools.map((tool) => {
                        return tool.id === activityId ? { ...tool, outcome } : tool
                      }),
                    }
                  }),
                )
              }
            },
          },
          {
            application,
            prompt: request.directive?.instruction ?? request.providerPrompt,
            contextText: attachmentUserText(
              request.directive?.selectedText ?? builtContext.text ?? '',
              request.attachments,
            ),
            images: attachmentImages(request.attachments),
            isCurrent: isSessionCurrent,
            requestWebConfirmation: async (action, value) => {
              const name = action === 'search' ? 'web.search' : 'web.fetch'
              if (sessionToolDecisionsRef.current.get(name) === false || !isSessionCurrent()) {
                return false
              }
              const approved = await confirmDialog({
                title: action === 'search' ? 'Search the web for this research?' : 'Read this web page?',
                text: `${action === 'search' ? 'Search query' : 'Page URL'}: ${value}\n\nThis is sent outside end-to-end encryption to your server and its configured web service. Retrieved text is sent to your AI provider.`,
                confirmButtonText: action === 'search' ? 'Search' : 'Read page',
              })
              return approved && isSessionCurrent() && !controller.signal.aborted
            },
          },
        )

        if (!isSessionCurrent()) {
          const expired = new Error('Assistant operation expired when the signed-in account changed.')
          expired.name = 'AbortError'
          throw expired
        }

        textDeltas.flush()
        actionDenied = result.errorCode === 'ACTION_NOT_ALLOWED'
        updateAssistant((message) => {
          message.streaming = false
          // An abort just after steering can return the previous response's
          // text. Keep that text in its original bubble instead of repeating it.
          if (result.stopReason !== 'error' && !message.text && (!hasRunText || hasActiveText)) {
            message.text = result.finalText
          }
        })
        finishRunActivities()

        if (result.stopReason === 'error') {
          setMessagesSynced((prev) => [
            ...prev,
            { kind: 'error', id: newId(), text: result.finalText || 'The assistant encountered an error.' },
          ])
        }
      } catch (error) {
        textDeltas.flush()
        if (isSessionCurrent()) {
          finishRunActivities()
          setMessagesSynced((prev) => [
            ...prev,
            { kind: 'error', id: newId(), text: error instanceof Error ? error.message : String(error) },
          ])
        }
      } finally {
        textDeltas.dispose()
        // This run retains ownership through the durable terminal checkpoint.
        // Otherwise the UI can start another run while this finally block is
        // awaiting storage, and the older block can clear/consume the new run's
        // refs or queue.
        await flushChatHistory()
        await runLeaseRef.current?.release()
        runLeaseRef.current = null
        if (abortRef.current === controller) {
          abortRef.current = null
          preflightProviderRef.current = null
          runIntentRef.current = ''
          activeToolActivityIdsRef.current.clear()
          if (isSessionCurrent()) {
            void refreshUsage()
          }
          // Chain into the next queued prompt unless the user interrupted.
          if (isSessionCurrent() && !controller.signal.aborted && !actionDenied && queueRef.current.length > 0) {
            const [next, ...rest] = queueRef.current
            queueRef.current = rest
            setQueue(rest)
            // The handoff is synchronous: React batches this with the next run's
            // `true`, while an early validation failure still leaves the UI idle.
            setIsRunning(false)
            void runPromptRef.current?.(next)
          } else if (mountedRef.current) {
            setIsRunning(false)
          }
        }
      }
    },
    [
      application,
      tabId,
      flushChatHistory,
      presentPane,
      refreshUsage,
      proxyImagesAllowed,
      requestConfirmation,
      recordToolAuthorization,
      setMessagesSynced,
      shouldRequestConfirmation,
    ],
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

  useEffect(() => {
    if (!directive || consumedDirectiveIdsRef.current.has(directive.id)) {
      return
    }
    consumedDirectiveIdsRef.current.add(directive.id)
    if (consumedDirectiveIdsRef.current.size > 32) {
      consumedDirectiveIdsRef.current.delete(consumedDirectiveIdsRef.current.values().next().value!)
    }

    const activeAccountScope = application.sessions.getUser()?.uuid ?? `anonymous:${application.identifier}`
    if (directive.accountScope !== activeAccountScope) {
      onDirectiveConsumed?.(directive.id)
      return
    }

    setContextSelection(
      directive.contextKind === 'note'
        ? { scope: 'collection', collection: { type: 'notes', uuids: directive.noteUuid ? [directive.noteUuid] : [] } }
        : {
            scope: 'selection',
            excerpt: directive.noteUuid ? { noteUuid: directive.noteUuid, text: directive.selectedText } : undefined,
          },
    )
    notifyFirstMessage(directive.instruction)
    if (isRunning) {
      queueRef.current = [
        ...queueRef.current,
        { providerPrompt: directive.providerPrompt, directive, mode: conversationModeRef.current },
      ]
      setQueue(queueRef.current)
    } else {
      void runPromptRef.current?.({ providerPrompt: directive.providerPrompt, directive })
    }
    onDirectiveConsumed?.(directive.id)
  }, [application, directive, isRunning, notifyFirstMessage, onDirectiveConsumed])

  const handleSend = useCallback(() => {
    const trimmed = input.trim()
    if ((!trimmed && !attachments.length) || isRunning || attachmentsBusy) {
      return
    }
    notifyFirstMessage(trimmed)
    setInput('')
    const sent = attachmentsRef.current
    attachmentsRef.current = []
    setAttachments([])
    void runPrompt({ providerPrompt: trimmed, attachments: sent })
  }, [input, attachments, attachmentsBusy, isRunning, notifyFirstMessage, runPrompt])

  // Steer: inject guidance into the in-flight run without restarting it.
  const handleSteer = useCallback(() => {
    const trimmed = input.trim()
    if (!trimmed || !isRunning || attachmentsRef.current.length) {
      return
    }
    steerQueueRef.current = [...steerQueueRef.current, trimmed]
    runIntentRef.current = trimmed
    setMessagesSynced((prev) => [...prev, { kind: 'user', id: newId(), text: trimmed, steered: true }])
    setInput('')
  }, [input, isRunning, setMessagesSynced])

  // Queue: line up a follow-up prompt to run after the current one finishes.
  const handleQueue = useCallback(() => {
    const trimmed = input.trim()
    if ((!trimmed && !attachments.length) || attachmentsBusy) {
      return
    }
    notifyFirstMessage(trimmed)
    const sent = attachmentsRef.current
    attachmentsRef.current = []
    setAttachments([])
    queueRef.current = [
      ...queueRef.current,
      { providerPrompt: trimmed, mode: conversationModeRef.current, attachments: sent },
    ]
    setQueue(queueRef.current)
    setInput('')
  }, [input, attachments, attachmentsBusy, notifyFirstMessage])

  const dismissNotice = useCallback(
    (choice: NoticeDismissalChoice) => {
      persistAssistantNoticeDismissed(accountScope, choice)
      const remembered = readAssistantNoticeDismissed(accountScope)
      // Storage-disabled/full browsers can still dismiss this mounted chat.
      setNoticeSessionDismissed(choice === 'once' || !remembered)
      setNoticeStoredDismissed(remembered)
      window.dispatchEvent(new CustomEvent('assistant-notice-changed', { detail: { accountScope } }))
      setNoticeDismissalOpen(false)
    },
    [accountScope],
  )

  const removeQueued = useCallback((index: number) => {
    queueRef.current = queueRef.current.filter((_, i) => i !== index)
    setQueue(queueRef.current)
  }, [])

  // Interrupt: abort the current run and drop any pending steers/queue.
  const handleStop = useCallback(() => {
    queueRef.current = []
    setQueue([])
    steerQueueRef.current = []
    resolveConfirmation(false)
    abortRef.current?.abort()
  }, [resolveConfirmation])

  const isConfigured = assistantAvailability.available

  // A short, human-readable summary of what the active scope would send, shared
  // by the inline warning and the data-exposure notice so the user always knows
  // how much note content reaches the AI provider.
  const contextSummary = describeContextPreview(contextPreview)

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {historyPersistenceFailed && (
        <div className="border-warning bg-warning-faded text-text border-b px-3 py-2 text-xs">
          Saved chat history could not be read safely. This conversation is temporarily in-memory and will not overwrite
          the saved copy.
        </div>
      )}
      {todos.length > 0 && (
        <div className="border-border bg-default border-b px-4 py-2">
          <div className="text-passive-1 mb-1 text-xs font-semibold tracking-wide uppercase">Plan</div>
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
                    todo.status === 'in_progress' && 'text-text font-medium',
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

      <div ref={scrollRef} className="min-h-0 flex-grow overflow-y-auto px-3 py-3">
        {messages.length === 0 && recentChats}
        {!noticeDismissed && (
          <div className="border-warning bg-warning-faded mb-4 rounded border border-solid p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="text-warning text-sm font-semibold">
                Your messages and note content are sent to an AI provider
              </div>
              <button
                className="text-warning hover:bg-warning-faded -mt-1 -mr-1 flex-shrink-0 rounded p-1"
                onClick={() => setNoticeDismissalOpen(true)}
                aria-label="Dismiss notice"
                title="Dismiss"
              >
                <Icon type="close" size="small" />
              </button>
            </div>
            <div className="text-warning mt-1 text-sm">
              Tools run locally in your browser, but model calls do not. Whatever you type and any note content the
              assistant reads is sent to your configured AI provider, which may expose information you did not intend to
              share — especially with cloud providers. Web search and fetch also send the approved query or URL through
              your server to its configured search service.
            </div>
            <div className="text-warning mt-2 text-sm font-semibold">{contextSummary}</div>
          </div>
        )}
        {!isConfigured && (
          <div className="border-border bg-contrast text-neutral mb-4 rounded border p-3 text-sm">
            {assistantAvailability.reason ||
              'The assistant is not configured yet. Open Preferences → Assistant to choose a connection.'}
          </div>
        )}
        {messages.length === 0 && isConfigured && (
          <div className="text-passive-0 text-sm">
            Ask the assistant to find, summarize, create, or organize your notes.
          </div>
        )}
        <div className="flex flex-col gap-2.5">
          {messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              onApplyNoteChange={applyNoteChangeHistory}
              onRemoveMessage={removeMessage}
            />
          ))}
          {pendingConfirmation && (
            <InlineAssistantConfirmation
              confirmation={pendingConfirmation.presentation}
              irreversible={isIrreversibleAssistantTool(pendingConfirmation.request)}
              canAllowAll={canPreflightAutoAllow(pendingConfirmation.request)}
              onResolve={resolveConfirmation}
            />
          )}
          {safetyReview && (
            <div className="border-info bg-info-faded text-info max-w-[85%] self-start rounded border px-3 py-2 text-xs">
              {safetyReview}
            </div>
          )}
        </div>
      </div>

      <div className="border-border bg-contrast shrink-0 border-t px-3 py-2">
        <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
          <ContextSelector
            application={application}
            selection={contextSelection}
            onChange={handleContextChange}
            disabled={isRunning}
          />
          <label className="flex max-w-full min-w-0 flex-wrap items-center gap-1 text-xs">
            <span className="text-passive-1 shrink-0 text-[11px] font-medium">Tools</span>
            <select
              className="border-border bg-default text-text w-28 max-w-full min-w-0 rounded border px-1.5 py-0.5 text-[11px]"
              title="Choose whether tools ask first, allow reads, allow safe changes, review every action, or bypass confirmations."
              value={toolPermissionMode}
              onChange={(event) => {
                const next = event.target.value as typeof toolPermissionMode
                sessionToolDecisionsRef.current.clear()
                historyCheckpointRef.current?.schedule()
                toolPermissionModeRef.current = next
                void Promise.all([
                  application.setPreference(PrefKey.AssistantToolPermissionMode, next),
                  // Every richer mode fails safe on older clients, which understand
                  // only the legacy ask-before-write boolean.
                  application.setPreference(PrefKey.AssistantConfirmBeforeWrite, legacyConfirmBeforeWriteForMode(next)),
                ])
              }}
              aria-label="Assistant tool permissions"
            >
              <option value="ask">Ask each time</option>
              <option value="allow-read">Reads allowed</option>
              <option value="allow-safe">Safe changes</option>
              <option value="allow-all">All + review</option>
              <option value="bypass">No prompts</option>
            </select>
          </label>
          <AssistantModeSelector
            value={isRunning ? activeRunModeRef.current : conversationMode}
            onChange={(mode) => {
              if (!abortRef.current) {
                onModeChange?.(mode)
              }
            }}
            disabled={isRunning}
          />
        </div>
        {!noticeDismissed && (
          <div className="text-warning mb-2 flex items-start gap-2 text-xs">
            <div className="min-w-0 flex-1">
              Messages and note content the assistant reads are sent to your configured AI provider. Web access always
              asks before contacting your server&rsquo;s configured search service. {contextSummary}
            </div>
            <button
              type="button"
              className="hover:bg-warning-faded shrink-0 rounded p-0.5 focus-visible:outline focus-visible:outline-2"
              aria-label="Hide AI privacy reminder"
              onClick={() => setNoticeDismissalOpen(true)}
            >
              <Icon type="close" size="small" />
            </button>
          </div>
        )}
        {queue.length > 0 && (
          <div className="mb-2 flex flex-col gap-1">
            {queue.map((item, index) => (
              <div
                key={index}
                className="border-border bg-default text-passive-0 flex items-center justify-between gap-2 rounded border px-2 py-1 text-xs"
              >
                <span className="truncate">
                  <span className="text-neutral mr-1 font-semibold">Queued:</span>
                  {parseAssistantDirectivePrompt(item.providerPrompt)?.instruction ?? item.providerPrompt}
                </span>
                <button
                  className="hover:bg-contrast rounded p-0.5"
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
        <AssistantComposer
          attachments={attachments}
          attachmentError={attachmentError}
          attachmentsBusy={attachmentsBusy}
          imagesAllowed={imagesAllowed}
          onFiles={(files) => void handleFiles(files)}
          onRemoveAttachment={(index) => {
            const next = attachmentsRef.current.filter((_, item) => item !== index)
            attachmentsRef.current = next
            setAttachments(next)
            setAttachmentError('')
          }}
          input={input}
          running={isRunning}
          configured={isConfigured}
          allowSteering={
            (isRunning ? activeRunModeRef.current : conversationMode) !== 'research' &&
            (isRunning ? activeRunModeRef.current : conversationMode) !== 'deep-research'
          }
          onInput={setInput}
          onSend={handleSend}
          onSteer={handleSteer}
          onQueue={handleQueue}
          onStop={handleStop}
        />
        <AssistantUsageMeter
          fiveHour={tokenWindows?.fiveHour}
          weekly={tokenWindows?.weekly}
          chat={chatTokenUsage}
          className="border-border mt-2 border-t pt-2"
        />
      </div>
      {noticeDismissalOpen && (
        <AssistantNoticeDismissal onSelect={dismissNotice} onClose={() => setNoticeDismissalOpen(false)} />
      )}
    </div>
  )
}

export const MessageBubble = ({
  message,
  onApplyNoteChange,
  onRemoveMessage,
}: {
  message: UIMessage
  onApplyNoteChange: (toolId: string, direction: AssistantNoteChangeDirection) => void
  onRemoveMessage: (messageId: string) => void | Promise<void>
}) => {
  if (message.kind === 'user') {
    const directive = parseAssistantDirectivePrompt(message.text)
    return (
      <AssistantMessageActions message={message} onRemoveMessage={onRemoveMessage}>
        {(messageTextRef) => (
          <div className="bg-info text-info-contrast min-w-0 rounded-lg px-2.5 py-1.5 text-sm leading-5">
            {message.attachments?.length ? <AttachmentPreview attachments={message.attachments} /> : null}
            {message.steered && <div className="mb-0.5 text-xs font-semibold opacity-80">↳ Steer</div>}
            {directive ? (
              <div ref={messageTextRef} className="flex flex-col gap-2">
                <div className="font-medium whitespace-pre-wrap">{directive.instruction}</div>
                <div className="border-info-contrast/30 bg-info-contrast/10 max-h-48 overflow-y-auto rounded border px-2 py-1.5 text-xs whitespace-pre-wrap">
                  <div className="mb-1 font-semibold opacity-80">Selected text</div>
                  {directive.selectedText}
                  {directive.selectionTruncated && <div className="mt-1 italic opacity-80">Selection truncated.</div>}
                </div>
              </div>
            ) : (
              <div ref={messageTextRef} className="whitespace-pre-wrap">
                {message.text}
              </div>
            )}
          </div>
        )}
      </AssistantMessageActions>
    )
  }

  if (message.kind === 'error') {
    return (
      <AssistantMessageActions message={message} onRemoveMessage={onRemoveMessage}>
        {(messageTextRef) => (
          <div
            ref={messageTextRef}
            className="border-danger bg-default text-danger rounded-lg border px-2.5 py-1.5 text-sm leading-5"
          >
            {message.text}
          </div>
        )}
      </AssistantMessageActions>
    )
  }

  return (
    <AssistantMessageActions message={message} onRemoveMessage={onRemoveMessage}>
      {(messageTextRef) => (
        <div className="min-w-0">
          {message.tools.length > 0 && (
            <AssistantActivityGroup
              tools={message.tools.map((tool) => ({
                label: tool.persistedLabel ?? describeAssistantTool(tool.name, tool.args).label,
                outcome: tool.outcome,
                changed: Boolean(tool.noteChange),
              }))}
            >
              {message.tools.map((tool) => (
                <ToolActivity key={tool.id} tool={tool} onApplyNoteChange={onApplyNoteChange} />
              ))}
            </AssistantActivityGroup>
          )}
          {(message.text || (message.streaming && message.tools.length === 0)) && (
            <AssistantMessageContent
              text={message.text}
              streaming={message.streaming}
              messageTextRef={messageTextRef}
            />
          )}
        </div>
      )}
    </AssistantMessageActions>
  )
}

export const ToolActivity = ({
  tool,
  onApplyNoteChange,
}: {
  tool: ToolEntry
  onApplyNoteChange: (toolId: string, direction: AssistantNoteChangeDirection) => void
}) => {
  const presentation = tool.persistedLabel
    ? { label: tool.persistedLabel }
    : describeAssistantTool(tool.name, tool.args)
  const state =
    tool.outcome === undefined
      ? 'Working…'
      : tool.outcome === 'succeeded'
        ? 'Completed'
        : tool.outcome === 'denied'
          ? 'Denied'
          : tool.outcome === 'interrupted'
            ? 'Interrupted'
            : 'Needs attention'
  const authorization = tool.authorization
    ? tool.authorization.decision === 'deny'
      ? tool.authorization.source === 'user-chat'
        ? 'Denied for this chat'
        : 'Denied once'
      : tool.authorization.source === 'safety-review'
        ? 'Safety review allowed'
        : tool.authorization.source === 'user-chat'
          ? 'Allowed and enabled safety review'
          : tool.authorization.source === 'user-once'
            ? 'Allowed once'
            : 'Allowed by permissions'
    : undefined
  return (
    <details className="border-border bg-contrast text-neutral group rounded border px-2 py-1 text-[11px] leading-4">
      <summary className="flex min-w-0 cursor-pointer items-center gap-1.5 select-none">
        <Icon type="chevron-right" size="small" className="shrink-0 transition-transform group-open:rotate-90" />
        <span className="min-w-0 flex-1 truncate font-medium" title={presentation.label}>
          {presentation.label}
        </span>
        {tool.noteChange && tool.outcome === 'succeeded' && (
          <span className="shrink-0 tabular-nums">
            <span className="text-success">+{tool.noteChange.addedLines}</span>{' '}
            <span className="text-danger">−{tool.noteChange.removedLines}</span>
          </span>
        )}
        <span
          className={classNames(
            'shrink-0 whitespace-nowrap',
            tool.outcome === 'failed' || tool.outcome === 'denied' ? 'text-danger' : 'text-passive-1',
          )}
        >
          {state}
        </span>
      </summary>
      {presentation.detail && <div className="text-passive-0 mt-1 whitespace-pre-wrap">{presentation.detail}</div>}
      {authorization && <div className="text-passive-1 mt-1">{authorization}</div>}
      {tool.noteChange && tool.outcome === 'succeeded' && (
        <div className="border-border mt-2 border-t pt-2">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold">
              Changes · <span className="text-success">+{tool.noteChange.addedLines}</span>{' '}
              <span className="text-danger">−{tool.noteChange.removedLines}</span>
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="border-border hover:bg-default rounded border px-2 py-1 font-medium disabled:cursor-not-allowed disabled:opacity-40"
                disabled={tool.noteChangePending || tool.noteChangePosition === 'before'}
                onClick={() => onApplyNoteChange(tool.id, 'undo')}
              >
                Undo
              </button>
              <button
                type="button"
                className="border-border hover:bg-default rounded border px-2 py-1 font-medium disabled:cursor-not-allowed disabled:opacity-40"
                disabled={tool.noteChangePending || tool.noteChangePosition !== 'before'}
                onClick={() => onApplyNoteChange(tool.id, 'redo')}
              >
                Redo
              </button>
            </div>
          </div>
          <details>
            <summary className="text-passive-0 cursor-pointer select-none">Git-style diff</summary>
            <pre
              className="border-border bg-default mt-1 max-h-72 overflow-auto rounded border p-2 font-mono text-[11px] leading-4"
              aria-label={`Changes made to ${tool.noteChange.noteTitle}`}
            >
              {tool.noteChange.patch.split('\n').map((line, index) => (
                <span
                  key={`${index}-${line.slice(0, 16)}`}
                  className={classNames(
                    'block min-w-max whitespace-pre',
                    line.startsWith('+') && !line.startsWith('+++') && 'bg-success/10 text-success',
                    line.startsWith('-') && !line.startsWith('---') && 'bg-danger/10 text-danger',
                    line.startsWith('@@') && 'text-info',
                    (line.startsWith('diff --git') || line.startsWith('---') || line.startsWith('+++')) &&
                      'text-passive-0 font-semibold',
                  )}
                >
                  {line || ' '}
                </span>
              ))}
            </pre>
          </details>
          {tool.noteChangePending && <div className="text-passive-1 mt-1">Applying…</div>}
          {tool.noteChangeError && (
            <div className="text-danger mt-1" role="alert">
              {tool.noteChangeError}
            </div>
          )}
        </div>
      )}
    </details>
  )
}

const InlineAssistantConfirmation = ({
  confirmation,
  irreversible,
  canAllowAll,
  onResolve,
}: {
  confirmation: AssistantConfirmationPresentation
  irreversible: boolean
  canAllowAll: boolean
  onResolve: (approved: boolean, rememberForThisChat?: boolean) => void
}) => (
  <section
    className="border-warning bg-warning-faded max-w-[85%] self-start rounded border p-3 text-sm"
    aria-label="Assistant action approval"
  >
    <div className="text-warning font-semibold">{confirmation.label}</div>
    <p className="text-text mt-1">{confirmation.detail || 'The assistant is ready to make this change.'}</p>
    {confirmation.fields.length > 0 && (
      <dl className="border-warning/30 bg-default/40 mt-3 space-y-1.5 rounded border p-2 text-xs">
        {confirmation.fields.map((field) => (
          <div key={field.label} className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2">
            <dt className="text-passive-1 font-semibold">{field.label}</dt>
            <dd className="text-text break-words whitespace-pre-wrap">{field.value}</dd>
          </div>
        ))}
      </dl>
    )}
    {confirmation.reviewIncomplete && (
      <p className="text-warning mt-2 text-xs font-semibold">
        Some action details were shortened or omitted. This action cannot be auto-approved.
      </p>
    )}
    <p className="text-passive-0 mt-3 text-xs">
      {irreversible
        ? 'This is irreversible. It will always ask again before another destructive change.'
        : canAllowAll
          ? '“Allow all” selects the synced safety-reviewed mode; each later eligible change is reviewed independently. “Deny all” blocks this action type in this chat.'
          : 'This action always needs an explicit decision. “Deny all” blocks this action type in this chat.'}
    </p>
    <div className="mt-3 flex flex-wrap gap-2">
      <Button primary small label="Allow once" onClick={() => onResolve(true)} />
      {canAllowAll && <Button primary small label="Allow all" onClick={() => onResolve(true, true)} />}
      <Button small label="Deny once" onClick={() => onResolve(false)} />
      <Button small colorStyle="danger" label="Deny all" onClick={() => onResolve(false, true)} />
    </div>
  </section>
)

const ConversationPanelObserved = observer(ConversationPanelImpl)

export default ConversationPanelObserved
