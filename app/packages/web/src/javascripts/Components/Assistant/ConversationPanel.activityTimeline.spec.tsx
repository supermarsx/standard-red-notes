/** @jest-environment jsdom */
import { act, type RefObject, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { NoteType } from '@standardnotes/snjs'
import { runConversationMode } from '@/Assistant/conversationModeRunner'
import { run, type AgentOptions, type AgentResult } from '@/Assistant/agent'
import type { AssistantToolContext } from '@/Assistant/tools'
import { readAssistantChatHistoryResult } from '@/Assistant/assistantChatHistory'
import ConversationPanel from './ConversationPanel'

let mockToolContext: AssistantToolContext
jest.mock('@/Assistant/conversationModeRunner', () => ({ runConversationMode: jest.fn() }))
jest.mock('@/Assistant/agent', () => ({ run: jest.fn() }))
jest.mock('@/Assistant/tools', () => ({
  TOOL_DEFINITIONS: [],
  AssistantTools: jest.fn().mockImplementation((_application, context) => {
    mockToolContext = context
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
  resolveContextNoteUuids: () => [],
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

describe('Assistant conversation activity timeline', () => {
  let container: HTMLDivElement
  let root: Root
  let options: AgentOptions
  let resolveRun: (result: AgentResult) => void
  let rejectRun: (reason: Error) => void
  const values = new Map<string, unknown>()
  const scope = 'anonymous:activity-test:dock:window'
  const storage = {
    getValue: <T,>(key: string): T => values.get(key) as T,
    setValue: (key: string, value: unknown) => {
      values.set(key, value)
    },
    setValueAndAwaitPersist: async (key: string, value: unknown) => {
      values.set(key, value)
    },
    removeValue: async (key: string) => {
      values.delete(key)
    },
  }
  const application = {
    identifier: 'activity-test',
    storage,
    sessions: { isSignedIn: () => false, getUser: () => undefined },
    getPreference: (_key: unknown, fallback: unknown) => fallback,
    setPreference: jest.fn(),
    addEventObserver: () => () => undefined,
    items: { addObserver: () => () => undefined },
    itemListController: { selectedItemsCount: 0 },
    itemControllerGroup: { itemControllers: [], addActiveControllerChangeObserver: () => () => undefined },
  }
  const render = (directive: boolean | string = true) =>
    root.render(
      <ConversationPanel
        application={application as never}
        tabId="timeline-chat"
        accountScope={scope}
        persistenceAllowed
        runPersistence={async (operation) => {
          await operation()
          return true
        }}
        isActive
        directive={
          directive
            ? ({
                id: typeof directive === 'string' ? directive : 'timeline-action',
                accountScope: 'anonymous:activity-test',
                instruction: 'Help with this task',
                selectedText: '',
                providerPrompt: 'Help with this task',
              } as never)
            : undefined
        }
      />,
    )
  const flush = async () => {
    for (let index = 0; index < 20; index++) {
      await Promise.resolve()
    }
  }

  beforeEach(() => {
    values.clear()
    localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    jest.mocked(runConversationMode).mockImplementation((_mode, _history, supplied) => {
      options = supplied
      return new Promise((resolve, reject) => {
        resolveRun = resolve
        rejectRun = reject
      })
    })
    const { AssistantTools } = jest.requireMock('@/Assistant/tools')
    AssistantTools.mockImplementation((_application: unknown, context: AssistantToolContext) => {
      mockToolContext = context
      return { tools: () => [], setAbortSignal: () => undefined }
    })
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('folds progress into one activity group while keeping the final answer outside across history restore', async () => {
    await act(async () => {
      render()
      await flush()
    })
    expect(runConversationMode).toHaveBeenCalledTimes(1)
    await act(async () => {
      options.onTextDelta?.('I will check the note first.')
      options.onToolCall?.({ id: 'read-call', name: 'notes.read', args: { uuid: 'note-one' } })
      await flush()
    })
    const group = container.querySelector('details')!
    expect(group.open).toBe(false)
    expect(group.querySelector('summary')?.textContent).toContain('Working')
    expect(container.querySelectorAll('[aria-label="Message display format"]')).toHaveLength(0)
    expect(group.querySelector('[aria-label="Activity updates"]')?.textContent).toBe('I will check the note first.')
    await act(async () => {
      options.onToolResult?.('read-call', 'private protocol result', 'succeeded')
      options.onTextDelta?.('I will check another note.')
      options.onToolCall?.({ id: 'second-read-call', name: 'notes.read', args: { uuid: 'note-two' } })
      options.onToolResult?.('second-read-call', 'another private result', 'succeeded')
      options.onTextDelta?.('Here is the final answer.')
      resolveRun({ finalText: 'Here is the final answer.', steps: 2, stopReason: 'end_turn' })
      await flush()
    })
    const text = container.textContent!
    expect(container.querySelectorAll('details.group\\/activity')).toHaveLength(1)
    expect(group.querySelector('summary')?.textContent).toContain('2 completed')
    expect(group.querySelector('[aria-label="Activity updates"]')?.textContent).toContain('I will check another note.')
    expect(group.textContent).not.toContain('Here is the final answer.')
    expect(container.querySelectorAll('[aria-label="Message display format"]')).toHaveLength(1)
    expect(text.indexOf('2 completed')).toBeLessThan(text.indexOf('I will check the note first.'))
    expect(text.indexOf('I will check the note first.')).toBeLessThan(text.indexOf('I will check another note.'))
    expect(text.indexOf('I will check another note.')).toBeLessThan(text.indexOf('Here is the final answer.'))
    expect(text).not.toContain('private protocol result')
    expect(text).not.toContain('another private result')
    const history = readAssistantChatHistoryResult(storage, scope, 'timeline-chat')
    expect(history.status).toBe('found')
    if (history.status === 'found') {
      expect(history.messages.filter((message) => message.kind === 'assistant')).toHaveLength(1)
      expect(history.messages.find((message) => message.kind === 'assistant')?.activities).toHaveLength(2)
      const assistant = history.messages.find((message) => message.kind === 'assistant')!
      expect(assistant.text.slice(0, assistant.progressTextLength)).toContain('I will check another note.')
      expect(assistant.text.slice(assistant.progressTextLength)).toContain('Here is the final answer.')
    }
    act(() => root.unmount())
    root = createRoot(container)
    await act(async () => {
      render(false)
      await flush()
    })
    const restored = container.textContent!
    expect(container.querySelectorAll('details.group\\/activity')).toHaveLength(1)
    expect(container.querySelector('details.group\\/activity')?.textContent).not.toContain('Here is the final answer.')
    expect(restored.indexOf('2 completed')).toBeLessThan(restored.indexOf('I will check the note first.'))
    expect(restored.indexOf('I will check another note.')).toBeLessThan(restored.indexOf('Here is the final answer.'))
    expect(runConversationMode).toHaveBeenCalledTimes(1)
  })

  it('updates late tool effects in the original group and marks pending work interrupted on abort', async () => {
    await act(async () => {
      render()
      await flush()
    })
    await act(async () => {
      options.onToolCall?.({ id: 'write-call', name: 'notes.update', args: { uuid: 'note-one' } })
      options.onToolResult?.('write-call', '{}', 'succeeded')
      options.onTextDelta?.('The note is updated.')
      options.onToolCall?.({ id: 'pending-call', name: 'notes.read', args: { uuid: 'note-two' } })
      await flush()
    })
    await act(async () => {
      const snapshot = { title: 'Note', text: 'old', previewPlain: 'old', noteType: NoteType.Plain }
      mockToolContext.onNoteChange?.('write-call', {
        noteUuid: 'note-one',
        noteTitle: 'Note',
        before: snapshot,
        after: { ...snapshot, text: 'new' },
        patch: '-old\n+new',
        addedLines: 1,
        removedLines: 1,
        truncated: false,
      })
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Stop')!
        .click()
      expect(options.signal?.aborted).toBe(true)
      rejectRun(Object.assign(new Error('Stopped'), { name: 'AbortError' }))
      await flush()
    })
    const groups = Array.from(container.querySelectorAll('details')).filter((details) =>
      details.className.includes('group/activity'),
    )
    expect(groups).toHaveLength(1)
    expect(groups[0].querySelector('summary')?.textContent).toContain('1 changed')
    expect(groups[0].querySelector('summary')?.textContent).toContain('1 interrupted')
    expect(runConversationMode).toHaveBeenCalledTimes(1)
  })

  it('does not append a buffered delta after the authenticated principal becomes invalid', async () => {
    await act(async () => {
      render()
      await flush()
    })
    const signedIn = jest.spyOn(application.sessions, 'isSignedIn')
    try {
      await act(async () => {
        options.onTextDelta?.('Stale buffered private content')
        signedIn.mockReturnValue(true)
        await new Promise((resolve) => setTimeout(resolve, 60))
        resolveRun({ finalText: 'Stale buffered private content', steps: 1, stopReason: 'end_turn' })
        await flush()
      })
      expect(container.textContent).not.toContain('Stale buffered private content')
      expect(runConversationMode).toHaveBeenCalledTimes(1)
    } finally {
      signedIn.mockRestore()
    }
  })

  it('does not reread and parse stored history on every streamed text render', async () => {
    const read = jest.spyOn(storage, 'getValue')
    try {
      await act(async () => {
        render()
        await flush()
      })
      const initialReads = read.mock.calls.length
      for (const text of ['First words. ', 'More words. ']) {
        await act(async () => {
          options.onTextDelta?.(text)
          await new Promise((resolve) => setTimeout(resolve, 60))
        })
      }
      expect(read).toHaveBeenCalledTimes(initialReads)
      await act(async () => {
        resolveRun({ finalText: 'First words. More words.', stopReason: 'end_turn', steps: 1 })
        await flush()
      })
    } finally {
      read.mockRestore()
    }
  })

  it('stops from the visible current-request control and clears queued work while pending actions settle', async () => {
    await act(async () => {
      render()
      await flush()
    })
    await act(async () => {
      options.onToolCall?.({ id: 'pending', name: 'notes.read', args: { uuid: 'note-one' } })
      render('queued-after-current')
      await flush()
    })
    expect(container.querySelector('[aria-label="Remove from queue"]')).not.toBeNull()
    const stop = container.querySelector<HTMLButtonElement>('[aria-label="Stop current assistant request"]')!
    expect(stop.disabled).toBe(false)
    await act(async () => {
      stop.click()
      await flush()
    })
    expect(options.signal?.aborted).toBe(true)
    expect(stop.disabled).toBe(true)
    expect(stop.textContent).toContain('Stopping')
    expect(container.querySelector('[aria-label="Remove from queue"]')).toBeNull()
    await act(async () => {
      resolveRun({ finalText: '', stopReason: 'aborted', steps: 1 })
      await flush()
    })
    expect(container.querySelector('[aria-label="Stop current assistant request"]')).toBeNull()
    expect(container.querySelector('summary')?.textContent).toContain('1 interrupted')
    expect(runConversationMode).toHaveBeenCalledTimes(1)
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'Send')).toBe(true)
  })

  it('does not replay the previous narration when a consumed steer is immediately aborted', async () => {
    await act(async () => {
      render()
      await flush()
    })
    await act(async () => {
      options.onTextDelta?.('Initial narration before guidance.')
      options.onSteer?.('Different approach')
      resolveRun({ finalText: 'Initial narration before guidance.', steps: 1, stopReason: 'aborted' })
      await flush()
    })
    expect(container.textContent?.match(/Initial narration before guidance\./g)).toHaveLength(1)
    expect(runConversationMode).toHaveBeenCalledTimes(1)
  })

  it('shows one policy error, stops the run and leaves queued work awaiting an explicit user action', async () => {
    await act(async () => {
      render()
      await flush()
    })
    await act(async () => {
      options.onToolCall?.({ id: 'denied-call', name: 'notes.update', args: { uuid: 'read-only-note' } })
      render('queued-next-action')
      await flush()
    })
    expect(container.querySelector('[aria-label="Remove from queue"]')).not.toBeNull()
    await act(async () => {
      options.onToolResult?.('denied-call', 'Action not allowed: read-only', 'denied')
      resolveRun({
        stopReason: 'error',
        errorCode: 'ACTION_NOT_ALLOWED',
        finalText: 'Action not allowed: read-only',
        steps: 1,
      })
      await flush()
    })
    expect(container.textContent?.match(/Action not allowed: read-only/g)).toHaveLength(1)
    expect(container.querySelector('summary')?.textContent).toContain('1 denied')
    expect(container.querySelectorAll('[aria-label="Message display format"]')).toHaveLength(0)
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'Stop')).toBe(false)
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'Send')).toBe(true)
    expect(container.querySelector('[aria-label="Remove from queue"]')).not.toBeNull()
    expect(runConversationMode).toHaveBeenCalledTimes(1)
  })

  it('propagates nested agent policy refusals as typed denials rather than a successful tool summary', async () => {
    await act(async () => {
      render()
      await flush()
    })
    const nestedRun = mockToolContext.runSubAgent!
    jest.mocked(run).mockResolvedValue({
      stopReason: 'error',
      errorCode: 'ACTION_NOT_ALLOWED',
      finalText: 'Action not allowed: read-only',
      steps: 1,
    })
    await expect(nestedRun('Attempt the nested task')).rejects.toMatchObject({
      name: 'AssistantActionNotAllowedError',
      code: 'ASSISTANT_ACTION_NOT_ALLOWED',
    })
    expect(run).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolveRun({ finalText: 'Stopped', stopReason: 'aborted', steps: 1 })
      await flush()
    })
  })
})
