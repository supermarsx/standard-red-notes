/** @jest-environment jsdom */
import { WebApplication } from '@/Application/WebApplication'
import * as chatHistory from './assistantChatHistory'
import {
  AssistantSyncedChats,
  mergeSyncedChats,
  normalizeSyncedChatRecord,
  reconcileSyncedChatSnapshots,
  SyncedChatRecord,
} from './assistantSyncedChats'
const message = (id: string, text = id) => ({ id, kind: 'user' as const, text })

it('reuses unchanged immutable chat snapshots and catalog arrays while preserving real changes', () => {
  const first = {
    tab: { id: 'one', title: 'First', userRenamed: false },
    messages: [message('first')],
    deniedToolNames: [],
  }
  const second = {
    tab: { id: 'two', title: 'Second', userRenamed: false },
    messages: [message('second')],
    deniedToolNames: [],
  }
  const previous = [first, second]
  expect(reconcileSyncedChatSnapshots(previous, JSON.parse(JSON.stringify(previous)))).toBe(previous)
  const updated = { ...second, messages: [message('second', 'Remote update')] }
  const merged = reconcileSyncedChatSnapshots(previous, [JSON.parse(JSON.stringify(first)), updated])
  expect(merged[0]).toBe(first)
  expect(merged[1]).toBe(updated)
  expect(reconcileSyncedChatSnapshots(merged, [updated])).toEqual([updated])
  expect(reconcileSyncedChatSnapshots(previous, [second, first])).toEqual([second, first])
})
const writer = (
  writerId: string,
  entries: SyncedChatRecord['entries'] = [],
  patch: Partial<SyncedChatRecord> = {},
): SyncedChatRecord => ({
  version: 1,
  ownerUuid: 'account',
  chatId: 'chat',
  kind: 'writer',
  writerId,
  revision: 1,
  updatedAt: 100,
  title: 'Title',
  entries,
  ...patch,
})
const record = (value: SyncedChatRecord) => ({ uuid: value.writerId, record: value })
const entry = (id: string, parentId: string | null, at = 100, revision = 1) => ({
  message: message(id),
  parentId,
  at,
  revision,
})
it('merges independent devices and orders parents before answers despite clock skew', () => {
  const a = record(writer('a', [entry('question', null, 500)])),
    b = record(writer('b', [entry('answer', 'question', 1)]))
  expect(mergeSyncedChats([b, a])[0].messages.map(({ id }) => id)).toEqual(['question', 'answer'])
  expect(mergeSyncedChats([a, b])).toEqual(mergeSyncedChats([b, a]))
})

it.each(['chat', 'agent', 'plan', 'research', 'deep-research'] as const)(
  'normalizes encrypted mode %s while legacy absence remains the Agent-compatible default',
  (conversationMode) => {
    const normalized = normalizeSyncedChatRecord(writer('a', [], { conversationMode }), 'account')!
    expect(normalized.conversationMode).toBe(conversationMode)
    expect(mergeSyncedChats([record(normalized)])[0].tab.conversationMode).toBe(conversationMode)
    expect(normalizeSyncedChatRecord(writer('old'), 'account')).not.toHaveProperty('conversationMode')
  },
)

it('rejects malformed explicit modes and mode clocks without discarding valid legacy records', () => {
  for (const conversationMode of ['execute-code', null, {}, 42]) {
    expect(normalizeSyncedChatRecord({ ...writer('a'), conversationMode }, 'account')).toBeUndefined()
  }
  expect(
    normalizeSyncedChatRecord(writer('a', [], { conversationMode: 'chat', conversationModeUpdatedAt: -1 }), 'account'),
  ).toBeUndefined()
  expect(normalizeSyncedChatRecord(writer('a'), 'account')).toBeDefined()
})

