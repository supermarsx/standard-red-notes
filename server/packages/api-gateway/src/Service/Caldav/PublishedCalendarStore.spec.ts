import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

import { PublishedCalendarStore } from './PublishedCalendarStore'

describe('PublishedCalendarStore', () => {
  let dir: string
  let filePath: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'caldav-calendar-'))
    filePath = path.join(dir, 'published.json')
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('sorts output deterministically and preserves creation time across updates', async () => {
    let now = 1_000
    const store = new PublishedCalendarStore(filePath, { clock: () => now })
    await store.publish('user', { uid: 'z', summary: 'Last' })
    const created = await store.publish('user', { uid: 'a', summary: 'First' })
    now = 900
    const updated = await store.publish('user', { uid: 'a', summary: 'Changed' })

    expect((await store.listForUser('user')).map((todo) => todo.uid)).toEqual(['a', 'z'])
    expect(updated.createdAt).toBe(created.createdAt)
    expect(updated.updatedAt).toBeGreaterThan(created.updatedAt as number)
  })

  it('validates date-only values and rejects ambiguous or inconsistent temporal input', async () => {
    const store = new PublishedCalendarStore(filePath)
    await expect(
      store.publish('user', { uid: 'valid', summary: 'Valid', start: '2026-08-01', due: '2026-08-02' }),
    ).resolves.toMatchObject({ due: '2026-08-02' })
    await expect(
      store.publish('user', {
        uid: 'local-time',
        summary: 'Invalid',
        due: '2026-08-02T10:00:00',
      }),
    ).rejects.toThrow(/invalid calendar item/i)
    await expect(
      store.publish('user', { uid: 'backwards', summary: 'Invalid', start: '2026-08-02', due: '2026-08-01' }),
    ).rejects.toThrow(/invalid calendar item/i)
    await expect(
      store.publish('user', {
        uid: 'incomplete',
        summary: 'Invalid',
        completed: false,
        completedAt: '2026-08-02T10:00:00Z',
      }),
    ).rejects.toThrow(/invalid calendar item/i)
    await expect(store.publish('user', { uid: 'bad-date', summary: 'Invalid', due: '2026-02-31' })).rejects.toThrow(
      /invalid calendar item/i,
    )
    await expect(
      store.publish('user', { uid: 'bad-date-time', summary: 'Invalid', due: '2026-02-31T10:00:00Z' }),
    ).rejects.toThrow(/invalid calendar item/i)
    await expect(
      store.publish('user', { uid: 'bad-leap-day', summary: 'Invalid', due: '2025-02-29T10:00:00+01:00' }),
    ).rejects.toThrow(/invalid calendar item/i)
    await expect(
      store.publish('user', { uid: 'leap-day', summary: 'Valid', due: '2024-02-29T10:00:00+01:00' }),
    ).resolves.toMatchObject({ due: '2024-02-29T10:00:00+01:00' })
  })

  it('enforces a non-whitespace summary in the store itself', async () => {
    const store = new PublishedCalendarStore(filePath)
    await expect(store.publish('user', { uid: 'blank', summary: ' \t\r\n ' })).rejects.toThrow(/invalid calendar item/i)
  })

  it('rejects control characters that would make iCalendar or XML invalid', async () => {
    const store = new PublishedCalendarStore(filePath)
    await expect(store.publish('user', { uid: 'safe', summary: 'bad\u0001text' })).rejects.toThrow(
      /invalid calendar item/i,
    )
    await expect(store.publish('user', { uid: 'bad\nuid', summary: 'safe' })).rejects.toThrow(/valid user identifier/i)
  })

  it('enforces a per-user insert cap atomically across store instances', async () => {
    const first = new PublishedCalendarStore(filePath, { maxTodosPerUser: 2 })
    const second = new PublishedCalendarStore(filePath, { maxTodosPerUser: 2 })
    const outcomes = await Promise.allSettled([
      first.publish('user', { uid: 'one', summary: 'One' }),
      second.publish('user', { uid: 'two', summary: 'Two' }),
      first.publish('user', { uid: 'three', summary: 'Three' }),
    ])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(2)
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
    await expect(first.listForUser('user')).resolves.toHaveLength(2)
  })

  it('reports whether an item was actually removed and removes empty user buckets', async () => {
    const store = new PublishedCalendarStore(filePath)
    await store.publish('user', { uid: 'one', summary: 'One' })
    await expect(store.unpublish('user', 'missing')).resolves.toBe(false)
    await expect(store.unpublish('user', 'one')).resolves.toBe(true)
    await expect(store.listForUser('user')).resolves.toEqual([])
  })

  it('reads legacy rows without timestamps and orders them by uid', async () => {
    await fs.writeFile(
      filePath,
      JSON.stringify({
        user: {
          z: { uid: 'z', summary: 'Z' },
          a: { uid: 'a', summary: 'A' },
        },
      }),
      'utf8',
    )
    const store = new PublishedCalendarStore(filePath)
    await expect(store.listForUser('user')).resolves.toEqual([
      { uid: 'a', summary: 'A' },
      { uid: 'z', summary: 'Z' },
    ])
  })

  it('rejects persisted rows that bypass write-time temporal semantics', async () => {
    await fs.writeFile(
      filePath,
      JSON.stringify({
        user: {
          invalid: {
            uid: 'invalid',
            summary: 'Invalid persisted row',
            start: '2026-08-02',
            due: '2026-08-01',
          },
        },
      }),
      'utf8',
    )

    const store = new PublishedCalendarStore(filePath)
    await expect(store.listForUser('user')).rejects.toThrow(/invalid object shape/i)
  })
})
