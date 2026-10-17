/** @jest-environment jsdom */
import {
  CreateDecryptedItemFromPayload,
  CreateDecryptedMutatorForItem,
  DecryptedPayload,
  ItemContent,
  MutationType,
  PayloadTimestampDefaults,
} from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import * as chatHistory from './assistantChatHistory'
import {
  AssistantSyncedChats,
  AssistantChatStorageError,
  getAssistantChatStorageFailure,
  DEFAULT_ASSISTANT_CHAT_STORAGE_BUDGET,
  readAssistantChatStorageStats,
  MAX_SYNCED_CHAT_FINGERPRINT_BYTES,
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

it('reuses parsed transcripts across content-identical replacement payloads from sync acknowledgements', async () => {
  const h = harness()
  const content = writer('a', [entry('one', null), entry('two', 'one')])
  h.values.set('item', { uuid: 'item', content })
  const store = new AssistantSyncedChats(h.application, 'a')
  const first = await store.read()
  const sanitize = jest.spyOn(chatHistory, 'sanitizeAssistantChatMessages')
  try {
    for (let acknowledgement = 0; acknowledgement < 10; acknowledgement += 1) {
      // DecryptedPayload.copy reconstructs and deep-copies content even when
      // only dirty/sync metadata outside content changed.
      h.values.set('item', { uuid: 'item', content: JSON.parse(JSON.stringify(content)) })
      expect(await store.read()).toBe(first)
    }
    expect(sanitize).not.toHaveBeenCalled()
    // Revision counters are not trusted as a content fingerprint: a different
    // body with identical record counters must still replace the snapshot.
    h.values.set('item', { uuid: 'item', content: writer('a', [entry('replacement', null)]) })
    expect((await store.read())[0].messages).toEqual([message('replacement')])
    expect(sanitize).toHaveBeenCalled()
  } finally {
    sanitize.mockRestore()
  }
})

it('bounds raw fingerprint memory without limiting readable records or reusing uncached invalid replacements', async () => {
  const h = harness()
  // Unknown schema fields are discarded by normalization, but still count in
  // exact-content comparisons. They must not turn the cache into another copy
  // of an arbitrarily large imported catalog.
  for (let index = 0; index < 20; index++) {
    h.values.set(`item-${index}`, {
      uuid: `item-${index}`,
      content: { ...writer(`writer-${index}`, [], { chatId: `chat-${index}` }), padding: 'x'.repeat(512 * 1024) },
    })
  }
  const store = new AssistantSyncedChats(h.application, 'a')
  expect(await store.read()).toHaveLength(20)
  const cache = store as unknown as {
    fingerprintBytes: number
    parsedRecords: Map<string, { serializedContent?: string }>
  }
  const actualBytes = () =>
    [...cache.parsedRecords.values()].reduce((sum, value) => sum + (value.serializedContent?.length ?? 0) * 2, 0)
  expect(actualBytes()).toBeGreaterThan(0)
  expect(actualBytes()).toBeLessThanOrEqual(MAX_SYNCED_CHAT_FINGERPRINT_BYTES)
  expect(cache.fingerprintBytes).toBe(actualBytes())
  expect(cache.parsedRecords.get('item-19')?.serializedContent).toBeUndefined()
  // A valid parsed record without a retained fingerprint must not match a
  // replacement whose serialization also returns undefined.
  h.values.set('item-19', {
    uuid: 'item-19',
    content: { ...writer('writer-19', [], { chatId: 'chat-19' }), padding: 'x'.repeat(1024 * 1024) },
  })
  expect(await store.read()).toHaveLength(19)
  // Invalid but serializable records never retain raw strings either.
  h.values.set('invalid', { uuid: 'invalid', content: { invalid: 'x'.repeat(512 * 1024) } })
  expect(await store.read()).toHaveLength(19)
  expect(cache.parsedRecords.get('invalid')?.serializedContent).toBeUndefined()
  h.values.clear()
  expect(await store.read()).toEqual([])
  expect(cache.fingerprintBytes).toBe(0)
  h.values.set('small', { uuid: 'small', content: writer('small') })
  await store.read()
  expect(cache.fingerprintBytes).toBeGreaterThan(0)
  store.dispose()
  expect(cache.fingerprintBytes).toBe(0)
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
  expect(store['fingerprintBytes']).toBe(0)
  authorized.mockReturnValue(true)
  expect((await store.read())[0].messages).toEqual([message('private')])
  h.values.set(item.uuid, { ...item, shared_vault_uuid: 'vault' } as typeof item)
  expect(await store.read()).toEqual([])
  expect(store['fingerprintBytes']).toBe(0)
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
  expect(store['fingerprintBytes']).toBe(0)
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

it('creates and updates a chat through real payload and item mutators used by the application', async () => {
  const h = harness()
  const uuid = '00000000-0000-4000-8000-000000000001'
  h.raw.mutator.createItem.mockImplementation(async (contentType, content) => {
    const payload = new DecryptedPayload({
      uuid,
      content_type: contentType,
      content: content as ItemContent,
      dirty: true,
      ...PayloadTimestampDefaults(),
    })
    const item = CreateDecryptedItemFromPayload(payload)
    h.values.set(uuid, item)
    return item
  })
  h.raw.mutator.changeItem.mockImplementation(async (item, change) => {
    const current = h.values.get(item.uuid)!
    const mutator = CreateDecryptedMutatorForItem(
      current as ReturnType<typeof CreateDecryptedItemFromPayload>,
      MutationType.UpdateUserTimestamps,
    )
    change({ setCustomContent: (content: unknown) => mutator.setCustomContent(content as ItemContent) })
    h.values.set(item.uuid, CreateDecryptedItemFromPayload(mutator.getResult()))
  })
  const store = new AssistantSyncedChats(h.application, 'writer')
  const tab = { id: 'chat', title: 'Chat', userRenamed: false }
  await store.save(tab, [])
  await store.save(tab, [message('question'), { id: 'answer', kind: 'assistant', text: '' }])
  expect(h.raw.mutator.createItem).toHaveBeenCalledTimes(1)
  expect(h.raw.mutator.changeItem).toHaveBeenCalledTimes(1)
  expect((await store.read())[0].messages).toContainEqual(message('question'))
  expect(h.raw.sync.sync).toHaveBeenCalledTimes(2)
})

it.each([
  [new Error('private transport exception secret'), 'WRITE_FAILED'],
  [new DOMException('private browser quota details', 'QuotaExceededError'), 'QUOTA_EXCEEDED'],
])('classifies local checkpoint failures without exposing exception contents: %s', async (error, code) => {
  const h = harness()
  h.raw.mutator.createItem.mockRejectedValueOnce(error)
  const store = new AssistantSyncedChats(h.application, 'writer')
  let failure: unknown
  try {
    await store.save({ id: 'chat', title: 'Chat', userRenamed: false }, [message('question')])
  } catch (error) {
    failure = error
  }
  expect(getAssistantChatStorageFailure(failure)).toMatchObject({ code, stage: 'write' })
  expect(JSON.stringify(getAssistantChatStorageFailure(failure))).not.toContain('private')
  expect(h.raw.sync.sync).not.toHaveBeenCalled()
})

it('distinguishes a sync checkpoint failure after the local item mutation succeeded', async () => {
  const h = harness()
  h.raw.sync.sync.mockRejectedValueOnce(new Error('private gateway detail'))
  const store = new AssistantSyncedChats(h.application, 'writer')
  await expect(
    store.save({ id: 'chat', title: 'Chat', userRenamed: false }, [message('question')]),
  ).rejects.toMatchObject({ code: 'SYNC_FAILED', stage: 'checkpoint' })
  expect((await store.read())[0].messages).toEqual([message('question')])
})

it('returns only allowlisted diagnostics for unknown or tampered exceptions', () => {
  expect(getAssistantChatStorageFailure(new Error('secret note content'))).toMatchObject({
    code: 'UNKNOWN_FAILURE',
    stage: 'checkpoint',
  })
  const error = new AssistantChatStorageError('WRITE_FAILED', 'write')
  Object.assign(error, { code: 'secret note content', stage: 'secret hostname' })
  expect(getAssistantChatStorageFailure(error)).toMatchObject({ code: 'UNKNOWN_FAILURE', stage: 'checkpoint' })
  expect(JSON.stringify(getAssistantChatStorageFailure(error))).not.toContain('secret')
})

it('saves the initial user message through the normal browser writer admission path', async () => {
  const previous = navigator.locks
  const request = jest.fn(async (_name: string, _options: unknown, callback: (lock: object) => Promise<void>) =>
    callback({}),
  )
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })
  const h = harness()
  const store = new AssistantSyncedChats(h.application)
  try {
    await store.save({ id: 'fresh-chat', title: 'New chat', userRenamed: false }, [message('first')])
    expect(request).toHaveBeenCalledTimes(1)
    expect((await store.read())[0].messages).toEqual([message('first')])
    expect(h.raw.sync.sync).toHaveBeenCalledTimes(1)
  } finally {
    store.dispose()
    Object.defineProperty(navigator, 'locks', { configurable: true, value: previous })
  }
})

it.each(['reject', 'throw'] as const)(
  'reports browser writer admission %s without falsely claiming another live owner',
  async (mode) => {
    const previous = navigator.locks
    const failure = new DOMException('private browser details', 'InvalidStateError')
    const request = jest.fn(() => {
      if (mode === 'throw') throw failure
      return Promise.reject(failure)
    })
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })
    const h = harness()
    const store = new AssistantSyncedChats(h.application)
    try {
      await expect(
        store.save({ id: 'fresh-chat', title: 'New chat', userRenamed: false }, [message('first')]),
      ).rejects.toMatchObject({ code: 'WRITER_UNAVAILABLE', stage: 'writer', cause: 'InvalidStateError' })
      expect(request).toHaveBeenCalledTimes(1)
      expect(h.raw.mutator.createItem).not.toHaveBeenCalled()
    } finally {
      store.dispose()
      Object.defineProperty(navigator, 'locks', { configurable: true, value: previous })
    }
  },
)

