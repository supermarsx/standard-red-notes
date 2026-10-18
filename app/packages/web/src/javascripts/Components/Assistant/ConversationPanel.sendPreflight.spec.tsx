import { AssistantPresence } from '@/Assistant/assistantPresence'
/** @jest-environment jsdom */
import { AssistantChatStorageError, type AssistantSharedChatBinding } from '@/Assistant/assistantSyncedChats'
import { act, type RefObject, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ApplicationEvent, PrefKey } from '@standardnotes/snjs'
import { runConversationMode } from '@/Assistant/conversationModeRunner'
import { type AgentResult } from '@/Assistant/agent'
import ConversationPanel from './ConversationPanel'
import { flushAssistantNoteEditors } from '@/Assistant/assistantNoteChanges'
import { acquireAssistantChatRun } from '@/Assistant/assistantChatRunLease'
import { prepareAssistantAttachment } from '@/Assistant/attachments'
import { TextEncoder } from 'util'
import { AssistantTools } from '@/Assistant/tools'
import { resolveContextNoteUuids } from '@/Assistant/assistantContextSource'
import type { AssistantChatDirective } from '@/Assistant/assistantDirectives'

jest.mock('@/Assistant/attachments', () => ({
  ...jest.requireActual('@/Assistant/attachments'),
  prepareAssistantAttachment: jest.fn(),
}))

