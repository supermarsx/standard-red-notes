import { ContentType, SNUserPrefs } from '@standardnotes/snjs'
import {
  mutatePrivateNoteComments,
  normalizePrivateComments,
  readPrivateNoteComments,
  privateCommentsReadError,
  MAX_PRIVATE_COMMENT_BYTES,
} from './PrivateNoteComments'
import { PRIVATE_COMMENT_CONTENT_TYPE, MAX_PRIVATE_OPERATION_RECORDS } from './PrivateCommentOperations'
import { NoteComment } from './comments'

const comment = (id: string): NoteComment => ({
  id: `user-a:${id}`,
  authorUuid: 'user-a',
  authorName: 'You',
  text: 'Private task observation',
  createdAt: '2026-10-15T12:00:00.000Z',
})
let counter = 0
function fixture() {
  let user = { uuid: 'user-a' }
  let stored: unknown
  const records: any[] = []
  const preferences = Object.create(SNUserPrefs.prototype) as SNUserPrefs
  Object.defineProperties(preferences, {
    uuid: { value: 'personal-prefs' },
    deleted: { value: false },
    shared_vault_uuid: { value: undefined },
    key_system_identifier: { value: undefined },
    getPref: { value: () => stored },
  })
  const note = { uuid: 'shared-note', shared_vault_uuid: 'shared-vault', trashed: false }
  const createItem = jest.fn(async (content_type: string, content: unknown) => {
    const item = { uuid: `operation-${++counter}`, content_type, content }
    records.push(item)
    return item
  })
  const raw = {
    sessions: { getUser: () => user, isCurrentSessionReadOnly: () => false },
    items: {
      getItems: (type: string) => (type === ContentType.TYPES.UserPrefs ? [preferences] : records),
      findItem: (uuid: string) => records.find((item) => item.uuid === uuid) ?? note,
      invalidItems: [] as any[],
    },
    isAuthorizedToRenderItem: () => true,
    mutator: {
      createItem,
      changeItem: jest.fn(),
      deleteItem: jest.fn(async (item: any) => {
        const index = records.indexOf(item)
        if (index >= 0) records.splice(index, 1)
      }),
    },
    sync: { isDatabaseLoaded: () => true, sync: jest.fn(async () => undefined) },
  }
  return {
    application: raw as never,
    raw,
    records,
    createItem,
    setStored: (value: unknown) => {
      stored = value
    },
    switchAccount: () => {
      user = { uuid: 'user-b' }
    },
  }
}
const replicate = (a: ReturnType<typeof fixture>, b: ReturnType<typeof fixture>) => {
  const union = new Map([...a.records, ...b.records].map((item) => [item.uuid, item]))
  a.records.splice(0, a.records.length, ...union.values())
  b.records.splice(0, b.records.length, ...[...union.values()].reverse())
}
const read = (f: ReturnType<typeof fixture>, note = 'shared-note') => readPrivateNoteComments(f.application, note)