it.each(['TypeError', 'InvalidStateError', 'AbortError', 'SecurityError'] as const)(
  'retains only the bounded %s exception kind',
  (name) => {
    expect(getAssistantChatStorageFailure(new DOMException('private data', name))).toMatchObject({
      code: 'UNKNOWN_FAILURE',
      stage: 'checkpoint',
      cause: name,
    })
  },
)

it('trashes and restores encrypted history without letting stale writers undo trash', async () => {
  const h = harness(),
    a = new AssistantSyncedChats(h.application, 'a'),
    b = new AssistantSyncedChats(h.application, 'b')
  const tab = { id: 'chat', title: 'Keep title', userRenamed: true }
  await a.save(tab, [message('question')])
  await b.trash('chat')
  expect(await a.read()).toEqual([])
  expect((await a.read({ includeTrashed: true }))[0]).toMatchObject({
    trashed: true,
    tab,
    messages: [message('question')],
  })
  await expect(a.save(tab, [message('late')])).rejects.toMatchObject({ code: 'CHAT_TRASHED' })
  h.values.set('late-writer', {
    uuid: 'late-writer',
    content: writer('late', [entry('late', null)], { revision: 999 }),
  })
  expect(await a.read()).toEqual([])
  await a.restore('chat')
  expect((await b.read())[0].messages.map((m) => m.id)).toEqual(expect.arrayContaining(['question', 'late']))
  expect((await b.read())[0].tab.title).toBe('Keep title')
  await a.delete('chat')
  await expect(b.restore('chat')).rejects.toMatchObject({ code: 'CHAT_DELETED' })
})