it('chooses mode intent independently from a manually renamed title and newer content activity', () => {
  const manual = record(
    writer('a', [], {
      title: 'Chosen title',
      userRenamed: true,
      conversationMode: 'agent',
      conversationModeUpdatedAt: 100,
      updatedAt: 1000,
    }),
  )
  const changedMode = record(
    writer('b', [], { conversationMode: 'plan', conversationModeUpdatedAt: 200, updatedAt: 200 }),
  )
  expect(mergeSyncedChats([manual, changedMode])[0].tab).toMatchObject({
    title: 'Chosen title',
    conversationMode: 'plan',
  })
})
it('updates streamed stable IDs without duplicating them', () => {
  const old = record(writer('a', [entry('message', null)])),
    newer = record(
      writer('a', [{ ...entry('message', null, 100, 2), message: message('message', 'complete') }], {
        revision: 2,
        updatedAt: 200,
      }),
    )
  expect(mergeSyncedChats([newer, old])[0].messages).toEqual([message('message', 'complete')])
})
it('makes tombstones dominate a newer delayed checkpoint', () => {
  expect(
    mergeSyncedChats([
      record(writer('a', [entry('secret', null)], { updatedAt: 9999 })),
      record(writer('b', [], { kind: 'deleted', updatedAt: 1 })),
    ]),
  ).toEqual([])
})
it('rejects foreign owners, duplicate IDs and unsafe schema; removes arbitrary tool data', () => {
  expect(normalizeSyncedChatRecord(writer('a'), 'other')).toBeUndefined()
  expect(normalizeSyncedChatRecord(writer('a', [entry('same', null), entry('same', null)]), 'account')).toBeUndefined()
  expect(normalizeSyncedChatRecord({ ...writer('a'), version: 2 }, 'account')).toBeUndefined()
  expect(normalizeSyncedChatRecord(writer('a', [], { revision: Infinity }), 'account')).toBeUndefined()
  const unsafe = {
    ...entry('safe', null),
    message: {
      id: 'safe',
      kind: 'assistant',
      text: 'hello',
      apiKey: 'secret',
      activities: [
        {
          id: 'tool',
          name: 'notes.read',
          label: 'Read',
          outcome: 'succeeded',
          args: { token: 'secret' },
          result: 'private',
        },
      ],
    },
  }
  const safe = normalizeSyncedChatRecord(writer('a', [unsafe] as never), 'account')!
  expect(JSON.stringify(safe)).not.toContain('secret')
  expect(JSON.stringify(safe)).not.toContain('private')
  expect(safe.entries![0].message.text).toBe('hello')
})
function harness() {
  let principal = { uuid: 'account' },
    locked = false,
    index = 0
  const values = new Map<string, { uuid: string; content: unknown }>()
  const application = {
    sessions: { getUser: () => principal, isCurrentSessionReadOnly: () => false },
    sync: { isDatabaseLoaded: () => true, sync: jest.fn(async () => undefined) },
    protections: { isLocked: jest.fn(async () => locked) },
    isAuthorizedToRenderItem: () => true,
    items: {
      getItems: () => [...values.values()],
      findItem: (uuid: string) => values.get(uuid),
      addObserver: jest.fn(() => () => undefined),
    },
    mutator: {
      createItem: jest.fn(async (_type: string, content: unknown) => {
        const item = { uuid: 'item-' + ++index, content }
        values.set(item.uuid, item)
        return item
      }),
      changeItem: jest.fn(
        async (item: { uuid: string }, change: (mutator: { setCustomContent: (content: unknown) => void }) => void) =>
          change({
            setCustomContent: (content: unknown) => {
              values.set(item.uuid, { uuid: item.uuid, content })
            },
          }),
      ),
      deleteItem: jest.fn(async (item: { uuid: string }) => {
        values.delete(item.uuid)
      }),
    },
  }
  return {
    application: application as unknown as WebApplication,
    raw: application,
    values,
    setPrincipal: (uuid: string) => {
      principal = { uuid }
    },
    setLocked: (value: boolean) => {
      locked = value
    },
  }
}
it('reuses unchanged normalized records and merged chats without repeating transcript serialization or sanitization', async () => {
  const h = harness()
  const content = writer('a', [entry('one', null)])
  h.values.set('item', { uuid: 'item', content })
  const store = new AssistantSyncedChats(h.application, 'a')
  const stringify = jest.spyOn(JSON, 'stringify')
  const sanitize = jest.spyOn(chatHistory, 'sanitizeAssistantChatMessages')
  try {
    const first = await store.read()
    const calls = stringify.mock.calls.length
    const sanitized = sanitize.mock.calls.length
    expect(await store.read()).toBe(first)
    expect(stringify.mock.calls).toHaveLength(calls)
    expect(sanitize.mock.calls).toHaveLength(sanitized)
    expect(store['catalogSerializedLength']).toBe(
      JSON.stringify([{ uuid: 'item', record: normalizeSyncedChatRecord(content, 'account') }]).length,
    )
    h.values.set('item', { uuid: 'item', content: writer('a', [entry('two', null)], { revision: 2 }) })
    expect((await store.read())[0].messages).toEqual([message('two')])
    h.values.set('deleted', { uuid: 'deleted', content: writer('b', [], { kind: 'deleted' }) })
    expect(await store.read()).toEqual([])
  } finally {
    stringify.mockRestore()
    sanitize.mockRestore()
  }
})