describe('personal encrypted operation comment storage', () => {
  it('prunes superseded payloads only after an exact snapshot acknowledgement and retains deletion fences', async () => {
    const f = fixture()
    f.raw.sync.sync.mockImplementation(async () => {
      for (const item of f.records) item.dirty = false
    })
    await mutatePrivateNoteComments(f.application, 'shared-note', () => [comment('one'), comment('two')])
    const stale = f.records[0]
    await mutatePrivateNoteComments(f.application, 'shared-note', (items) =>
      items.filter((item) => item.id !== 'user-a:one'),
    )
    expect(f.raw.mutator.deleteItem).toHaveBeenCalledTimes(2)
    expect(f.records).toHaveLength(2)
    expect(JSON.stringify(f.records)).not.toContain('user-a:one","clock":1,"comment"')
    f.records.push(stale)
    expect(read(f)).toEqual([comment('two')])
  })

  it('retains source history when sync resolves without acknowledging the replacement', async () => {
    const f = fixture()
    await mutatePrivateNoteComments(f.application, 'shared-note', () => [comment('one')])
    await mutatePrivateNoteComments(f.application, 'shared-note', () => [])
    expect(f.records).toHaveLength(3)
    expect(f.raw.mutator.deleteItem).not.toHaveBeenCalled()
    expect(read(f)).toEqual([])
  })

  it('does not prune history after a failed snapshot sync', async () => {
    const f = fixture()
    await mutatePrivateNoteComments(f.application, 'shared-note', () => [comment('one')])
    f.raw.sync.sync.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('offline'))
    await expect(mutatePrivateNoteComments(f.application, 'shared-note', () => [])).resolves.toBeUndefined()
    expect(f.raw.mutator.deleteItem).not.toHaveBeenCalled()
    expect(read(f)).toEqual([])
  })

  it('retains concurrent new records arriving during the snapshot acknowledgement', async () => {
    const f = fixture(),
      other = fixture()
    await mutatePrivateNoteComments(f.application, 'shared-note', () => [comment('one')])
    await mutatePrivateNoteComments(other.application, 'shared-note', () => [comment('new')])
    f.raw.sync.sync.mockImplementation(async () => {
      if (f.records.length === 3) f.records.push(other.records[0])
      for (const item of f.records) item.dirty = false
    })
    await mutatePrivateNoteComments(f.application, 'shared-note', () => [])
    expect(read(f)).toEqual([comment('new')])
    expect(f.records.some((item) => item.uuid === other.records[0].uuid)).toBe(true)
  })

  it('refuses cleanup when an acknowledged snapshot has different contents', async () => {
    const f = fixture()
    await mutatePrivateNoteComments(f.application, 'shared-note', () => [comment('one')])
    f.raw.sync.sync.mockImplementation(async () => {
      if (f.records.length === 3) {
        const snapshot = f.records[2]
        f.records[2] = { ...snapshot, dirty: false, content: { ...snapshot.content, changes: [] } }
      }
    })
    await mutatePrivateNoteComments(f.application, 'shared-note', () => [])
    expect(f.raw.mutator.deleteItem).not.toHaveBeenCalled()
  })

  it('compacts acknowledged obsolete operations before applying the active record budget', async () => {
    const f = fixture()
    for (let index = 0; index < MAX_PRIVATE_OPERATION_RECORDS; index++)
      f.records.push({
        uuid: `old-${index}`,
        content_type: PRIVATE_COMMENT_CONTENT_TYPE,
        content: {
          version: 2,
          ownerUuid: 'user-a',
          operationId: `old-${index}`,
          changes: [{ noteUuid: 'shared-note', id: comment('one').id, clock: index + 1, comment: comment('one') }],
        },
      })
    f.raw.sync.sync.mockImplementation(async () => {
      for (const item of f.records) item.dirty = false
    })
    await mutatePrivateNoteComments(f.application, 'shared-note', (items) => [...items, comment('two')])
    expect(f.records).toHaveLength(2)
    expect(read(f).map((item) => item.id)).toEqual(['user-a:one', 'user-a:two'])
  })

  it('keeps migrated clock-zero comments above later stale legacy preference snapshots', async () => {
    const f = fixture()
    f.setStored({ version: 1, ownerUuid: 'user-a', notes: { 'shared-note': [comment('old')] } })
    await mutatePrivateNoteComments(f.application, 'other-note', () => [comment('new')])
    f.setStored({
      version: 1,
      ownerUuid: 'user-a',
      notes: { 'shared-note': [{ ...comment('old'), text: 'stale legacy changed' }] },
    })
    expect(read(f)).toEqual([comment('old')])
  })

  it('does not prune any source when only one of several snapshot chunks is acknowledged', async () => {
    const f = fixture()
    await mutatePrivateNoteComments(f.application, 'shared-note', () => [comment('one'), comment('two')])
    f.raw.sync.sync.mockImplementation(async () => {
      if (f.records.length === 4) f.records[2].dirty = false
    })
    await mutatePrivateNoteComments(f.application, 'shared-note', (items) =>
      items.filter((item) => item.id !== 'user-a:one'),
    )
    expect(f.records).toHaveLength(4)
    expect(f.raw.mutator.deleteItem).not.toHaveBeenCalled()
  })

  it('converges when two devices compact overlapping history concurrently', async () => {
    const a = fixture(),
      b = fixture()
    await mutatePrivateNoteComments(a.application, 'shared-note', () => [comment('one'), comment('two')])
    replicate(a, b)
    let arrivals = 0
    let release!: () => void
    const checkpoint = new Promise<void>((resolve) => {
      release = resolve
    })
    for (const f of [a, b])
      f.raw.sync.sync.mockImplementation(async (options?: any) => {
        if (options?.sourceDescription === 'Private comment compaction checkpoint') {
          arrivals++
          if (arrivals === 2) {
            replicate(a, b)
            for (const item of a.records) item.dirty = false
            release()
          }
          await checkpoint
        }
      })
    await Promise.all([
      mutatePrivateNoteComments(a.application, 'shared-note', (items) =>
        items.filter((item) => item.id !== 'user-a:one'),
      ),
      mutatePrivateNoteComments(b.application, 'shared-note', (items) =>
        items.filter((item) => item.id !== 'user-a:two'),
      ),
    ])
    replicate(a, b)
    expect(read(a)).toEqual([])
    expect(read(b)).toEqual([])
    expect(a.raw.mutator.deleteItem).toHaveBeenCalled()
    expect(b.raw.mutator.deleteItem).toHaveBeenCalled()
  })

  it('replaces hidden replies to permanently deleted parents with content-free deletion fences', async () => {
    const f = fixture()
    await mutatePrivateNoteComments(f.application, 'shared-note', () => [
      comment('parent'),
      { ...comment('reply'), parentId: comment('parent').id, text: 'Secret orphan payload' },
    ])
    f.raw.sync.sync.mockImplementation(async () => {
      for (const item of f.records) item.dirty = false
    })
    await mutatePrivateNoteComments(f.application, 'shared-note', (items) =>
      items.filter((item) => item.id !== comment('parent').id),
    )
    expect(JSON.stringify(f.records)).not.toContain('Secret orphan payload')
    expect(
      f.records
        .flatMap((item) => item.content.changes)
        .filter((change: any) => change.deleted)
        .map((change: any) => change.id)
        .sort(),
    ).toEqual([comment('parent').id, comment('reply').id].sort())
    expect(read(f)).toEqual([])
  })

  it('writes independent account-private items and retains concurrent local additions without modifying preferences or the shared note', async () => {
    const f = fixture()
    await Promise.all([
      mutatePrivateNoteComments(f.application, 'shared-note', (items) => [...items, comment('one')]),
      mutatePrivateNoteComments(f.application, 'shared-note', (items) => [...items, comment('two')]),
    ])
    expect(read(f).map((value) => value.id)).toEqual(['user-a:one', 'user-a:two'])
    expect(f.raw.mutator.changeItem).not.toHaveBeenCalled()
    expect(f.createItem).toHaveBeenCalledWith(
      PRIVATE_COMMENT_CONTENT_TYPE,
      expect.objectContaining({ ownerUuid: 'user-a', references: [] }),
      true,
    )
    expect(f.records.every((item) => !item.shared_vault_uuid && !item.key_system_identifier)).toBe(true)
  })

  it('merges independent same-note and cross-note additions from disconnected devices in either delivery order', async () => {
    const a = fixture(),
      b = fixture()
    await mutatePrivateNoteComments(a.application, 'shared-note', () => [comment('one')])
    await mutatePrivateNoteComments(b.application, 'shared-note', () => [comment('two')])
    await mutatePrivateNoteComments(b.application, 'other-note', () => [comment('other')])
    replicate(a, b)
    expect(read(a)).toEqual(read(b))
    expect(read(a).map((value) => value.id)).toEqual(['user-a:one', 'user-a:two'])
    expect(read(a, 'other-note')).toEqual([comment('other')])
  })

  it('keeps a deletion across stale legacy snapshots, late offline edits, and concurrent new additions during purge', async () => {
    const a = fixture(),
      b = fixture()
    const legacy = { version: 1, ownerUuid: 'user-a', notes: { 'shared-note': [comment('old')] } }
    a.setStored(legacy)
    b.setStored(legacy)
    await mutatePrivateNoteComments(a.application, 'shared-note', () => [])
    await mutatePrivateNoteComments(b.application, 'shared-note', (items) => [
      { ...items[0], text: 'offline edit' },
      comment('new'),
    ])
    replicate(a, b)
    expect(read(a)).toEqual([comment('new')])
    expect(read(b)).toEqual(read(a))
    a.setStored({ ...legacy, notes: { 'shared-note': [{ ...comment('old'), text: 'old client overwrite' }] } })
    expect(read(a)).toEqual([comment('new')])
  })

  it('migrates every legacy note without clearing its saved copy and makes later native edits outrank late imports', async () => {
    const a = fixture(),
      b = fixture()
    const legacy = {
      version: 1,
      ownerUuid: 'user-a',
      notes: { 'shared-note': [comment('old')], other: [comment('other')] },
    }
    a.setStored(legacy)
    b.setStored(legacy)
    await mutatePrivateNoteComments(a.application, 'shared-note', (items) => [{ ...items[0], text: 'native edit' }])
    await mutatePrivateNoteComments(b.application, 'other', (items) => [...items, comment('new')])
    replicate(a, b)
    a.setStored(undefined)
    expect(read(a)[0].text).toBe('native edit')
    expect(read(a, 'other').map((value) => value.id)).toEqual(['user-a:new', 'user-a:other'])
    expect(a.raw.mutator.changeItem).not.toHaveBeenCalled()
  })

  it('orders concurrent resolve and reopen deterministically and permits later causal resolution', async () => {
    const a = fixture(),
      b = fixture()
    await mutatePrivateNoteComments(a.application, 'shared-note', () => [comment('one')])
    replicate(a, b)
    await mutatePrivateNoteComments(a.application, 'shared-note', (items) => [{ ...items[0], resolved: true }])
    await mutatePrivateNoteComments(b.application, 'shared-note', (items) => [{ ...items[0], resolved: false }])
    replicate(a, b)
    expect(read(a)).toEqual(read(b))
    await mutatePrivateNoteComments(b.application, 'shared-note', (items) => [
      { ...items[0], resolved: !items[0].resolved },
    ])
    const expected = read(b)[0].resolved
    replicate(a, b)
    expect(read(a)[0].resolved).toBe(expected)
  })

  it('hides a concurrent reply to a deleted parent', async () => {
    const a = fixture(),
      b = fixture()
    await mutatePrivateNoteComments(a.application, 'shared-note', () => [comment('parent')])
    replicate(a, b)
    await mutatePrivateNoteComments(a.application, 'shared-note', () => [])
    await mutatePrivateNoteComments(b.application, 'shared-note', (items) => [
      ...items,
      { ...comment('reply'), parentId: comment('parent').id },
    ])
    replicate(a, b)
    expect(read(a)).toEqual([])
  })

  it('rejects a queued account change and does not route private content to the replacement account', async () => {
    const f = fixture()
    const work = mutatePrivateNoteComments(f.application, 'shared-note', () => [comment('one')])
    f.switchAccount()
    await expect(work).rejects.toThrow('unavailable')
    expect(f.createItem).not.toHaveBeenCalled()
  })

  it('retains the locally written operation after sync failure and retries without making another record', async () => {
    const f = fixture()
    f.raw.sync.sync.mockRejectedValueOnce(new Error('offline'))
    await expect(mutatePrivateNoteComments(f.application, 'shared-note', () => [comment('one')])).rejects.toThrow(
      'offline',
    )
    expect(read(f)).toEqual([comment('one')])
    await mutatePrivateNoteComments(f.application, 'shared-note', () => [comment('one')])
    expect(f.records).toHaveLength(1)
    expect(f.raw.sync.sync).toHaveBeenCalledTimes(2)
  })

  it('fails closed on unreadable histories, undecrypted deletions, and future legacy data without overwriting it', async () => {
    const f = fixture()
    f.setStored({ version: 2, ownerUuid: 'user-a', notes: {} })
    await expect(mutatePrivateNoteComments(f.application, 'shared-note', () => [comment('one')])).rejects.toThrow(
      'Export',
    )
    f.setStored(undefined)
    f.raw.items.invalidItems.push({ content_type: PRIVATE_COMMENT_CONTENT_TYPE })
    await expect(mutatePrivateNoteComments(f.application, 'shared-note', () => [comment('one')])).rejects.toThrow(
      'decryption',
    )
    f.raw.items.invalidItems.length = 0
    f.records.push({ uuid: 'invalid', content_type: PRIVATE_COMMENT_CONTENT_TYPE, content: { version: 99 } })
    expect(read(f)).toEqual([])
    expect(privateCommentsReadError(f.application)).toContain('could not be read safely')
    await expect(mutatePrivateNoteComments(f.application, 'shared-note', () => [comment('one')])).rejects.toThrow(
      'history',
    )
    expect(f.createItem).not.toHaveBeenCalled()
  })

  it('reserves deletion capacity when the ordinary operation budget is full and retains tombstones', async () => {
    const f = fixture()
    for (let i = 0; i < MAX_PRIVATE_OPERATION_RECORDS; i++)
      f.records.push({
        uuid: `existing-${i}`,
        content_type: PRIVATE_COMMENT_CONTENT_TYPE,
        content: {
          version: 2,
          ownerUuid: 'user-a',
          operationId: `existing-${i}`,
          changes: [{ noteUuid: 'shared-note', id: comment('one').id, clock: i + 1, comment: comment('one') }],
        },
      })
    await expect(
      mutatePrivateNoteComments(f.application, 'shared-note', (items) => [...items, comment('two')]),
    ).rejects.toThrow('storage is full')
    await mutatePrivateNoteComments(f.application, 'shared-note', () => [])
    expect(read(f)).toEqual([])
    expect(f.records.at(-1).content.changes).toEqual([
      expect.objectContaining({ id: comment('one').id, deleted: true }),
    ])
    await expect(mutatePrivateNoteComments(f.application, 'shared-note', () => [comment('one')])).rejects.toThrow(
      'was deleted',
    )
  })

  it('never consumes records shared into a vault or accepts another account or over-limit legacy records', async () => {
    const f = fixture()
    f.setStored({ version: 1, ownerUuid: 'user-b', notes: { 'shared-note': [comment('one')] } })
    expect(read(f)).toEqual([])
    expect(normalizePrivateComments({ version: 2, ownerUuid: 'user-a', notes: {} }, 'user-a')).toBeUndefined()
    expect(
      normalizePrivateComments(
        {
          version: 1,
          ownerUuid: 'user-a',
          notes: { note: [{ ...comment('one'), text: 'x'.repeat(MAX_PRIVATE_COMMENT_BYTES) }] },
        },
        'user-a',
      ),
    ).toBeUndefined()
    f.setStored(undefined)
    f.records.push({
      uuid: 'shared',
      content_type: PRIVATE_COMMENT_CONTENT_TYPE,
      shared_vault_uuid: 'vault',
      content: { version: 99 },
    })
    expect(read(f)).toEqual([])
    await expect(
      mutatePrivateNoteComments(f.application, 'shared-note', () =>
        Array.from({ length: 257 }, (_, i) => comment(`id-${i}`)),
      ),
    ).rejects.toThrow('storage is full')
  })
})
