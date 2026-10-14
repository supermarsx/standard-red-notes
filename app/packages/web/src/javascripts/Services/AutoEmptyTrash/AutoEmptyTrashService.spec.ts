/**
 * @jest-environment jsdom
 */
import { SNNote } from '@standardnotes/snjs'
import {
  AutoEmptyTrashInterval,
  DEFAULT_AUTO_EMPTY_TRASH_INTERVAL_MS,
  AutoEmptyTrashService,
  readAutoEmptyTrashInterval,
  selectTrashedItemsDueForDeletion,
  writeAutoEmptyTrashInterval,
} from './AutoEmptyTrashService'

/**
 * Builds a minimal SNNote-shaped stub with just the fields the selector reads.
 */
function makeNote(uuid: string, trashed: boolean, userModifiedDate: Date | undefined): SNNote {
  return {
    uuid,
    trashed,
    userModifiedDate,
    content: { trashed_at: userModifiedDate?.toISOString() },
  } as unknown as SNNote
}

const NOW = new Date('2026-06-20T12:00:00.000Z').getTime()
const DAY = 24 * 60 * 60 * 1000

beforeEach(() => {
  localStorage.clear()
})

describe('auto-empty trash preference', () => {
  it('is off by default when no explicit scoped choice exists', () => {
    expect(DEFAULT_AUTO_EMPTY_TRASH_INTERVAL_MS).toBe(AutoEmptyTrashInterval.Never)
    expect(readAutoEmptyTrashInterval('account-a')).toBe(AutoEmptyTrashInterval.Never)
  })

  it('does not inherit the legacy unscoped destructive preference', () => {
    localStorage.setItem('sn-auto-empty-trash-interval-ms', String(AutoEmptyTrashInterval.OneDay))

    expect(readAutoEmptyTrashInterval('account-a')).toBe(AutoEmptyTrashInterval.Never)
  })

  it('keeps explicit choices isolated between accounts', () => {
    writeAutoEmptyTrashInterval('account-a', AutoEmptyTrashInterval.OneWeek)

    expect(readAutoEmptyTrashInterval('account-a')).toBe(AutoEmptyTrashInterval.OneWeek)
    expect(readAutoEmptyTrashInterval('account-b')).toBe(AutoEmptyTrashInterval.Never)
  })

  it('fails closed to Never for malformed or unsupported values', () => {
    localStorage.setItem('sn-auto-empty-trash-interval-ms:account-a', 'not-a-number')
    expect(readAutoEmptyTrashInterval('account-a')).toBe(AutoEmptyTrashInterval.Never)

    writeAutoEmptyTrashInterval('account-a', 42)
    expect(readAutoEmptyTrashInterval('account-a')).toBe(AutoEmptyTrashInterval.Never)
  })
})

