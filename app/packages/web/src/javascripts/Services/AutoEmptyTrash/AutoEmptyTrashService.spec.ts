import { SNNote } from '@standardnotes/snjs'
import {
  AutoEmptyTrashInterval,
  selectTrashedItemsDueForDeletion,
} from './AutoEmptyTrashService'

/**
 * Builds a minimal SNNote-shaped stub with just the fields the selector reads.
 */
function makeNote(uuid: string, trashed: boolean, userModifiedDate: Date | undefined): SNNote {
  return { uuid, trashed, userModifiedDate } as unknown as SNNote
}

const NOW = new Date('2026-06-20T12:00:00.000Z').getTime()
const DAY = 24 * 60 * 60 * 1000

describe('selectTrashedItemsDueForDeletion', () => {
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

  it('ignores items with a missing/invalid userModifiedDate', () => {
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
