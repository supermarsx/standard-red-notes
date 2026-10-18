/** @jest-environment jsdom */
import { AssistantPresence } from '@/Assistant/assistantPresence'
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

const mockSaveResearchReport = jest.fn()
jest.mock('@/Assistant/saveResearchReport', () => ({
  researchReportTargets: () => [],
  saveResearchReport: (...args: unknown[]) => mockSaveResearchReport(...args),
}))

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

describe('Completed research report save offer', () => {
  let container: HTMLDivElement
  let root: Root
  let eventObserver: (event: ApplicationEvent) => Promise<void>
  let signedIn: boolean
  let mode: 'research' | 'deep-research'
  let scope: string
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
        accountScope={scope}
        conversationMode={mode}
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
    mode = 'research'
    scope = 'anonymous:preflight-test:dock:window'
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

  it.each(['research', 'deep-research'] as const)(
    'offers an explicit save for completed %s without creating or updating notes',
    async (selectedMode) => {
      mode = selectedMode
      jest.mocked(runConversationMode).mockResolvedValueOnce({
        finalText: 'Completed findings [source](https://example.com)',
        steps: 1,
        stopReason: 'end_turn',
      })
      await act(async () => {
        render()
        await flush()
      })
      expect(container.textContent).toContain('Save findings to a note')
      expect(mockSaveResearchReport).not.toHaveBeenCalled()
    },
  )
  it.each(['error', 'aborted', 'time_limit'] as const)(
    'does not offer saving an incomplete %s report',
    async (stopReason) => {
      jest.mocked(runConversationMode).mockResolvedValueOnce({ finalText: 'Incomplete findings', steps: 1, stopReason })
      await act(async () => {
        render()
        await flush()
      })
      expect(container.textContent).not.toContain('Save findings to a note')
      expect(mockSaveResearchReport).not.toHaveBeenCalled()
    },
  )
  it('removes the prior account save offer on an account scope change', async () => {
    jest
      .mocked(runConversationMode)
      .mockResolvedValueOnce({ finalText: 'Private findings', steps: 1, stopReason: 'end_turn' })
    await act(async () => {
      render()
      await flush()
    })
    expect(container.textContent).toContain('Save findings to a note')
    scope = 'different-account'
    signedIn = true
    await act(async () => {
      render(false)
      await flush()
    })
    expect(container.textContent).not.toContain('Save findings to a note')
    expect(mockSaveResearchReport).not.toHaveBeenCalled()
  })
  it('does not publish a pending report after account identity changes', async () => {
    const result = deferred<AgentResult>()
    jest.mocked(runConversationMode).mockReturnValueOnce(result.promise)
    await act(async () => {
      render()
      await flush()
    })
    signedIn = true
    await act(async () => {
      result.resolve({ finalText: 'Old private findings', steps: 1, stopReason: 'end_turn' })
      await flush()
    })
    expect(container.textContent).not.toContain('Save findings to a note')
    expect(mockSaveResearchReport).not.toHaveBeenCalled()
  })
  it('keeps complete oversized findings in this tab and offers saving instead of silently checkpointing a prefix', async () => {
    const finalText = '# Findings\n' + 'x'.repeat(240_001) + '\nREPORT-END [source](https://example.com)'
    jest.mocked(runConversationMode).mockResolvedValueOnce({ finalText, steps: 1, stopReason: 'end_turn' })
    await act(async () => {
      render()
      await flush()
    })
    expect(container.textContent).toContain('Full findings remain in this tab')
    expect(container.textContent).toContain('Save findings to a note')
    expect(container.textContent).toContain('REPORT-END')
    expect(mockSaveResearchReport).not.toHaveBeenCalled()
    const serializedWrites = persist.mock.calls.map(([, value]) => JSON.stringify(value))
    expect(serializedWrites.some((value) => value.includes('REPORT-END'))).toBe(false)
    expect(serializedWrites.some((value) => value.includes('x'.repeat(100)))).toBe(false)
  })
})
