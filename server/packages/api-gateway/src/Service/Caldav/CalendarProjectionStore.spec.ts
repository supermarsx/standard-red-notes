import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

import { CalendarProjectionStore } from './CalendarProjectionStore'
import { DEFAULT_CALENDAR_PROJECTION } from './CalendarProjection'

describe('CalendarProjectionStore', () => {
  let directory: string
  let filePath: string
  let store: CalendarProjectionStore

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'caldav-projection-'))
    filePath = path.join(directory, 'projection.json')
    store = new CalendarProjectionStore(filePath)
  })

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true })
  })

  it('returns the OFF defaults for a user who never saved anything', async () => {
    await expect(store.getForUser('user-1')).resolves.toEqual(DEFAULT_CALENDAR_PROJECTION)
  })

  it('round-trips a full set', async () => {
    const stored = await store.setForUser('user-1', {
      enabled: true,
      allDay: 'never',
      durationMinutes: 30,
      anchor: 'start',
      timeZone: 'Europe/Berlin',
      completed: 'mark',
      alarm: 'lead',
      alarmLeadMinutes: 45,
      recurrence: 'first-only',
      summaryPrefix: 'Due: ',
    })
    expect(stored.enabled).toBe(true)
    await expect(store.getForUser('user-1')).resolves.toEqual(stored)
  })

  it('returns the EFFECTIVE values, so a clamped figure is visible immediately', async () => {
    const stored = await store.setForUser('user-1', { enabled: true, durationMinutes: 100_000 })
    expect(stored.durationMinutes).toBe(1_440)
    await expect(store.getForUser('user-1')).resolves.toMatchObject({ durationMinutes: 1_440 })
  })

  it('keeps users separate', async () => {
    await store.setForUser('user-1', { enabled: true })
    await expect(store.getForUser('user-2')).resolves.toEqual(DEFAULT_CALENDAR_PROJECTION)
  })

  it('writes a plain JSON map a second instance can read', async () => {
    await store.setForUser('user-1', { enabled: true, summaryPrefix: 'x' })
    const raw = JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>
    expect(Object.keys(raw)).toEqual(['user-1'])
    await expect(new CalendarProjectionStore(filePath).getForUser('user-1')).resolves.toMatchObject({
      enabled: true,
      summaryPrefix: 'x',
    })
  })

  it('reverts a user to the OFF defaults on reset, and reports whether anything was removed', async () => {
    await store.setForUser('user-1', { enabled: true })
    await expect(store.resetForUser('user-1')).resolves.toBe(true)
    await expect(store.getForUser('user-1')).resolves.toEqual(DEFAULT_CALENDAR_PROJECTION)
    await expect(store.resetForUser('user-1')).resolves.toBe(false)
  })

  it('refuses an unsafe record key without touching the file', async () => {
    await store.setForUser('user-1', { enabled: true })
    const before = await fs.readFile(filePath, 'utf8')
    const stored = await store.setForUser('__proto__', { enabled: true })
    expect(stored.enabled).toBe(true)
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(before)
    await expect(store.getForUser('__proto__')).resolves.toEqual(DEFAULT_CALENDAR_PROJECTION)
    await expect(store.resetForUser('__proto__')).resolves.toBe(false)
  })

  it('fails CLOSED when the file is not a usable map: no events rather than events nobody asked for', async () => {
    await fs.writeFile(filePath, JSON.stringify(['not', 'a', 'map']), 'utf8')
    await expect(store.getForUser('user-1')).resolves.toEqual(DEFAULT_CALENDAR_PROJECTION)
  })

  it('coerces a record written by a different version instead of discarding every user', async () => {
    // Structural validation only: one user one field ahead and another one field
    // behind must both survive, because rejecting the file would revert EVERY
    // user to defaults at once.
    await fs.writeFile(
      filePath,
      JSON.stringify({
        'user-1': { enabled: true, futureField: 'ignored' },
        'user-2': { enabled: true, allDay: 'always' },
      }),
      'utf8',
    )
    await expect(store.getForUser('user-1')).resolves.toMatchObject({ enabled: true, allDay: 'auto' })
    await expect(store.getForUser('user-2')).resolves.toMatchObject({ enabled: true, allDay: 'always' })
  })
})