describe('selectTrashedItemsDueForDeletion', () => {
  it('keeps an old note trashed today, and preserves legacy trash without a known date', () => {
    const recent = makeNote('recent', true, new Date(NOW - 1000 * DAY))
    recent.content.trashed_at = new Date(NOW).toISOString()
    const legacy = makeNote('legacy', true, new Date(NOW - 1000 * DAY))
    delete legacy.content.trashed_at
    expect(selectTrashedItemsDueForDeletion([recent, legacy], AutoEmptyTrashInterval.OneDay, NOW)).toEqual([])
  })
  it('returns trashed items older than the interval', () => {
    const oldTrashed = makeNote('old', true, new Date(NOW - 10 * DAY))
    const result = selectTrashedItemsDueForDeletion([oldTrashed], AutoEmptyTrashInterval.OneWeek, NOW)
    expect(result.map((n) => n.uuid)).toEqual(['old'])
  })

  it('excludes trashed items younger than the interval', () => {
    const recentTrashed = makeNote('recent', true, new Date(NOW - 2 * DAY))
    const result = selectTrashedItemsDueForDeletion([recentTrashed], AutoEmptyTrashInterval.OneWeek, NOW)
    expect(result).toEqual([])
  })

  it('includes an item exactly at the interval boundary (>=)', () => {
    const boundary = makeNote('boundary', true, new Date(NOW - 7 * DAY))
    const result = selectTrashedItemsDueForDeletion([boundary], AutoEmptyTrashInterval.OneWeek, NOW)
    expect(result.map((n) => n.uuid)).toEqual(['boundary'])
  })

  it('never includes non-trashed items, even when very old', () => {
    const oldButLive = makeNote('live', false, new Date(NOW - 1000 * DAY))
    const result = selectTrashedItemsDueForDeletion([oldButLive], AutoEmptyTrashInterval.OneDay, NOW)
    expect(result).toEqual([])
  })

  it('returns nothing when the interval is Never (0)', () => {
    const oldTrashed = makeNote('old', true, new Date(NOW - 1000 * DAY))
    const result = selectTrashedItemsDueForDeletion([oldTrashed], AutoEmptyTrashInterval.Never, NOW)
    expect(result).toEqual([])
  })

  it('returns nothing for negative / NaN intervals', () => {
    const oldTrashed = makeNote('old', true, new Date(NOW - 1000 * DAY))
    expect(selectTrashedItemsDueForDeletion([oldTrashed], -1, NOW)).toEqual([])
    expect(selectTrashedItemsDueForDeletion([oldTrashed], Number.NaN, NOW)).toEqual([])
  })

  it('ignores items with a missing trash date', () => {
    const noDate = makeNote('nodate', true, undefined)
    const result = selectTrashedItemsDueForDeletion([noDate], AutoEmptyTrashInterval.OneDay, NOW)
    expect(result).toEqual([])
  })

  it('filters a mixed list down to exactly the due trashed items', () => {
    const items = [
      makeNote('due-old', true, new Date(NOW - 60 * DAY)),
      makeNote('too-recent', true, new Date(NOW - 5 * DAY)),
      makeNote('not-trashed-old', false, new Date(NOW - 60 * DAY)),
      makeNote('due-boundary', true, new Date(NOW - 30 * DAY)),
    ]
    const result = selectTrashedItemsDueForDeletion(items, AutoEmptyTrashInterval.OneMonth, NOW)
    expect(result.map((n) => n.uuid).sort()).toEqual(['due-boundary', 'due-old'])
  })

  it('treats the OneMonth default as 30 days', () => {
    const at29 = makeNote('at29', true, new Date(NOW - 29 * DAY))
    const at31 = makeNote('at31', true, new Date(NOW - 31 * DAY))
    const result = selectTrashedItemsDueForDeletion([at29, at31], AutoEmptyTrashInterval.OneMonth, NOW)
    expect(result.map((n) => n.uuid)).toEqual(['at31'])
  })
})

describe('cleanup deletion boundaries', () => {
  const fixture = () => {
    const notes = new Map(
      ['first', 'second', 'locked', 'readonly'].map((uuid) => [uuid, makeNote(uuid, true, new Date(NOW - 30 * DAY))]),
    )
    Object.assign(notes.get('locked')!, { locked: true })
    const application = {
      identifier: 'profile',
      sessions: { getUser: () => ({ uuid: 'account-a' }) },
      addEventObserver: jest.fn(() => jest.fn()),
      items: {
        get trashedItems() {
          return [...notes.values()]
        },
        findItem: (uuid: string) => notes.get(uuid),
      },
      vaults: {
        getItemVault: (note: SNNote) => (note.uuid === 'readonly' ? { isSharedVaultListing: () => true } : undefined),
      },
      vaultUsers: { isCurrentUserReadonlyVaultMember: () => true },
      isAuthorizedToRenderItem: () => true,
      mutator: { deleteItem: jest.fn(async (_note: SNNote) => undefined) },
      sync: { sync: jest.fn(async () => undefined) },
    }
    writeAutoEmptyTrashInterval('account-a', AutoEmptyTrashInterval.OneDay)
    return { notes, application, service: new AutoEmptyTrashService(application as never) }
  }
  it('skips locked and read-only notes and rechecks a restored note after the preceding deletion', async () => {
    const { notes, application, service } = fixture()
    application.mutator.deleteItem.mockImplementation(async (note) => {
      if (note.uuid === 'first') Object.assign(notes.get('second')!, { trashed: false })
    })
    expect(await service.runCleanup(NOW)).toBe(1)
    expect(application.mutator.deleteItem.mock.calls.map(([note]) => note.uuid)).toEqual(['first'])
    service.deinit()
  })
  it('stops a pending cleanup when the application is torn down', async () => {
    const { application, service } = fixture()
    application.mutator.deleteItem.mockImplementation(async () => {
      service.deinit()
    })
    expect(await service.runCleanup(NOW)).toBe(1)
    expect(application.mutator.deleteItem).toHaveBeenCalledTimes(1)
    expect(application.sync.sync).not.toHaveBeenCalled()
  })
  it('does not delete a newly retrash-stamped second note from its stale original snapshot', async () => {
    const { notes, application, service } = fixture()
    application.mutator.deleteItem.mockImplementation(async (note) => {
      if (note.uuid === 'first') notes.set('second', makeNote('second', true, new Date(NOW)))
    })
    expect(await service.runCleanup(NOW)).toBe(1)
    service.deinit()
  })
})
