import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

import { PublishedRemindersStore } from './PublishedRemindersStore'

describe('PublishedRemindersStore', () => {
  let dir: string
  let filePath: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-reminders-'))
    filePath = path.join(dir, 'published-reminders.json')
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('returns an empty list for a user with no published reminders (missing file)', async () => {
    const store = new PublishedRemindersStore(filePath)
    expect(await store.listForUser('u1')).toEqual([])
    expect(await store.listAllUnsent()).toEqual([])
  })

  it('publishes, normalizes timestamps, and reads back', async () => {
    const store = new PublishedRemindersStore(filePath)
    const stored = await store.publish('u1', { id: 'r1', message: 'hi', dueAtUtc: '2026-06-25T12:00:00.000Z' })
    expect(stored.sent).toBe(false)
    expect(stored.createdAt).toBeGreaterThan(0)
    expect(stored.updatedAt).toBeGreaterThan(0)

    const list = await store.listForUser('u1')
    expect(list).toHaveLength(1)
    expect(list[0].message).toBe('hi')
  })

  it('lists all unsent across users for the scheduler', async () => {
    const store = new PublishedRemindersStore(filePath)
    await store.publish('u1', { id: 'r1', message: 'a', dueAtUtc: '2026-06-25T12:00:00.000Z' })
    await store.publish('u2', { id: 'r2', message: 'b', dueAtUtc: '2026-06-25T12:00:00.000Z' })
    const all = await store.listAllUnsent()
    expect(all.map((d) => d.userUuid).sort()).toEqual(['u1', 'u2'])
  })

  it('markSent(true) removes a reminder from the unsent scan', async () => {
    const store = new PublishedRemindersStore(filePath)
    await store.publish('u1', { id: 'r1', message: 'a', dueAtUtc: '2026-06-25T12:00:00.000Z' })
    await store.markSent('u1', 'r1', true)
    expect(await store.listAllUnsent()).toEqual([])
    const list = await store.listForUser('u1')
    expect(list[0].sent).toBe(true)
  })

  it('markSent(false, reason) keeps it unsent and records the error', async () => {
    const store = new PublishedRemindersStore(filePath)
    await store.publish('u1', { id: 'r1', message: 'a', dueAtUtc: '2026-06-25T12:00:00.000Z' })
    await store.markSent('u1', 'r1', false, 'smtp down')
    const all = await store.listAllUnsent()
    expect(all).toHaveLength(1)
    expect(all[0].reminder.error).toBe('smtp down')
  })
})