it('rechecks authorization and sharing before cache access and evicts removed or inadmissible records', async () => {
  const h = harness()
  const content = writer('a', [entry('private', null)])
  const item = { uuid: 'item', content }
  h.values.set(item.uuid, item)
  const authorized = jest.spyOn(h.raw, 'isAuthorizedToRenderItem').mockReturnValue(true)
  const store = new AssistantSyncedChats(h.application, 'a')
  expect((await store.read())[0].messages).toEqual([message('private')])
  authorized.mockReturnValue(false)
  expect(await store.read()).toEqual([])
  expect(store['parsedRecords'].size).toBe(0)
  authorized.mockReturnValue(true)
  expect((await store.read())[0].messages).toEqual([message('private')])
  h.values.set(item.uuid, { ...item, shared_vault_uuid: 'vault' } as typeof item)
  expect(await store.read()).toEqual([])
  h.values.set(item.uuid, { ...item, key_system_identifier: 'shared-key' } as typeof item)
  expect(await store.read()).toEqual([])
  h.values.set(item.uuid, item)
  await store.read()
  h.values.delete(item.uuid)
  expect(await store.read()).toEqual([])
  expect(store['parsedRecords'].size).toBe(0)
  h.values.set(item.uuid, item)
  await store.read()
  h.setLocked(true)
  await expect(store.read()).rejects.toThrow('unlocked')
  expect(store['parsedRecords'].size).toBe(0)
  h.setLocked(false)
  await store.read()
  h.setPrincipal('other')
  await expect(store.read()).rejects.toThrow('unlocked')
  expect(store['previousChats']).toEqual([])
  h.setPrincipal('account')
  await store.read()
  store.dispose()
  expect(store['parsedRecords'].size).toBe(0)
  await expect(store.read()).rejects.toThrow('unlocked')
})

it('remerges only changed chat groups with the same ordering and tombstone results as a full catalog merge', async () => {
  const h = harness()
  h.values.set('a', { uuid: 'a', content: writer('a', [entry('old', null)], { chatId: 'first' }) })
  h.values.set('b', { uuid: 'b', content: writer('b', [entry('unchanged', null)], { chatId: 'second' }) })
  const store = new AssistantSyncedChats(h.application, 'a')
  const initial = await store.read()
  const unchanged = initial.find((chat) => chat.tab.id === 'second')
  const sanitize = jest.spyOn(chatHistory, 'sanitizeAssistantChatMessages')
  try {
    h.values.set('a', {
      uuid: 'a',
      content: writer('a', [entry('new', null)], { chatId: 'first', revision: 2, updatedAt: 999 }),
    })
    const updated = await store.read()
    expect(updated.find((chat) => chat.tab.id === 'second')).toBe(unchanged)
    expect(
      sanitize.mock.calls.flatMap(([messages]) => messages.map((message) => (message as { id: string }).id)),
    ).not.toContain('unchanged')
    expect(updated).toEqual(
      mergeSyncedChats(
        [...h.values.values()].map((item) => ({
          uuid: item.uuid,
          record: normalizeSyncedChatRecord(item.content, 'account')!,
        })),
      ),
    )
    h.values.set('tombstone', {
      uuid: 'tombstone',
      content: writer('c', [], { chatId: 'first', kind: 'deleted' }),
    })
    expect(await store.read()).toEqual([unchanged])
  } finally {
    sanitize.mockRestore()
  }
})

