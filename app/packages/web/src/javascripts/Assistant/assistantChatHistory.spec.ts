/** @jest-environment jsdom */
import {
  AssistantChatHistoryStorage,
  ASSISTANT_CHAT_HISTORY_CHECKPOINT_DELAY_MS,
  ASSISTANT_CHAT_HISTORY_LEGACY_KEY_PREFIX,
  ASSISTANT_CHAT_HISTORY_STORAGE_KEY_PREFIX,
  PersistedAssistantMessage,
  createAssistantChatHistoryCheckpoint,
  deleteAssistantChatHistory,
  persistAssistantChatHistory,
  persistAssistantChatHistoryStrict,
  readAssistantChatHistory,
  readAssistantChatHistoryResult,
} from './assistantChatHistory'

const createStorage = () => {
  const values = new Map<string, unknown>()
  const storage: AssistantChatHistoryStorage = {
    getValue: <T>(key: string) => values.get(key) as T,
    setValue: (key, value) => void values.set(key, value),
    removeValue: async (key) => void values.delete(key),
  }
  return { storage, values }
}

const keyFor = (accountScope: string, tabId: string) =>
  `${ASSISTANT_CHAT_HISTORY_STORAGE_KEY_PREFIX}:${encodeURIComponent(accountScope)}:${encodeURIComponent(tabId)}`

describe('assistant chat history checkpoints', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('coalesces a streaming burst into at most one encrypted-store write per interval', async () => {
    const write = jest.fn(async () => undefined)
    const checkpoint = createAssistantChatHistoryCheckpoint(write)

    for (let elapsed = 0; elapsed < ASSISTANT_CHAT_HISTORY_CHECKPOINT_DELAY_MS; elapsed += 50) {
      checkpoint.schedule()
      jest.advanceTimersByTime(50)
    }
    await Promise.resolve()

    expect(write).toHaveBeenCalledTimes(1)
  })

  it('flushes immediately at explicit durability points and cancels the timer', async () => {
    const write = jest.fn(async () => undefined)
    const checkpoint = createAssistantChatHistoryCheckpoint(write)

    checkpoint.schedule()
    await checkpoint.flush()
    jest.advanceTimersByTime(ASSISTANT_CHAT_HISTORY_CHECKPOINT_DELAY_MS)
    await Promise.resolve()

    expect(write).toHaveBeenCalledTimes(1)
  })

  it('keeps later terminal checkpoints usable after one durable write rejection', async () => {
    const write = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockResolvedValue(undefined)
    const checkpoint = createAssistantChatHistoryCheckpoint(write)

    await expect(checkpoint.flush()).rejects.toThrow('disk unavailable')
    await expect(checkpoint.flush()).resolves.toBeUndefined()
    expect(write).toHaveBeenCalledTimes(2)
  })
})

