/** @jest-environment jsdom */
import { AssistantChatStorageError, type AssistantSharedChatBinding } from '@/Assistant/assistantSyncedChats'
import { act, type RefObject, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ApplicationEvent } from '@standardnotes/snjs'
import { runConversationMode } from '@/Assistant/conversationModeRunner'
import { type AgentResult } from '@/Assistant/agent'
import ConversationPanel from './ConversationPanel'
import { flushAssistantNoteEditors } from '@/Assistant/assistantNoteChanges'
import { acquireAssistantChatRun } from '@/Assistant/assistantChatRunLease'

jest.mock('@/Assistant/conversationModeRunner', () => ({ runConversationMode: jest.fn() }))
jest.mock('@/Assistant/agent', () => ({ run: jest.fn() }))
jest.mock('@/Assistant/tools', () => ({
  TOOL_DEFINITIONS: [],
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
  resolveContextNoteUuids: () => ['context-note'],
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
  const render = (id: string | false = 'first', sharedChat?: AssistantSharedChatBinding) =>
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
    signedIn = false
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