it('resolves concurrent lifecycle clocks deterministically with trash winning ties', () => {
  const content = record(writer('a', [entry('one', null)]))
  const trash = record(writer('trash', [], { kind: 'lifecycle', state: 'trashed', revision: 3 }))
  const restore = record(writer('restore', [], { kind: 'lifecycle', state: 'active', revision: 3, updatedAt: 9999 }))
  expect(mergeSyncedChats([content, trash, restore])).toEqual([])
  expect(mergeSyncedChats([restore, content, trash], true)[0].trashed).toBe(true)
  restore.record.revision = 4
  expect(mergeSyncedChats([content, trash, restore])[0].messages).toEqual([message('one')])
})

it('retries partially failed purge and cleans late payloads while retaining content-free tombstones', async () => {
  const h = harness(),
    store = new AssistantSyncedChats(h.application, 'a')
  await store.save({ id: 'chat', title: 'Private', userRenamed: false }, [message('secret')])
  h.raw.mutator.deleteItem.mockRejectedValueOnce(new Error('delete failed'))
  await expect(store.delete('chat')).rejects.toMatchObject({ code: 'WRITE_FAILED', stage: 'write' })
  expect(await store.read()).toEqual([])
  await store.delete('chat')
  expect([...h.values.values()].map((item) => (item.content as SyncedChatRecord).kind)).toEqual(['deleted'])
  h.values.set('late', { uuid: 'late', content: writer('late', [entry('secret-late', null)]) })
  await store.emptyTrash()
  expect([...h.values.values()].map((item) => (item.content as SyncedChatRecord).kind)).toEqual(['deleted'])
  expect(JSON.stringify([...h.values.values()])).not.toContain('secret')
})