jest.mock('@/Assistant/conversationModeRunner', () => ({ runConversationMode: jest.fn() }))
jest.mock('@/Assistant/agent', () => ({ run: jest.fn() }))
jest.mock('@/Assistant/assistantPresence', () => ({
  AssistantPresence: { start: jest.fn(() => ({ update: jest.fn(), dispose: jest.fn() })) },
}))
jest.mock('@/Assistant/tools', () => ({
  TOOL_DEFINITIONS: [
    { name: 'notes.read', mutating: false },
    { name: 'notes.update', mutating: true },
  ],
  AssistantTools: jest.fn().mockImplementation(() => {
    return { tools: () => [], setAbortSignal: () => undefined }
  }),
}))
jest.mock('@/Assistant/selectionActions', () => ({
  getSelectionAIAvailability: () => ({ available: true }),
  resolveActiveProfileOverrides: () => ({ model: 'test', baseURL: 'https://provider.test' }),
  buildAssistantProvider: () => ({ send: jest.fn() }),
}))
jest.mock('@/Assistant/assistantContextSource', () => ({
  ...jest.requireActual('@/Assistant/assistantContextSource'),
  buildContextForSelection: () => ({
    scope: 'current-note',
    noteCount: 0,
    characters: 0,
    truncated: false,
    noteTitles: [],
    noteUuids: [],
    omittedNoteCount: 0,
    text: '',
  }),
  resolveContextNoteUuids: jest.fn(() => ['context-note']),
}))
jest.mock('../Panes/ResponsivePaneProvider', () => ({ useResponsiveAppPane: () => ({ presentPane: jest.fn() }) }))
jest.mock('./AssistantMessageActions', () => ({
  __esModule: true,
  default: ({ children }: { children: (ref: RefObject<HTMLDivElement | null>) => ReactNode }) => (
    <div>{children({ current: null })}</div>
  ),
}))
jest.mock('./ContextSelector', () => ({ __esModule: true, default: () => null }))
jest.mock('./AssistantUsageMeter', () => ({ __esModule: true, default: () => null }))
jest.mock('@/Components/Icon/Icon', () => ({ __esModule: true, default: () => <span /> }))
jest.mock('@/Components/Button/Button', () => ({
  __esModule: true,
  default: ({ label, onClick, disabled }: { label: string; onClick?: () => void; disabled?: boolean }) => (
    <button disabled={disabled} onClick={onClick}>
      {label}
    </button>
  ),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
globalThis.TextEncoder ??= TextEncoder
HTMLElement.prototype.scrollTo = jest.fn()

jest.mock('@/Assistant/assistantNoteChanges', () => ({
  ...jest.requireActual('@/Assistant/assistantNoteChanges'),
  flushAssistantNoteEditors: jest.fn(),
}))
jest.mock('@/Assistant/assistantChatRunLease', () => ({ acquireAssistantChatRun: jest.fn() }))
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('Assistant immediate send feedback and preflight fences', () => {
  let container: HTMLDivElement
  let root: Root
  let eventObserver: (event: ApplicationEvent) => Promise<void>
  let signedIn: boolean
  const values = new Map<string, unknown>()
  const persist = jest.fn(async (key: string, value: unknown) => {
    values.set(key, value)
  })
  const application = {
    identifier: 'preflight-test',
    serverJsonRequest: jest.fn(),
    storage: {
      getValue: <T,>(key: string): T => values.get(key) as T,
      setValue: (key: string, value: unknown) => {
        values.set(key, value)
      },
      setValueAndAwaitPersist: persist,
      removeValue: async (key: string) => {
        values.delete(key)
      },
    },
    sessions: { isSignedIn: () => signedIn, getUser: () => (signedIn ? { uuid: 'other-account' } : undefined) },
    getPreference: (_key: unknown, fallback: unknown) => fallback,
    setPreference: jest.fn(),
    addEventObserver: (callback: typeof eventObserver) => {
      eventObserver = callback
      return () => undefined
    },
    items: { addObserver: () => () => undefined, findItem: () => undefined },
    itemListController: { selectedItemsCount: 0 },
    itemControllerGroup: { itemControllers: [], addActiveControllerChangeObserver: () => () => undefined },
  }
  const flush = async () => {
    for (let index = 0; index < 35; index++) {
      await Promise.resolve()
    }
  }
  const render = (
    id: string | false = 'first',
    sharedChat?: AssistantSharedChatBinding,
    directiveOverrides?: Partial<AssistantChatDirective>,
  ) =>
    root.render(
      <ConversationPanel
        application={application as never}
        tabId="preflight-chat"
        accountScope="anonymous:preflight-test:dock:window"
        persistenceAllowed
        runPersistence={async (operation) => {
          await operation()
          return true
        }}
        isActive
        sharedChat={sharedChat}
        directive={
          id
            ? ({
                id,
                accountScope: 'anonymous:preflight-test',
                instruction: 'Visible request',
                selectedText: '',
                providerPrompt: 'Visible request',
                ...directiveOverrides,
              } as never)
            : undefined
        }
      />,
    )
  const preparing = () => container.querySelector('[aria-label="Preparing assistant message"]')
  const stop = () => container.querySelector<HTMLButtonElement>('[aria-label="Stop current assistant request"]')
  const guard = () => ({
    proof: { chatId: 'preflight-chat', requestId: 'request', leaseId: 'lease', fence: 1 },
    isCurrent: () => true,
    canCheckpoint: () => true,
    release: jest.fn(async () => undefined),
  })

  beforeEach(() => {
    jest.clearAllMocks()
    jest.mocked(AssistantPresence.start).mockImplementation(() => ({ update: jest.fn(), dispose: jest.fn() }))
    signedIn = false
    jest.mocked(resolveContextNoteUuids).mockReturnValue(['context-note'])
    values.clear()
    localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    jest.mocked(flushAssistantNoteEditors).mockResolvedValue(undefined)
    jest.mocked(acquireAssistantChatRun).mockResolvedValue(guard())
    jest.mocked(runConversationMode).mockImplementation(() => new Promise<AgentResult>(() => undefined))
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it.each(['note', 'selection'] as const)(
    'binds a %s ribbon action to its captured source through navigation',
    async (contextKind) => {
      let activeNote = 'source-note'
      jest.mocked(resolveContextNoteUuids).mockImplementation((_application, selection) => {
        if (selection.collection?.type === 'notes') {
          return selection.collection.uuids
        }
        return [activeNote]
      })
      const pending = deferred<void>()
      jest.mocked(flushAssistantNoteEditors).mockReturnValueOnce(pending.promise)
      await act(async () => {
        render('ribbon-action', undefined, {
          noteUuid: 'source-note',
          contextKind,
          selectedText: 'Captured ribbon excerpt',
          providerPrompt: 'Improve this content: Captured ribbon excerpt',
        })
        await flush()
      })
      expect(runConversationMode).not.toHaveBeenCalled()
      activeNote = 'newly-opened-note'
      await act(async () => {
        pending.resolve()
        await flush()
      })
      expect(runConversationMode).toHaveBeenCalledTimes(1)
      const options = jest.mocked(runConversationMode).mock.calls[0][2]
      expect(options.systemPrompt).toContain('note UUID source-note')
      expect(options.systemPrompt).not.toContain('newly-opened-note')
      expect(options.systemPrompt).not.toContain('Captured ribbon excerpt')
      const context = jest.mocked(AssistantTools).mock.calls.at(-1)![1]
      expect([...(context.selectedNoteUuids ?? [])]).toEqual(contextKind === 'note' ? ['source-note'] : [])
      if (contextKind === 'selection') {
        expect(options.systemPrompt).toContain('does not authorize reading or changing the rest of the note')
      } else {
        expect(options.systemPrompt).toContain('Only this originating note is in scope')
      }
    },
  )
  it('shows scoped tool activity only after authorization and removes presence immediately on stop', async () => {
    await act(async () => {
      render('presence', undefined, { noteUuid: 'context-note', contextKind: 'note' })
      await flush()
    })
    expect(AssistantPresence.start).toHaveBeenCalledWith(
      expect.objectContaining({ noteUuid: 'context-note', status: 'working' }),
    )
    const presence = jest.mocked(AssistantPresence.start).mock.results[0].value
    const callbacks = jest.mocked(runConversationMode).mock.calls[0][2]
    const context = jest.mocked(AssistantTools).mock.calls.at(-1)![1]
    await act(async () => {
      callbacks.onToolCall?.({ id: 'read', name: 'notes.read', args: { uuid: 'context-note' } })
      expect(presence.update).not.toHaveBeenCalled()
      context.onAuthorization?.('read', { decision: 'allow', source: 'policy' })
    })
    expect(presence.update).toHaveBeenLastCalledWith('context-note', 'reading')
    await act(async () => {
      callbacks.onToolResult?.('read', '{}', 'succeeded')
      callbacks.onToolCall?.({ id: 'edit', name: 'notes.update', args: { uuid: 'context-note' } })
      context.onAuthorization?.('edit', { decision: 'allow', source: 'policy' })
    })
    expect(presence.update).toHaveBeenLastCalledWith('context-note', 'editing')
    await act(async () => {
      callbacks.onToolCall?.({ id: 'outside', name: 'notes.update', args: { uuid: 'unselected-note' } })
      context.onAuthorization?.('outside', { decision: 'allow', source: 'policy' })
    })
    expect(presence.update).not.toHaveBeenCalledWith('unselected-note', expect.anything())
    await act(async () => stop()!.click())
    expect(presence.dispose).toHaveBeenCalledTimes(1)
    await act(async () => context.onAuthorization?.('edit', { decision: 'allow', source: 'policy' }))
    expect(AssistantPresence.start).toHaveBeenCalledTimes(1)
  })

  it.each(['finish', 'error'] as const)('clears assistant presence on provider %s', async (outcome) => {
    if (outcome === 'error') {
      jest.mocked(runConversationMode).mockRejectedValueOnce(new Error('Provider failed'))
    } else {
      jest
        .mocked(runConversationMode)
        .mockResolvedValueOnce({ finalText: 'Done', stopReason: 'end_turn', steps: 1 } as AgentResult)
    }
    await act(async () => {
      render('presence', undefined, { noteUuid: 'context-note', contextKind: 'note' })
      await flush()
    })
    expect(AssistantPresence.start).toHaveBeenCalledTimes(1)
    expect(jest.mocked(AssistantPresence.start).mock.results[0].value.dispose).toHaveBeenCalledTimes(1)
  })

  it.each(['account', 'unmount'] as const)('removes working presence on %s boundary', async (boundary) => {
    await act(async () => {
      render('presence', undefined, { noteUuid: 'context-note', contextKind: 'note' })
      await flush()
    })
    const presence = jest.mocked(AssistantPresence.start).mock.results[0].value
    await act(async () => {
      if (boundary === 'account') {
        signedIn = true
        await eventObserver(ApplicationEvent.SignedIn)
      } else {
        root.render(null)
      }
      await flush()
    })
    expect(presence.dispose).toHaveBeenCalledTimes(1)
  })

  it('reports an unapplied permission write and restores the persisted policy', async () => {
    application.setPreference.mockResolvedValue(undefined)
    await act(async () => {
      render(false)
      await flush()
    })
    const select = container.querySelector('button[aria-label="Assistant tool permissions"]') as HTMLButtonElement
    await act(async () => select.click())
    await act(async () => {
      Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
        .find((option) => option.textContent?.startsWith('Safe changes'))!
        .click()
      await flush()
    })
    expect(select.textContent).toBe('Read')
    expect(select.disabled).toBe(false)
    expect(container.textContent).toContain('Tool permissions could not be saved. Please try again.')
    application.setPreference.mockReset()
  })

  it('keeps a selected permission visible through delayed preference writes and unrelated refreshes', async () => {
    const gate = deferred<void>()
    let savedMode = 'allow-read'
    const original = application.getPreference
    application.getPreference = (key, fallback) => (key === PrefKey.AssistantToolPermissionMode ? savedMode : fallback)
    application.setPreference.mockImplementation(async (key, value) => {
      await gate.promise
      if (key === PrefKey.AssistantToolPermissionMode) {
        savedMode = value
      }
    })
    try {
      await act(async () => {
        render(false)
        await flush()
      })
      const select = container.querySelector('button[aria-label="Assistant tool permissions"]') as HTMLButtonElement
      await act(async () => select.click())
      await act(async () => {
        Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
          .find((option) => option.textContent?.startsWith('Safe changes'))!
          .click()
        await eventObserver(ApplicationEvent.PreferencesChanged)
      })
      expect(select.textContent).toBe('Safe')
      expect(select.disabled).toBe(true)
      await act(async () => {
        gate.resolve()
        await flush()
      })
      expect(select.textContent).toBe('Safe')
    } finally {
      application.getPreference = original
      application.setPreference.mockReset()
    }
  })

  it('shows the submitted bubble and Stop before editor saving completes, without checkpointing an unprepared turn', async () => {
    const save = deferred<void>()
    jest.mocked(flushAssistantNoteEditors).mockReturnValue(save.promise)
    await act(async () => {
      render()
      await flush()
    })
    expect(preparing()?.textContent).toContain('Visible request')
    expect(stop()).not.toBeNull()
    expect(runConversationMode).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
    await act(async () => {
      stop()!.click()
      save.resolve()
      await flush()
    })
    expect(preparing()).toBeNull()
    expect(stop()).toBeNull()
    expect(runConversationMode).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
  })

  it('reserves an ordinary send synchronously against two same-tick button clicks', async () => {
    const save = deferred<void>()
    jest.mocked(flushAssistantNoteEditors).mockReturnValue(save.promise)
    await act(async () => {
      render(false)
      await flush()
    })
    const input = container.querySelector('textarea')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Visible request')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const send = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Send')!
    expect(send.disabled).toBe(false)
    await act(async () => {
      send.click()
      send.click()
      await flush()
    })
    expect(preparing()?.textContent).toContain('Visible request')
    expect(flushAssistantNoteEditors).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[aria-label="Remove from queue"]')).toBeNull()
    await act(async () => {
      save.resolve()
      await flush()
    })
    expect(runConversationMode).toHaveBeenCalledTimes(1)
    expect(container.textContent?.match(/Visible request/g)).toHaveLength(1)
  })

  const typeDraft = (text: string) => {
    const input = container.querySelector('textarea')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const sendDraft = async () => {
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Send')!
        .click()
      await flush()
    })
  }

  const composerBinding = (): AssistantSharedChatBinding => ({
    ready: true,
    history: {
      tab: { id: 'preflight-chat', kind: 'chat', title: 'Test', createdAt: 1, updatedAt: 1, userRenamed: false },
      messages: [],
      deniedToolNames: [],
      composer: {
        draft: {
          value: { text: 'Synced draft', attachments: [{ kind: 'text', name: 'draft.txt', text: 'Context' }] },
          updatedAt: 1,
        },
        context: { value: { scope: 'current-note' }, updatedAt: 1 },
        toolPermissionMode: { value: 'allow-read', updatedAt: 1 },
      },
    } as AssistantSharedChatBinding['history'],
    refresh: jest.fn(async () => undefined),
    checkpoint: jest.fn(async () => undefined),
    checkpointComposer: jest.fn(async () => undefined),
  })

  it('hydrates shared composer text and attachments without echoing a composer write', async () => {
    const shared = composerBinding()
    await act(async () => {
      render(false, shared)
      await flush()
    })
    expect(container.querySelector('textarea')!.value).toBe('Synced draft')
    expect(container.querySelector('[aria-label="Remove draft.txt"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Assistant tool permissions"]')?.textContent).toBe('Read')
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'))
      await flush()
    })
    expect(shared.checkpointComposer).not.toHaveBeenCalled()
    typeDraft('Local replacement')
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'))
      await flush()
    })
    expect(shared.checkpointComposer).toHaveBeenCalledWith({
      draft: {
        text: 'Local replacement',
        attachments: [{ kind: 'text', name: 'draft.txt', text: 'Context' }],
      },
    })
  })

  it('checkpoints a cleared composer before sending and restores it after provider failure', async () => {
    const shared = composerBinding()
    shared.refresh = jest.fn(async () => shared.history)
    jest.mocked(runConversationMode).mockRejectedValueOnce(new Error('Provider unavailable'))
    await act(async () => {
      render(false, shared)
      await flush()
    })
    await sendDraft()
    expect(shared.checkpointComposer).toHaveBeenCalledWith({ draft: null })
    expect(container.querySelector('textarea')!.value).toBe('Synced draft')
    expect(container.querySelector('[aria-label="Remove draft.txt"]')).not.toBeNull()
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'))
      await flush()
    })
    expect(shared.checkpointComposer).toHaveBeenLastCalledWith({
      draft: {
        text: 'Synced draft',
        attachments: [{ kind: 'text', name: 'draft.txt', text: 'Context' }],
      },
    })
  })

  it('does not let remotely elevated composer permissions change an active run', async () => {
    const shared = composerBinding()
    shared.refresh = jest.fn(async () => shared.history)
    await act(async () => {
      render(false, shared)
      await flush()
    })
    await sendDraft()
    expect(runConversationMode).toHaveBeenCalledTimes(1)
    const context = jest.mocked(AssistantTools).mock.calls[0][1]
    const request = { name: 'notes.update', args: { uuid: 'context-note', text: 'Update note' } } as never
    expect(await context.shouldRequestConfirmation!(request, true)).toBe(true)
    const incoming = {
      ...shared,
      history: {
        ...shared.history!,
        composer: {
          ...shared.history!.composer,
          toolPermissionMode: { value: 'bypass' as const, updatedAt: 2 },
        },
      },
    }
    await act(async () => {
      render(false, incoming)
      await flush()
    })
    expect(await context.shouldRequestConfirmation!(request, true)).toBe(true)
    expect(shared.checkpointComposer).toHaveBeenCalledTimes(1)
  })

  it('does not rehydrate the old composer after a key boundary before the parent remounts', async () => {
    const shared = composerBinding()
    await act(async () => {
      render(false, shared)
      await flush()
    })
    expect(container.querySelector('textarea')!.value).toBe('Synced draft')
    await act(async () => {
      await eventObserver(ApplicationEvent.KeyStatusChanged)
      await flush()
    })
    expect(container.querySelector('textarea')!.value).toBe('')
    const incoming = {
      ...shared,
      history: {
        ...shared.history!,
        composer: {
          ...shared.history!.composer,
          draft: { value: { text: 'Old account incoming draft' }, updatedAt: 20 },
        },
      },
    }
    await act(async () => {
      render(false, incoming)
      window.dispatchEvent(new Event('pagehide'))
      await flush()
    })
    expect(container.querySelector('textarea')!.value).toBe('')
    expect(container.querySelector('[aria-label="Remove draft.txt"]')).toBeNull()
    expect(shared.checkpointComposer).not.toHaveBeenCalled()
  })

  it.each(['throw', 'result'] as const)(
    'restores a failed provider submission (%s) without duplicating the retry',
    async (failure) => {
      jest.mocked(runConversationMode).mockImplementationOnce(async () => {
        if (failure === 'throw') {
          throw new Error('Provider unavailable')
        }
        return { finalText: 'Provider unavailable', stopReason: 'error' } as AgentResult
      })
      await act(async () => {
        render(false)
        await flush()
      })
      typeDraft('Please summarize')
      await sendDraft()
      expect(container.querySelector('textarea')!.value).toBe('Please summarize')
      expect(container.textContent).toContain('Provider unavailable')
      await sendDraft()
      const history = jest.mocked(runConversationMode).mock.calls[1][1]
      expect(history.filter((message) => message.role === 'user')).toEqual([
        { role: 'user', content: 'Please summarize' },
      ])
    },
  )

  it('restores a submission refused by encrypted history storage', async () => {
    const shared = {
      ready: true,
      refresh: jest.fn(async () => undefined),
      checkpoint: jest.fn(async () => {
        throw new Error('Storage unavailable')
      }),
    }
    await act(async () => {
      render(false, shared)
      await flush()
    })
    typeDraft('Keep this message')
    await sendDraft()
    expect(container.querySelector('textarea')!.value).toBe('Keep this message')
    expect(runConversationMode).not.toHaveBeenCalled()
    expect(container.textContent).toContain('message was not sent')
  })

  it('does not overwrite a newer draft when the provider fails', async () => {
    const response = deferred<AgentResult>()
    jest.mocked(runConversationMode).mockReturnValueOnce(response.promise)
    await act(async () => {
      render(false)
      await flush()
    })
    typeDraft('Original message')
    await sendDraft()
    typeDraft('New draft')
    await act(async () => {
      response.reject(new Error('Provider unavailable'))
      await flush()
    })
    expect(container.querySelector('textarea')!.value).toBe('New draft')
    expect(container.textContent).toContain('Original message')
  })

  it('restores attachments together with a failed submission', async () => {
    jest.mocked(runConversationMode).mockRejectedValueOnce(new Error('Provider unavailable'))
    jest.mocked(prepareAssistantAttachment).mockResolvedValueOnce({
      kind: 'text',
      name: 'context.txt',
      text: 'Attached content',
    })
    await act(async () => {
      render(false)
      await flush()
    })
    const file = new File(['Attached content'], 'context.txt', { type: 'text/plain' })
    const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(picker, 'files', { value: [file] })
    await act(async () => {
      picker.dispatchEvent(new Event('change', { bubbles: true }))
      await flush()
    })
    expect(container.querySelector('[aria-label="Remove context.txt"]')).not.toBeNull()
    typeDraft('Read this file')
    await sendDraft()
    expect(container.querySelector('textarea')!.value).toBe('Read this file')
    expect(container.querySelector('[aria-label="Remove context.txt"]')).not.toBeNull()
    await sendDraft()
    const history = jest.mocked(runConversationMode).mock.calls[1][1]
    expect(JSON.stringify(history)).toContain('Attached content')
    expect(history.filter((message) => message.role === 'user')).toHaveLength(1)
  })

  it.each(['text', 'tool'] as const)('does not restore a run after %s output', async (progress) => {
    jest.mocked(runConversationMode).mockImplementationOnce(async (_mode, _history, options) => {
      if (progress === 'text') {
        options.onTextDelta?.('Partial answer')
      } else {
        options.onToolCall?.({ id: 'read', name: 'notes.read', args: {} })
      }
      throw new Error('Interrupted')
    })
    await act(async () => {
      render(false)
      await flush()
    })
    typeDraft('Original message')
    await sendDraft()
    expect(container.querySelector('textarea')!.value).toBe('')
    expect(container.textContent).toContain('Original message')
  })

  it('clears a failed preflight and permits the next explicit request', async () => {
    jest.mocked(flushAssistantNoteEditors).mockRejectedValueOnce(new Error('Saving failed'))
    await act(async () => {
      render()
      await flush()
    })
    expect(preparing()).toBeNull()
    expect(stop()).toBeNull()
    expect(container.textContent).toContain('could not safely flush')
    expect(runConversationMode).not.toHaveBeenCalled()
    await act(async () => {
      render('retry')
      await flush()
    })
    expect(runConversationMode).toHaveBeenCalledTimes(1)
    expect(flushAssistantNoteEditors).toHaveBeenCalledTimes(2)
  })

  it('keeps a single local preview through lease and history refresh, saves context once and waits for its durable checkpoint', async () => {
    const lease = deferred<ReturnType<typeof guard>>()
    const refresh = deferred<undefined>()
    const checkpoint = deferred<void>()
    const shared = {
      ready: true,
      refresh: jest.fn(() => refresh.promise),
      checkpoint: jest.fn<
        ReturnType<AssistantSharedChatBinding['checkpoint']>,
        Parameters<AssistantSharedChatBinding['checkpoint']>
      >(() => checkpoint.promise),
    }
    jest.mocked(acquireAssistantChatRun).mockReturnValue(lease.promise)
    await act(async () => {
      render('shared', shared)
      await flush()
    })
    expect(preparing()?.textContent).toContain('Visible request')
    expect(flushAssistantNoteEditors).not.toHaveBeenCalled()
    expect(shared.refresh).not.toHaveBeenCalled()
    await act(async () => {
      lease.resolve(guard())
      await flush()
    })
    expect(shared.refresh).toHaveBeenCalledTimes(1)
    expect(preparing()).not.toBeNull()
    expect(flushAssistantNoteEditors).not.toHaveBeenCalled()
    await act(async () => {
      refresh.resolve(undefined)
      await flush()
    })
    expect(flushAssistantNoteEditors).toHaveBeenCalledTimes(1)
    expect(preparing()).toBeNull()
    expect(container.textContent?.match(/Visible request/g)).toHaveLength(1)
    expect(shared.checkpoint).toHaveBeenCalledTimes(1)
    expect(
      shared.checkpoint.mock.calls[0][0].filter((message: { kind: string }) => message.kind === 'user'),
    ).toHaveLength(1)
    expect(runConversationMode).not.toHaveBeenCalled()
    await act(async () => {
      checkpoint.resolve()
      await flush()
    })
    expect(runConversationMode).toHaveBeenCalledTimes(1)
  })

  it('does not read obsolete local history for a shared draft without a canonical record', async () => {
    const read = jest.spyOn(application.storage, 'getValue').mockImplementation(() => {
      throw new Error('old local record unreadable')
    })
    const shared = { ready: true, refresh: jest.fn(async () => undefined), checkpoint: jest.fn(async () => undefined) }
    try {
      await act(async () => {
        render('shared-new', shared)
        await flush()
      })
      expect(read).not.toHaveBeenCalled()
      expect(container.textContent).not.toContain('Saved chat history could not be read safely')
      expect(runConversationMode).toHaveBeenCalledTimes(1)
    } finally {
      read.mockRestore()
    }
  })

  it('keeps an unreadable local saved copy protected while permitting an in-memory direct conversation', async () => {
    const read = jest.spyOn(application.storage, 'getValue').mockImplementation(() => {
      throw new Error('Unreadable record')
    })
    try {
      await act(async () => {
        render()
        await flush()
      })
      expect(container.textContent).toContain('Saved chat history could not be read safely')
      expect(persist).not.toHaveBeenCalled()
      expect(runConversationMode).toHaveBeenCalledTimes(1)
    } finally {
      read.mockRestore()
    }
  })

  it('retains live streaming state when a shared checkpoint returns its canonical transcript', async () => {
    const shared = {
      ready: true,
      refresh: jest.fn(async () => undefined),
      checkpoint: jest.fn(async (messages: unknown[]) => ({ messages, deniedToolNames: [] }) as never),
    }
    await act(async () => {
      render('shared-canonical', shared)
      await flush()
    })
    const options = jest.mocked(runConversationMode).mock.calls[0][2]
    await act(async () => {
      options.onTextDelta?.('Current answer')
      options.onToolCall?.({ id: 'still-running', name: 'notes.read', args: {} })
      window.dispatchEvent(new Event('pagehide'))
      await new Promise((resolve) => setTimeout(resolve, 60))
      await flush()
    })
    expect(container.querySelector('[aria-label="Generating response"]')).not.toBeNull()
    expect(shared.checkpoint.mock.calls.length).toBeGreaterThan(1)
    expect(container.querySelector('summary')?.textContent).not.toContain('interrupted')
  })

  it('retries one transient initial checkpoint before sending once and clears the write warning', async () => {
    const checkpoint = jest.fn(async () => undefined).mockRejectedValueOnce(new Error('Temporary storage failure'))
    const shared = { ready: true, refresh: jest.fn(async () => undefined), checkpoint }
    await act(async () => {
      render('shared-retry', shared)
      await flush()
    })
    expect(checkpoint).toHaveBeenCalledTimes(2)
    expect(runConversationMode).toHaveBeenCalledTimes(1)
    expect(container.textContent?.match(/Visible request/g)).toHaveLength(1)
    expect(container.textContent).not.toContain('could not be saved')
    expect(container.textContent).not.toContain('could not be read safely')
  })

  it('reports a persistent initial checkpoint failure instead of leaving a silent generating bubble', async () => {
    const shared = {
      ready: true,
      refresh: jest.fn(async () => undefined),
      checkpoint: jest.fn(async () => {
        throw new Error('Storage is unavailable')
      }),
    }
    await act(async () => {
      render('shared-failed', shared)
      await flush()
    })
    expect(runConversationMode).not.toHaveBeenCalled()
    expect(container.textContent).toContain('message was not sent')
    expect(container.textContent).toContain('could not be saved')
    expect(container.textContent).not.toContain('could not be read safely')
    expect(container.querySelector('[aria-label="Generating response"]')).toBeNull()
  })

  it('shows a safe reason and diagnostic code for a failed checkpoint', async () => {
    const shared = {
      ready: true,
      refresh: jest.fn(async () => undefined),
      checkpoint: jest.fn(async () => {
        const error = new AssistantChatStorageError('QUOTA_EXCEEDED', 'write')
        error.message = 'SECRET private chat text'
        throw error
      }),
    }
    await act(async () => {
      render('quota-failure', shared)
      await flush()
    })
    expect(runConversationMode).not.toHaveBeenCalled()
    expect(container.textContent).toContain('QUOTA_EXCEEDED (write)')
    expect(container.textContent).toContain('Free some disk space')
    expect(container.textContent).not.toContain('SECRET')
  })

  it('does not start the provider when shared readiness disappears during preflight', async () => {
    const shared = {
      ready: true,
      refresh: jest.fn(async () => {
        shared.ready = false
        return undefined
      }),
      checkpoint: jest.fn(async () => undefined),
    }
    await act(async () => {
      render('readiness-race', shared)
      await flush()
    })
    expect(runConversationMode).not.toHaveBeenCalled()
    expect(shared.checkpoint).not.toHaveBeenCalled()
    expect(container.textContent).toContain('HISTORY_NOT_READY')
  })

  it('persists stopped shared runs with the real lease guard and retains already received text', async () => {
    const response = deferred<AgentResult>()
    const actual = jest.requireActual<typeof import('@/Assistant/assistantChatRunLease')>(
      '@/Assistant/assistantChatRunLease',
    )
    application.serverJsonRequest.mockResolvedValue({
      ok: true,
      data: { acquired: true, leaseId: 'lease', fence: 1, expiresAt: Date.now() + 30000 },
    })
    jest.mocked(acquireAssistantChatRun).mockImplementation(actual.acquireAssistantChatRun)
    jest.mocked(runConversationMode).mockReturnValue(response.promise)
    const shared = { ready: true, refresh: jest.fn(async () => undefined), checkpoint: jest.fn(async () => undefined) }
    await act(async () => {
      render('shared-stop', shared)
      await flush()
    })
    const options = jest.mocked(runConversationMode).mock.calls[0][2]
    await act(async () => {
      options.onTextDelta?.('Received before Stop')
      options.onToolCall?.({ id: 'pending', name: 'notes.read', args: {} })
      stop()!.click()
      // A late callback after cancellation must not enter the persisted transcript.
      options.onTextDelta?.('Late after Stop')
      response.resolve({ finalText: '', stopReason: 'aborted', steps: 1 })
      await flush()
    })
    const terminal = shared.checkpoint.mock.calls.at(-1) as unknown as [
      Array<{ text: string; activities?: Array<{ outcome: string }> }>,
    ]
    expect(terminal[0].some((message) => message.text === 'Received before Stop')).toBe(true)
    expect(terminal[0].flatMap((message) => message.activities ?? []).map((entry) => entry.outcome)).toContain(
      'interrupted',
    )
    expect(container.textContent).not.toContain('could not be saved')
    expect(container.textContent).not.toContain('Late after Stop')
    expect(stop()).toBeNull()
  })

  it.each(['end_turn', 'error'] as const)(
    'ignores late %s result text after Stop while persisting terminal activity',
    async (stopReason) => {
      const response = deferred<AgentResult>()
      const actual = jest.requireActual<typeof import('@/Assistant/assistantChatRunLease')>(
        '@/Assistant/assistantChatRunLease',
      )
      application.serverJsonRequest.mockResolvedValue({
        ok: true,
        data: { acquired: true, leaseId: 'lease', fence: 1, expiresAt: Date.now() + 30000 },
      })
      jest.mocked(acquireAssistantChatRun).mockImplementation(actual.acquireAssistantChatRun)
      jest.mocked(runConversationMode).mockReturnValue(response.promise)
      const shared = {
        ready: true,
        refresh: jest.fn(async () => undefined),
        checkpoint: jest.fn(async () => undefined),
      }
      await act(async () => {
        render('shared-stop', shared)
        await flush()
      })
      const options = jest.mocked(runConversationMode).mock.calls[0][2]
      await act(async () => {
        options.onToolCall?.({ id: 'pending', name: 'notes.read', args: {} })
        stop()!.click()
        response.resolve({ finalText: 'Late result after Stop', stopReason, steps: 1 })
        await flush()
      })
      const terminal = shared.checkpoint.mock.calls.at(-1) as unknown as [
        Array<{ kind: string; text: string; activities?: Array<{ outcome: string }> }>,
      ]
      expect(shared.checkpoint.mock.calls.length).toBeGreaterThan(1)
      expect(terminal[0].every((message) => !message.text.includes('Late result after Stop'))).toBe(true)
      expect(terminal[0].some((message) => message.kind === 'error')).toBe(false)
      expect(terminal[0].flatMap((message) => message.activities ?? []).map((entry) => entry.outcome)).toContain(
        'interrupted',
      )
      expect(container.textContent).not.toContain('Late result after Stop')
      expect(stop()).toBeNull()
    },
  )

  it('does not checkpoint a previous key epoch after a key-status boundary', async () => {
    const response = deferred<AgentResult>()
    const actual = jest.requireActual<typeof import('@/Assistant/assistantChatRunLease')>(
      '@/Assistant/assistantChatRunLease',
    )
    application.serverJsonRequest.mockResolvedValue({
      ok: true,
      data: { acquired: true, leaseId: 'lease', fence: 1, expiresAt: Date.now() + 30000 },
    })
    jest.mocked(acquireAssistantChatRun).mockImplementation(actual.acquireAssistantChatRun)
    jest.mocked(runConversationMode).mockReturnValue(response.promise)
    const shared = { ready: true, refresh: jest.fn(async () => undefined), checkpoint: jest.fn(async () => undefined) }
    await act(async () => {
      render('shared-key-change', shared)
      await flush()
    })
    const checkpointCount = shared.checkpoint.mock.calls.length
    const options = jest.mocked(runConversationMode).mock.calls[0][2]
    await act(async () => {
      options.onTextDelta?.('Before key boundary')
      await eventObserver(ApplicationEvent.KeyStatusChanged)
      response.resolve({ finalText: 'Late key result', stopReason: 'end_turn', steps: 1 })
      await flush()
    })
    expect(options.signal?.aborted).toBe(true)
    expect(shared.checkpoint).toHaveBeenCalledTimes(checkpointCount)
    expect(container.textContent).not.toContain('Late key result')
    expect(stop()).toBeNull()
  })

  it('removes the pending prompt immediately when the authenticated principal changes', async () => {
    const save = deferred<void>()
    jest.mocked(flushAssistantNoteEditors).mockReturnValue(save.promise)
    await act(async () => {
      render()
      await flush()
    })
    expect(preparing()).not.toBeNull()
    await act(async () => {
      signedIn = true
      await eventObserver(ApplicationEvent.SignedIn)
      await flush()
    })
    expect(preparing()).toBeNull()
    expect(container.textContent).not.toContain('Visible request')
    await act(async () => {
      save.resolve()
      await flush()
    })
    expect(runConversationMode).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
  })
})
