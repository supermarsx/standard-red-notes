/** @jest-environment jsdom */
import { WebApplication } from '@/Application/WebApplication'
import {
  AssistantSyncedChats,
  mergeSyncedChats,
  normalizeSyncedChatRecord,
  SyncedChatRecord,
} from './assistantSyncedChats'
const message = (id: string, text = id) => ({ id, kind: 'user' as const, text })
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