it('reports all active, trashed, hidden deleted and invalid storage records without a 100-chat read cap', async () => {
  const h = harness(),
    store = new AssistantSyncedChats(h.application, 'a')
  for (let i = 0; i < 105; i++)
    h.values.set('chat-' + i, { uuid: 'chat-' + i, content: writer('a', [], { chatId: 'chat-' + i }) })
  h.values.set('invalid', { uuid: 'invalid', content: { version: 99 } })
  await store.trash('chat-0')
  await store.delete('chat-1')
  expect(await store.read()).toHaveLength(103)
  expect(await store.read({ includeTrashed: true })).toHaveLength(104)
  const stats = await store.getStorageStats()
  expect(stats).toMatchObject({
    activeChats: 103,
    trashedChats: 1,
    deletedChats: 1,
    writerRecords: 104,
    lifecycleRecords: 1,
    invalidRecords: 1,
  })
  expect(stats.serializedUnits).toBeGreaterThan(0)
  expect(await readAssistantChatStorageStats(h.application, 'account:other')).toBeUndefined()
  expect(await readAssistantChatStorageStats(h.application, 'account:account')).toEqual(stats)
  h.setLocked(true)
  expect(await readAssistantChatStorageStats(h.application, 'account:account')).toBeUndefined()
})

it('allows a shrinking replacement over the size budget but rejects projected growth', async () => {
  const h = harness(),
    store = new AssistantSyncedChats(h.application, 'a', { serializedUnits: 3000 })
  for (let i = 0; i < 3; i++) {
    const entries = Array.from({ length: 1 }, (_, j) => ({
      ...entry('m-' + i + '-' + j, null),
      message: message('m-' + i + '-' + j, 'x'.repeat(2000)),
    }))
    h.values.set('large-' + i, { uuid: 'large-' + i, content: writer(i === 0 ? 'a' : 'writer-' + i, entries) })
  }
  const before = await store.getStorageStats()
  expect(before.serializedUnits).toBeGreaterThan(before.limits.serializedUnits)
  await store.save({ id: 'chat', title: 'Shorter', userRenamed: false }, [])
  const after = await store.getStorageStats()
  expect(after.serializedUnits).toBeLessThan(before.serializedUnits)
  await expect(
    store.save({ id: 'chat', title: 'Shorter', userRenamed: false }, [message('new', 'x'.repeat(2000))]),
  ).rejects.toMatchObject({ code: 'STORAGE_SIZE_LIMIT' })
  await store.trash('chat')
  await store.emptyTrash()
  expect((await store.getStorageStats()).writerRecords).toBe(0)
})