it('preserves the exact catalog length budget for empty, multiple, escaped and unicode records', async () => {
  const h = harness()
  const store = new AssistantSyncedChats(h.application, 'a')
  await store.read()
  expect(store['catalogSerializedLength']).toBe(JSON.stringify([]).length)
  for (const uuid of ['a', 'quote"', 'emoji-🙂']) {
    h.values.set(uuid, { uuid, content: writer('a', [entry('one', null)], { title: 'Quotes " and 🙂' }) })
  }
  await store.read()
  const expected = [...h.values.values()].map((item) => ({
    uuid: item.uuid,
    record: normalizeSyncedChatRecord(item.content, 'account'),
  }))
  expect(store['catalogSerializedLength']).toBe(JSON.stringify(expected).length)
})
it('syncs private checkpoints while preserving other device messages', async () => {
  const h = harness(),
    a = new AssistantSyncedChats(h.application, 'a'),
    b = new AssistantSyncedChats(h.application, 'b'),
    tab = { id: 'chat', title: 'Hello', userRenamed: false }
  await a.save(tab, [message('from-a')])
  await b.save(tab, [message('from-a', 'wrong overwrite'), message('from-b')])
  expect((await b.read())[0].messages).toEqual([message('from-a'), message('from-b')])
  expect(h.raw.mutator.createItem).toHaveBeenCalledWith(
    'SN|AssistantChat',
    expect.objectContaining({ references: [], ownerUuid: 'account' }),
    true,
  )
  expect(h.raw.sync.sync).toHaveBeenCalledWith({ sourceDescription: 'Assistant encrypted chat checkpoint' })
})

it('syncs explicit mode changes independently of titles and preserves them through stale saves and message removal', async () => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(1000)
  try {
    const h = harness(),
      a = new AssistantSyncedChats(h.application, 'a'),
      b = new AssistantSyncedChats(h.application, 'b')
    const staleTab = {
      id: 'chat',
      title: 'Chosen title',
      userRenamed: true,
      conversationMode: 'agent' as const,
      conversationModeUpdatedAt: 1000,
    }
    await a.save(staleTab, [message('one')])
    clock.mockReturnValue(2000)
    await b.updateMetadata({ id: 'chat', title: 'Stale automatic title', userRenamed: false, conversationMode: 'plan' })
    expect((await a.read())[0].tab).toMatchObject({ title: 'Chosen title', conversationMode: 'plan' })
    await a.updateMetadata({ ...staleTab, title: 'Another manual title' })
    expect((await b.read())[0].tab.conversationMode).toBe('plan')
    clock.mockReturnValue(3000)
    await a.save(staleTab, [message('one'), message('two')])
    expect((await b.read())[0].tab.conversationMode).toBe('plan')
    clock.mockReturnValue(4000)
    await b.removeMessage('chat', 'one')
    expect((await a.read())[0]).toMatchObject({ tab: { conversationMode: 'plan' }, messages: [message('two')] })
    expect(JSON.stringify(localStorage)).not.toContain('conversationMode')
    expect([...h.values.values()].some((item) => (item.content as SyncedChatRecord).conversationMode === 'plan')).toBe(
      true,
    )
  } finally {
    clock.mockRestore()
  }
})
it('deletes transcript items after tombstone, denies stale writes and ignores shared vault injection', async () => {
  const h = harness(),
    store = new AssistantSyncedChats(h.application, 'a')
  await store.save({ id: 'chat', title: 'Title', userRenamed: false }, [message('secret')])
  await store.delete('chat')
  expect(await store.read()).toEqual([])
  expect(h.raw.mutator.deleteItem).toHaveBeenCalledTimes(1)
  await expect(store.save({ id: 'chat', title: 'Old', userRenamed: false }, [message('secret')])).rejects.toThrow(
    'deleted',
  )
  h.values.set('shared', {
    uuid: 'shared',
    content: writer('b', [entry('injected', null)], { chatId: 'other' }),
    shared_vault_uuid: 'vault',
  } as never)
  expect(await store.read()).toEqual([])
})
it('fences locked accounts, async principal changes, and disposed views', async () => {
  const h = harness(),
    store = new AssistantSyncedChats(h.application, 'a')
  h.setLocked(true)
  await expect(store.read()).rejects.toThrow('unlocked')
  h.setLocked(false)
  h.raw.protections.isLocked.mockImplementationOnce(async () => {
    h.setPrincipal('other')
    return false
  })
  await expect(store.save({ id: 'chat', title: 'Secret', userRenamed: false }, [message('private')])).rejects.toThrow(
    'unlocked',
  )
  expect(h.raw.mutator.createItem).not.toHaveBeenCalled()
  h.setPrincipal('account')
  store.dispose()
  await expect(store.read()).rejects.toThrow('unlocked')
})