describe('assistant chat history', () => {
  beforeEach(() => localStorage.clear())

  it('is scoped by account and tab', async () => {
    const { storage } = createStorage()
    await persistAssistantChatHistory(storage, 'account-a', 'tab-a', [{ kind: 'user', id: '1', text: 'Hello' }])
    expect(readAssistantChatHistory(storage, 'account-a', 'tab-a')).toEqual([{ kind: 'user', id: '1', text: 'Hello' }])
    expect(readAssistantChatHistory(storage, 'account-b', 'tab-a')).toEqual([])
  })

  it('bounds retained text and deletes only the requested transcript', async () => {
    const { storage } = createStorage()
    await persistAssistantChatHistory(storage, 'account', 'one', [
      { kind: 'assistant', id: '1', text: 'x'.repeat(10_000) },
    ])
    await persistAssistantChatHistory(storage, 'account', 'two', [{ kind: 'error', id: '2', text: 'Keep this' }])
    expect(readAssistantChatHistory(storage, 'account', 'one')[0].text).toHaveLength(8_000)
    await deleteAssistantChatHistory(storage, 'account', 'one')
    expect(readAssistantChatHistory(storage, 'account', 'one')).toEqual([])
    expect(readAssistantChatHistory(storage, 'account', 'two')).toEqual([{ kind: 'error', id: '2', text: 'Keep this' }])
  })

  it('reads v1 application history and emits v2 on the next persistence', async () => {
    const { storage, values } = createStorage()
    const key = keyFor('account', 'existing')
    values.set(key, {
      version: 1,
      messages: [
        {
          kind: 'assistant',
          id: 'old',
          text: 'Still readable',
          activities: [{ id: 'not-v1', name: 'ignored', label: 'Ignored', outcome: 'succeeded' }],
        },
      ],
    })

    const messages = readAssistantChatHistory(storage, 'account', 'existing')
    expect(messages).toEqual([{ kind: 'assistant', id: 'old', text: 'Still readable' }])

    await persistAssistantChatHistory(storage, 'account', 'existing', messages)
    expect(values.get(key)).toEqual({ version: 2, messages })
  })

  it('migrates a valid v1 plaintext transcript into v2 application storage', () => {
    const { storage, values } = createStorage()
    const legacyKey = `${ASSISTANT_CHAT_HISTORY_LEGACY_KEY_PREFIX}:account:legacy`
    localStorage.setItem(
      legacyKey,
      JSON.stringify({ version: 1, messages: [{ kind: 'user', id: '1', text: 'Move me' }] }),
    )

    expect(readAssistantChatHistory(storage, 'account', 'legacy')).toEqual([{ kind: 'user', id: '1', text: 'Move me' }])
    expect(localStorage.getItem(legacyKey)).toBeNull()
    expect(values.get(keyFor('account', 'legacy'))).toEqual({
      version: 2,
      messages: [{ kind: 'user', id: '1', text: 'Move me' }],
    })
  })

  it('round trips only the v2 display and audit activity schema', async () => {
    const { storage, values } = createStorage()
    const unsafeActivity = {
      id: 'call-1',
      name: 'notes.read',
      label: 'Read the selected note',
      authorization: { decision: 'allow', source: 'user-once', token: 'authorization-secret' },
      outcome: 'succeeded',
      arguments: { notePassword: 'argument-secret' },
      result: 'result-secret',
      secret: 'top-secret',
      futureField: 'future-secret',
    }
    const messages = [
      {
        kind: 'assistant',
        id: 'message-1',
        text: 'Done',
        activities: [unsafeActivity],
        futureMessageField: 'also-not-persisted',
      },
    ] as unknown as PersistedAssistantMessage[]

    await persistAssistantChatHistory(storage, 'account', 'v2', messages)

    const expected = [
      {
        kind: 'assistant',
        id: 'message-1',
        text: 'Done',
        activities: [
          {
            id: 'call-1',
            name: 'notes.read',
            label: 'Read the selected note',
            authorization: { decision: 'allow', source: 'user-once' },
            outcome: 'succeeded',
          },
        ],
      },
    ]
    expect(values.get(keyFor('account', 'v2'))).toEqual({ version: 2, messages: expected })
    expect(readAssistantChatHistory(storage, 'account', 'v2')).toEqual(expected)
    expect(JSON.stringify(values.get(keyFor('account', 'v2')))).not.toMatch(
      /argument-secret|result-secret|authorization-secret|top-secret|future-secret|also-not-persisted/,
    )
  })

  it('fails closed on malformed activities and terminalizes absent or pending outcomes', async () => {
    const { storage } = createStorage()
    const activities = [
      { id: 'absent', name: 'safe_tool', label: 'Interrupted after reload' },
      { id: 'pending', name: 'safe_tool', label: 'Was still running', outcome: 'pending' },
      { id: 'bad-name', name: 'unsafe tool name', label: 'Drop me', outcome: 'failed' },
      { id: 'x'.repeat(129), name: 'safe_tool', label: 'Drop me', outcome: 'failed' },
      { id: 'bad-label', name: 'safe_tool', label: 'line one\nline two', outcome: 'failed' },
      { id: 'future-outcome', name: 'safe_tool', label: 'Drop me', outcome: 'queued' },
      {
        id: 'bad-auth',
        name: 'safe_tool',
        label: 'Keep without malformed authorization',
        authorization: { decision: 'allow', source: 'future-source' },
        outcome: 'succeeded',
      },
    ]

    await persistAssistantChatHistory(storage, 'account', 'malformed', [
      { kind: 'assistant', id: '1', text: '', activities } as unknown as PersistedAssistantMessage,
    ])

    expect(readAssistantChatHistory(storage, 'account', 'malformed')).toEqual([
      {
        kind: 'assistant',
        id: '1',
        text: '',
        activities: [
          { id: 'absent', name: 'safe_tool', label: 'Interrupted after reload', outcome: 'interrupted' },
          { id: 'pending', name: 'safe_tool', label: 'Was still running', outcome: 'interrupted' },
          {
            id: 'bad-auth',
            name: 'safe_tool',
            label: 'Keep without malformed authorization',
            outcome: 'succeeded',
          },
        ],
      },
    ])
  })

  it('enforces per-message, transcript, and separate audit-size caps while retaining newest activity', async () => {
    const { storage } = createStorage()
    const messages: PersistedAssistantMessage[] = Array.from({ length: 80 }, (_, messageIndex) => ({
      kind: 'assistant',
      id: `message-${messageIndex}`,
      text: 'Visible transcript text',
      activities: Array.from({ length: 10 }, (_, activityIndex) => ({
        id: `${messageIndex}-${activityIndex}-${'i'.repeat(100)}`,
        name: `tool_${activityIndex}`,
        label: `${messageIndex}-${activityIndex}-${'l'.repeat(110)}`.slice(0, 120),
        authorization: { decision: 'allow', source: 'safety-review' },
        outcome: 'succeeded',
      })),
    }))

    await persistAssistantChatHistory(storage, 'account', 'caps', messages)
    const stored = readAssistantChatHistory(storage, 'account', 'caps')
    const retainedActivities = stored.flatMap((message) => message.activities ?? [])

    expect(stored).toHaveLength(80)
    expect(stored.every((message) => (message.activities?.length ?? 0) <= 8)).toBe(true)
    expect(retainedActivities.length).toBeLessThanOrEqual(64)
    expect(retainedActivities.reduce((sum, activity) => sum + JSON.stringify(activity).length, 0)).toBeLessThanOrEqual(
      16 * 1_024,
    )
    expect(retainedActivities.at(-1)?.id).toBe(`79-9-${'i'.repeat(100)}`)
  })

  it('keeps deletion durable when an older writer finishes after removal', async () => {
    const { storage, values } = createStorage()
    let finishStaleWrite: (() => void) | undefined
    let writeCount = 0
    storage.setValueAndAwaitPersist = (key, value) => {
      writeCount++
      if (writeCount === 1) {
        return new Promise<void>((resolve) => {
          finishStaleWrite = () => {
            values.set(key, value)
            resolve()
          }
        })
      }
      values.set(key, value)
      return Promise.resolve()
    }

    const staleWrite = persistAssistantChatHistory(storage, 'account', 'chat', [
      { kind: 'assistant', id: 'stale', text: 'Secret stale response' },
    ])
    const deletion = deleteAssistantChatHistory(storage, 'account', 'chat')

    // The tombstone is visible in the same turn, before durable storage awaits.
    expect(readAssistantChatHistory(storage, 'account', 'chat')).toEqual([])
    await deletion
    finishStaleWrite?.()
    await staleWrite

    // The resumed writer sees that deletion won and physically removes its
    // stale bytes. Later flushes are refused while the tombstone exists.
    expect(values.has(keyFor('account', 'chat'))).toBe(false)
    await persistAssistantChatHistory(storage, 'account', 'chat', [
      { kind: 'user', id: 'newer-stale', text: 'Do not restore this either' },
    ])
    expect(readAssistantChatHistory(storage, 'account', 'chat')).toEqual([])
    expect(writeCount).toBe(2)
  })

  it('persists per-chat deny policy independently of bounded display history', async () => {
    const { storage } = createStorage()
    const messages: PersistedAssistantMessage[] = Array.from({ length: 100 }, (_, index) => ({
      kind: 'assistant',
      id: `message-${index}`,
      text: `Later activity ${index}`,
      activities: [
        {
          id: `call-${index}`,
          name: 'notes.read',
          label: 'Read a note',
          outcome: 'succeeded',
        },
      ],
    }))

    await persistAssistantChatHistory(storage, 'account', 'policy', messages, ['app.setPreference'])

    const restored = readAssistantChatHistoryResult(storage, 'account', 'policy')
    expect(restored.status).toBe('found')
    if (restored.status === 'found') {
      expect(restored.messages).toHaveLength(80)
      expect(restored.deniedToolNames).toEqual(['app.setPreference'])
    }
  })

  it('fails closed on corrupt policy data or encrypted storage read failure', () => {
    const { storage, values } = createStorage()
    values.set(keyFor('account', 'corrupt'), {
      version: 2,
      messages: [],
      deniedToolNames: ['notes.read', '../invalid'],
    })
    expect(readAssistantChatHistoryResult(storage, 'account', 'corrupt')).toEqual({ status: 'error' })

    storage.getValue = () => {
      throw new Error('storage unavailable')
    }
    expect(readAssistantChatHistoryResult(storage, 'account', 'unreadable')).toEqual({ status: 'error' })
  })

  it('surfaces strict checkpoint failures and retains physical cleanup work', async () => {
    const { storage, values } = createStorage()
    storage.setValueAndAwaitPersist = async () => {
      throw new Error('disk write rejected')
    }
    await expect(
      persistAssistantChatHistoryStrict(storage, 'account', 'strict', [
        { kind: 'user', id: 'one', text: 'Keep this in memory' },
      ]),
    ).rejects.toThrow('disk write rejected')

    storage.setValueAndAwaitPersist = undefined
    storage.removeValue = async () => {
      throw new Error('disk removal rejected')
    }
    expect(await deleteAssistantChatHistory(storage, 'account', 'strict')).toBe(false)
    expect(values.get(keyFor('account', 'strict'))).toEqual({ version: 2, messages: [], deleted: true })
  })
})