it('does not purge a chat restored before queued trash cleanup, or sync clean tombstones repeatedly', async () => {
  const h = harness(),
    store = new AssistantSyncedChats(h.application, 'a')
  await store.save({ id: 'chat', title: 'Keep', userRenamed: false }, [message('keep')])
  await store.trash('chat')
  const cleanup = store.emptyTrash()
  const restore = store.restore('chat')
  await Promise.all([cleanup, restore])
  expect(await store.read()).toHaveLength(1)
  await store.purgeTrashed('chat')
  expect(await store.read()).toHaveLength(1)
  await store.delete('chat')
  const calls = h.raw.sync.sync.mock.calls.length
  await store.emptyTrash()
  expect(h.raw.sync.sync).toHaveBeenCalledTimes(calls)
  h.values.set('late', { uuid: 'late', content: writer('late', [entry('late', null)]) })
  expect((await store.getStorageStats()).deletedResidualRecords).toBe(1)
  await store.emptyTrash()
  expect((await store.getStorageStats()).deletedResidualRecords).toBe(0)
})

it('rejects new writes whose projected size crosses the budget from below', async () => {
  const h = harness(),
    store = new AssistantSyncedChats(h.application, 'a', { serializedUnits: 3000 })
  h.values.set('existing', {
    uuid: 'existing',
    content: writer('a', [{ ...entry('one', null), message: message('one', 'x'.repeat(2000)) }]),
  })
  const stats = await store.getStorageStats()
  expect(stats.serializedUnits).toBeLessThan(stats.limits.serializedUnits)
  await expect(
    store.save({ id: 'new', title: 'New', userRenamed: false }, [message('new', 'x'.repeat(2000))]),
  ).rejects.toMatchObject({ code: 'STORAGE_SIZE_LIMIT' })
  expect(h.raw.mutator.createItem).not.toHaveBeenCalled()
})

it('uses generous defaults and reports validated per-store admission limits', async () => {
  expect(DEFAULT_ASSISTANT_CHAT_STORAGE_BUDGET).toEqual({
    chats: 1000,
    records: 8192,
    serializedUnits: 256 * 1024 * 1024,
  })
  const h = harness(),
    store = new AssistantSyncedChats(h.application, 'a', { chats: 1, records: 2, serializedUnits: 4096 })
  expect((await store.getStorageStats()).limits).toMatchObject({
    chats: 1,
    records: 2,
    serializedUnits: 4096,
    recordUnits: 1024 * 1024,
    writersPerChat: 64,
  })
  await store.save({ id: 'one', title: 'One', userRenamed: false }, [])
  await expect(store.save({ id: 'two', title: 'Two', userRenamed: false }, [])).rejects.toMatchObject({
    code: 'CHAT_LIMIT',
  })
  for (const value of [0, -1, NaN, Infinity, 1.5, 1001])
    expect(() => new AssistantSyncedChats(h.application, 'b', { chats: value })).toThrow(RangeError)
})

it('uses the effective writer-record budget without blocking edits to an existing record', async () => {
  const h = harness(),
    a = new AssistantSyncedChats(h.application, 'a', { records: 1 }),
    b = new AssistantSyncedChats(h.application, 'b', { records: 1 })
  const tab = { id: 'chat', title: 'Chat', userRenamed: false }
  await a.save(tab, [message('one')])
  await expect(b.save(tab, [message('two')])).rejects.toMatchObject({ code: 'STORAGE_RECORD_LIMIT' })
  await a.save(tab, [message('one', 'updated')])
  expect((await a.read())[0].messages).toEqual([message('one', 'updated')])
})