it('metadata-only changes preserve streamed message content and denied tools', async () => {
  const h = harness(),
    store = new AssistantSyncedChats(h.application, 'a')
  await store.save({ id: 'chat', title: 'Old', userRenamed: false }, [message('one')], ['notes.update'])
  await store.updateMetadata({ id: 'chat', title: 'Renamed', userRenamed: true })
  expect((await store.read())[0]).toMatchObject({
    tab: { title: 'Renamed' },
    messages: [message('one')],
    deniedToolNames: ['notes.update'],
  })
})
it('latest complete writer record removes a message even if an older sync-conflict copy still exists', () => {
  const old = record(writer('a', [entry('removed', null)], { revision: 1, updatedAt: 100 })),
    newer = record(writer('a', [], { revision: 2, updatedAt: 90 }))
  expect(mergeSyncedChats([old, newer])[0].messages).toEqual([])
})
it('reuses a window identity across many reloads instead of exhausting writer slots', async () => {
  sessionStorage.clear()
  const held = new Set<string>()
  const previous = navigator.locks
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (name: string, _options: unknown, callback: (lock: object | null) => Promise<void>) => {
        if (held.has(name)) {
          await callback(null)
          return
        }
        held.add(name)
        try {
          await callback({ name })
        } finally {
          held.delete(name)
        }
      },
    },
  })
  try {
    const h = harness()
    for (let reload = 0; reload < 70; reload++) {
      const store = new AssistantSyncedChats(h.application)
      await store.updateMetadata({ id: 'chat', title: 'Chat', userRenamed: false })
      store.dispose()
      await Promise.resolve()
      await Promise.resolve()
    }
    expect(h.values.size).toBe(1)
  } finally {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: previous })
  }
})

it('removes another device’s message and keeps it removed after a late checkpoint', async () => {
  const h = harness(),
    a = new AssistantSyncedChats(h.application, 'a'),
    b = new AssistantSyncedChats(h.application, 'b')
  const tab = { id: 'chat', title: 'Chat', userRenamed: false }
  await a.save(tab, [message('old')])
  await b.removeMessage('chat', 'old')
  expect((await a.read())[0].messages).toEqual([])
  await a.save(tab, [message('old', 'late data'), message('new')])
  expect((await b.read())[0].messages).toEqual([message('new')])
})

it('manual titles survive stale automatic checkpoints and earlier manual titles with newer activity', () => {
  const manual = record(
    writer('b', [], { title: 'Chosen title', userRenamed: true, updatedAt: 200, metadataUpdatedAt: 200 }),
  )
  const staleAuto = record(writer('a', [], { title: 'Auto title', updatedAt: 900, metadataUpdatedAt: 900 }))
  expect(mergeSyncedChats([manual, staleAuto])[0].tab.title).toBe('Chosen title')
  const staleManual = record(
    writer('a', [], { title: 'Previous manual', userRenamed: true, updatedAt: 1000, metadataUpdatedAt: 100 }),
  )
  expect(mergeSyncedChats([manual, staleManual])[0].tab.title).toBe('Chosen title')
})

it('retained chat tombstones do not permanently exhaust the live record count cap', async () => {
  const h = harness()
  for (let index = 0; index < 513; index++)
    h.values.set('deleted-' + index, {
      uuid: 'deleted-' + index,
      content: writer('a', [], { chatId: 'old-' + index, kind: 'deleted' }),
    })
  const store = new AssistantSyncedChats(h.application, 'a')
  await store.save({ id: 'new-chat', title: 'New', userRenamed: false }, [message('new-message')])
  expect((await store.read()).map((chat) => chat.tab.id)).toEqual(['new-chat'])
})
