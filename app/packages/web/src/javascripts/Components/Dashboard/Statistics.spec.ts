import { ContentType, SessionListEntry } from '@standardnotes/snjs'
import { computeAccountStatistics, deriveLastLoginFromSessions } from './Statistics'
import { WebApplication } from '@/Application/WebApplication'

type FakeNote = {
  uuid: string
  title: string
  text: string
  noteType?: undefined
  preview_plain: string
  trashed: boolean
  archived: boolean
  pinned: boolean
  userModifiedDate: Date
  created_at: Date
}

const makeNote = (overrides: Partial<FakeNote> & { uuid: string }): FakeNote => ({
  title: 'Note',
  text: '',
  noteType: undefined,
  preview_plain: '',
  trashed: false,
  archived: false,
  pinned: false,
  userModifiedDate: new Date(1000),
  created_at: new Date(1000),
  ...overrides,
})

const makeApplication = (notes: FakeNote[], tags: unknown[] = [], files: unknown[] = []): WebApplication => {
  return {
    items: {
      getItems: (contentType: string) => {
        if (contentType === ContentType.TYPES.Note) {
          return notes
        }
        if (contentType === ContentType.TYPES.Tag) {
          return tags
        }
        if (contentType === ContentType.TYPES.File) {
          return files
        }
        return []
      },
    },
  } as unknown as WebApplication
}

describe('computeAccountStatistics', () => {
  it('partitions notes into active / archived / trashed / pinned counts', () => {
    const app = makeApplication([
      makeNote({ uuid: 'a' }),
      makeNote({ uuid: 'b', archived: true }),
      makeNote({ uuid: 'c', trashed: true }),
      makeNote({ uuid: 'd', pinned: true }),
    ])

    const stats = computeAccountStatistics(app)

    // 'a' and 'd' are active; 'b' archived (not counted as active); 'c' trashed.
    expect(stats.noteCount).toBe(2)
    expect(stats.archivedCount).toBe(1)
    expect(stats.trashedCount).toBe(1)
    expect(stats.pinnedCount).toBe(1)
  })

  it('counts tags and files from the item manager', () => {
    const app = makeApplication([makeNote({ uuid: 'a' })], [{}, {}], [{ userModifiedDate: new Date(5) }])
    const stats = computeAccountStatistics(app)
    expect(stats.tagCount).toBe(2)
    expect(stats.fileCount).toBe(1)
  })

  it('derives lastChange as the most recent userModifiedDate and firstItemCreated as the oldest creation', () => {
    const app = makeApplication([
      makeNote({ uuid: 'a', created_at: new Date(1000), userModifiedDate: new Date(2000) }),
      makeNote({ uuid: 'b', created_at: new Date(500), userModifiedDate: new Date(9000) }),
    ])

    const stats = computeAccountStatistics(app)

    expect(stats.lastChange).toBe(9000)
    expect(stats.firstItemCreated).toBe(500)
  })

  it('counts a note as edited only when modified well after creation', () => {
    const app = makeApplication([
      // Never edited (modified == created).
      makeNote({ uuid: 'a', created_at: new Date(1000), userModifiedDate: new Date(1000) }),
      // Edited (modified > created + 2s).
      makeNote({ uuid: 'b', created_at: new Date(1000), userModifiedDate: new Date(10000) }),
    ])

    const stats = computeAccountStatistics(app)
    expect(stats.editedNoteCount).toBe(1)
  })

  it('returns recent notes sorted by modified date, newest first, capped by limit', () => {
    const app = makeApplication([
      makeNote({ uuid: 'old', title: 'Old', userModifiedDate: new Date(1000) }),
      makeNote({ uuid: 'new', title: 'New', userModifiedDate: new Date(3000) }),
      makeNote({ uuid: 'mid', title: 'Mid', userModifiedDate: new Date(2000) }),
      makeNote({ uuid: 'trashed', title: 'Trashed', trashed: true, userModifiedDate: new Date(9999) }),
    ])

    const stats = computeAccountStatistics(app, { recentNotesLimit: 2 })

    expect(stats.recentNotes.map((note) => note.uuid)).toEqual(['new', 'mid'])
    expect(stats.recentNotes[0].title).toBe('New')
  })

  it('counts total words across non-trashed notes', () => {
    const app = makeApplication([
      makeNote({ uuid: 'a', text: 'one two three' }),
      makeNote({ uuid: 'b', text: 'four five' }),
      makeNote({ uuid: 'c', text: 'should not count', trashed: true }),
    ])

    const stats = computeAccountStatistics(app)
    expect(stats.totalWords).toBe(5)
  })

  it('passes through the supplied lastLogin', () => {
    const app = makeApplication([makeNote({ uuid: 'a' })])
    const stats = computeAccountStatistics(app, { lastLogin: 42 })
    expect(stats.lastLogin).toBe(42)
  })
})

describe('deriveLastLoginFromSessions', () => {
  const session = (overrides: Partial<SessionListEntry>): SessionListEntry => ({
    uuid: 'u',
    current: false,
    api_version: '1',
    created_at: new Date(1000).toISOString(),
    updated_at: new Date(1000).toISOString(),
    device_info: 'test',
    ...overrides,
  })

  it('returns undefined for no sessions', () => {
    expect(deriveLastLoginFromSessions([])).toBeUndefined()
  })

  it('picks the most recent non-current session creation', () => {
    const result = deriveLastLoginFromSessions([
      session({ current: true, created_at: new Date(9999).toISOString() }),
      session({ created_at: new Date(1000).toISOString() }),
      session({ created_at: new Date(5000).toISOString() }),
    ])
    expect(result).toBe(5000)
  })

  it('falls back to the current session when it is the only one', () => {
    const result = deriveLastLoginFromSessions([
      session({ current: true, created_at: new Date(7000).toISOString() }),
    ])
    expect(result).toBe(7000)
  })
})