it('does not charge trash or deleted residual records against active admission and checks restore', async () => {
  const h = harness(),
    store = new AssistantSyncedChats(h.application, 'a', { chats: 1, records: 1, serializedUnits: 1500 })
  await store.save({ id: 'old', title: 'Old', userRenamed: false }, [message('old', 'x'.repeat(800))])
  await store.trash('old')
  await store.save({ id: 'new', title: 'New', userRenamed: false }, [message('new')])
  await expect(store.restore('old')).rejects.toMatchObject({ code: 'CHAT_LIMIT' })
  await store.delete('old')
  h.values.set('ghost', {
    uuid: 'ghost',
    content: writer('ghost', [{ ...entry('ghost', null), message: message('ghost', 'x'.repeat(8000)) }], {
      chatId: 'old',
    }),
  })
  await store.save({ id: 'new', title: 'New', userRenamed: false }, [message('new', 'still writable')])
  const stats = await store.getStorageStats()
  expect(stats.budgetedWriterRecords).toBe(1)
  expect(stats.budgetedSerializedUnits).toBeLessThan(stats.limits.serializedUnits)
  expect(stats.serializedUnits).toBeGreaterThan(stats.limits.serializedUnits)
  expect(stats.deletedSerializedUnits).toBeGreaterThan(8000)
})

it('expires only acknowledged trash older than 30 days and retains a terminal marker', async () => {
  const h = harness(),
    store = new AssistantSyncedChats(h.application, 'a')
  const now = Date.UTC(2026, 9, 17),
    day = 24 * 60 * 60 * 1000
  const clock = jest.spyOn(Date, 'now').mockReturnValue(now)
  try {
    h.values.set('body', { uuid: 'body', content: writer('a', [entry('secret', null)]) })
    const trash = writer('a', [], { kind: 'lifecycle', state: 'trashed', updatedAt: now - 31 * day })
    h.values.set('trash', {
      uuid: 'trash',
      content: trash,
      dirty: true,
      serverUpdatedAtTimestamp: now - 31 * day,
    } as never)
    await store.pruneExpiredTrash()
    expect(h.values.has('body')).toBe(true)
    h.values.set('trash', { uuid: 'trash', content: trash, dirty: false, serverUpdatedAtTimestamp: now - day } as never)
    await store.pruneExpiredTrash()
    expect(h.values.has('body')).toBe(true)
    h.values.set('trash', {
      uuid: 'trash',
      content: trash,
      dirty: false,
      serverUpdatedAtTimestamp: now - 31 * day,
    } as never)
    const syncCalls = h.raw.sync.sync.mock.calls.length
    await store.pruneExpiredTrash()
    expect(h.values.has('body')).toBe(false)
    expect([...h.values.values()].map((item) => (item.content as SyncedChatRecord).kind)).toEqual(['deleted'])
    expect(h.raw.sync.sync).toHaveBeenCalledTimes(syncCalls + 1)
    h.values.set('late', { uuid: 'late', content: writer('late', [entry('late', null)]) })
    expect(await store.read()).toEqual([])
    await store.pruneExpiredTrash()
    expect(h.values.has('late')).toBe(false)
  } finally {
    clock.mockRestore()
  }
})

it('rechecks restored or freshly re-trashed lifecycle state before queued expiry', async () => {
  const h = harness(),
    store = new AssistantSyncedChats(h.application, 'a')
  const now = Date.UTC(2026, 9, 17),
    old = now - 31 * 24 * 60 * 60 * 1000
  const clock = jest.spyOn(Date, 'now').mockReturnValue(now)
  try {
    h.values.set('body', { uuid: 'body', content: writer('a', [entry('keep', null)]) })
    h.values.set('trash', {
      uuid: 'trash',
      content: writer('a', [], { kind: 'lifecycle', state: 'trashed', updatedAt: old }),
      dirty: false,
      serverUpdatedAtTimestamp: old,
    } as never)
    const cleanup = store.pruneExpiredTrash()
    const restore = store.restore('chat')
    await Promise.all([cleanup, restore])
    expect(await store.read()).toHaveLength(1)
    await store.trash('chat')
    await store.pruneExpiredTrash()
    expect((await store.read({ includeTrashed: true }))[0].messages).toEqual([message('keep')])
  } finally {
    clock.mockRestore()
  }
})

it('uses cached serialized lengths for unrelated transcripts during checkpoint admission and statistics', async () => {
  const h = harness(),
    store = new AssistantSyncedChats(h.application, 'a')
  h.values.set('own', { uuid: 'own', content: writer('a', [entry('own', null)]) })
  h.values.set('unrelated', { uuid: 'unrelated', content: writer('b', [entry('other', null)], { chatId: 'other' }) })
  await store.read()
  const stringify = jest.spyOn(JSON, 'stringify')
  try {
    await store.save({ id: 'chat', title: 'Chat', userRenamed: false }, [message('own', 'updated')])
    await store.getStorageStats()
    expect(
      stringify.mock.calls.filter(([value]) => value?.uuid === 'unrelated' || value?.chatId === 'other'),
    ).toHaveLength(0)
  } finally {
    stringify.mockRestore()
  }
})

it('bounds retention maintenance to 25 rooms and one sync while deferring unacknowledged trash', async () => {
  const h = harness(),
    store = new AssistantSyncedChats(h.application, 'a')
  const now = Date.UTC(2026, 9, 17),
    old = now - 31 * 24 * 60 * 60 * 1000
  const clock = jest.spyOn(Date, 'now').mockReturnValue(now)
  try {
    for (let i = 0; i < 26; i++) {
      const chatId = 'old-' + i
      h.values.set('body-' + i, { uuid: 'body-' + i, content: writer('a', [entry('m-' + i, null)], { chatId }) })
      h.values.set('trash-' + i, {
        uuid: 'trash-' + i,
        content: writer('a', [], { chatId, kind: 'lifecycle', state: 'trashed', updatedAt: old }),
        dirty: false,
        serverUpdatedAtTimestamp: old,
      } as never)
    }
    h.values.set('missing-body', { uuid: 'missing-body', content: writer('a', [], { chatId: 'missing' }) })
    h.values.set('missing-trash', {
      uuid: 'missing-trash',
      content: writer('a', [], { chatId: 'missing', kind: 'lifecycle', state: 'trashed', updatedAt: old }),
    })
    await store.pruneExpiredTrash()
    expect((await store.getStorageStats()).deletedChats).toBe(25)
    expect(h.raw.sync.sync).toHaveBeenCalledTimes(1)
    await store.pruneExpiredTrash()
    expect((await store.getStorageStats()).deletedChats).toBe(26)
    expect(h.raw.sync.sync).toHaveBeenCalledTimes(2)
    expect(h.values.has('missing-body')).toBe(true)
    await store.pruneExpiredTrash()
    expect(h.raw.sync.sync).toHaveBeenCalledTimes(2)
  } finally {
    clock.mockRestore()
  }
})

it('syncs independent composer fields across writers without replacing transcript or renamed metadata', async () => {
  const h = harness()
  const a = new AssistantSyncedChats(h.application, 'composer-a')
  const b = new AssistantSyncedChats(h.application, 'composer-b')
  const tab = { id: 'chat', title: 'Named chat', userRenamed: true }
  await a.save(tab, [message('existing')])
  await Promise.all([
    a.checkpointComposer('chat', { draft: { text: 'Unsent draft' } }),
    b.checkpointComposer('chat', { context: { scope: 'current-note' }, toolPermissionMode: 'ask' }),
  ])
  let chat = (await b.read())[0]
  expect(chat.composer?.draft?.value?.text).toBe('Unsent draft')
  expect(chat.composer?.context?.value.scope).toBe('current-note')
  expect(chat.composer?.toolPermissionMode?.value).toBe('ask')
  expect(chat.messages).toEqual([message('existing')])
  expect(chat.tab.title).toBe('Named chat')
  await a.save(tab, [message('existing'), message('answer')])
  await a.removeMessage('chat', 'answer')
  await b.checkpointComposer('chat', { draft: null })
  chat = (await a.read())[0]
  expect(chat.composer?.draft?.value).toBeNull()
  expect(chat.composer?.context?.value.scope).toBe('current-note')
  expect(chat.messages).toEqual([message('existing')])
  await a.trash('chat')
  await expect(a.checkpointComposer('chat', { draft: { text: 'late' } })).rejects.toMatchObject({
    code: 'CHAT_TRASHED',
  })
  await a.delete('chat')
  await expect(a.checkpointComposer('chat', { draft: null })).rejects.toMatchObject({ code: 'CHAT_DELETED' })
})

it('advances each composer clock despite a backwards local clock and merges ties deterministically', async () => {
  const h = harness()
  const store = new AssistantSyncedChats(h.application, 'a')
  const clock = jest.spyOn(Date, 'now').mockReturnValue(5000)
  try {
    await store.checkpointComposer('chat', { draft: { text: 'first' } })
    clock.mockReturnValue(1)
    await store.checkpointComposer('chat', { draft: { text: 'second' } })
    const chat = (await store.read())[0]
    expect(chat.composer?.draft?.updatedAt).toBe(5001)
    const a = record(writer('a', [], { composer: { draft: { value: { text: 'A' }, updatedAt: 10 } } }))
    const b = record(writer('b', [], { composer: { draft: { value: null, updatedAt: 10 } } }))
    expect(mergeSyncedChats([a, b])).toEqual(mergeSyncedChats([b, a]))
    expect(mergeSyncedChats([a, b])[0].composer?.draft?.value).toBeNull()
  } finally {
    clock.mockRestore()
  }
})

it('does not change an equal-clock composer winner when another writer updates unrelated transcript metadata', () => {
  const a = record(writer('a', [], { updatedAt: 100, composer: { draft: { value: { text: 'A' }, updatedAt: 10 } } }))
  const b = record(writer('b', [], { updatedAt: 1, composer: { draft: { value: { text: 'B' }, updatedAt: 10 } } }))
  expect(mergeSyncedChats([a, b])[0].composer?.draft?.value?.text).toBe('B')
  a.record = { ...a.record, revision: 999, updatedAt: 9999, entries: [entry('new-message', null)] }
  expect(mergeSyncedChats([a, b])[0].composer?.draft?.value?.text).toBe('B')
})

it('writes drafts to a stable lightweight record without rewriting the transcript', async () => {
  const h = harness()
  const store = new AssistantSyncedChats(h.application, 'writer-session')
  const tab = { id: 'chat', title: 'Long chat', userRenamed: true }
  await store.save(tab, [message('long', 'body '.repeat(1000))])
  const transcript = [...h.values.values()][0]
  await store.checkpointComposer('chat', { draft: { text: 'first draft' } })
  expect(h.values.get(transcript.uuid)).toBe(transcript)
  const draftRecord = [...h.values.values()].find((item) => item.uuid !== transcript.uuid)!
  expect((draftRecord.content as SyncedChatRecord).entries).toEqual([])
  expect((draftRecord.content as SyncedChatRecord).writerId).toMatch(/^composer-[A-Za-z0-9_-]{43}$/)
  expect((await store.getStorageStats()).writerRecords).toBe(2)
  await store.checkpointComposer('chat', { draft: { text: 'second draft' } })
  expect(h.values.size).toBe(2)
  expect(h.values.get(transcript.uuid)).toBe(transcript)
  expect((await store.read())[0].messages).toEqual([message('long', 'body '.repeat(1000))])
  const reopened = new AssistantSyncedChats(h.application, 'writer-session')
  await reopened.checkpointComposer('chat', { draft: null })
  expect(h.values.size).toBe(2)
  expect((await reopened.read())[0].composer?.draft?.value).toBeNull()
})
