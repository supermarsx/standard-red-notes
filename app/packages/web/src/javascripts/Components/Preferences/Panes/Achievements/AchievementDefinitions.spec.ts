import { AccountStatistics } from '@/Components/Dashboard/Statistics'
import { accountAgeDays, ACHIEVEMENTS, countEarned } from './AchievementDefinitions'

const MS_PER_DAY = 1000 * 60 * 60 * 24

const baseStats = (overrides: Partial<AccountStatistics> = {}): AccountStatistics => ({
  noteCount: 0,
  trashedCount: 0,
  archivedCount: 0,
  pinnedCount: 0,
  tagCount: 0,
  fileCount: 0,
  editedNoteCount: 0,
  totalWords: 0,
  lastChange: undefined,
  firstItemCreated: undefined,
  lastLogin: undefined,
  recentNotes: [],
  ...overrides,
})

const find = (id: string) => {
  const achievement = ACHIEVEMENTS.find((a) => a.id === id)
  if (!achievement) {
    throw new Error(`Unknown achievement: ${id}`)
  }
  return achievement
}

describe('achievements definitions', () => {
  it('awards no achievements for a brand-new empty account', () => {
    expect(countEarned(baseStats())).toBe(0)
  })

  it('earns the first-note badge at exactly one note and reports progress', () => {
    const firstNote = find('notes-1')
    expect(firstNote.isEarned(baseStats({ noteCount: 0 }))).toBe(false)
    expect(firstNote.isEarned(baseStats({ noteCount: 1 }))).toBe(true)
    expect(firstNote.progress(baseStats({ noteCount: 0 }))).toEqual({ current: 0, target: 1 })
  })

  it('earns note milestones at thresholds', () => {
    expect(find('notes-100').isEarned(baseStats({ noteCount: 99 }))).toBe(false)
    expect(find('notes-100').isEarned(baseStats({ noteCount: 100 }))).toBe(true)
    expect(find('notes-1000').progress(baseStats({ noteCount: 250 }))).toEqual({ current: 250, target: 1000 })
  })

  it('earns tag, file, pinned and archived badges from real counts', () => {
    expect(find('tags-1').isEarned(baseStats({ tagCount: 1 }))).toBe(true)
    expect(find('tags-10').isEarned(baseStats({ tagCount: 9 }))).toBe(false)
    expect(find('files-1').isEarned(baseStats({ fileCount: 1 }))).toBe(true)
    expect(find('pinned-1').isEarned(baseStats({ pinnedCount: 1 }))).toBe(true)
    expect(find('archived-1').isEarned(baseStats({ archivedCount: 1 }))).toBe(true)
  })

  it('earns word-count badges from totalWords', () => {
    expect(find('words-1k').isEarned(baseStats({ totalWords: 999 }))).toBe(false)
    expect(find('words-1k').isEarned(baseStats({ totalWords: 1000 }))).toBe(true)
    expect(find('words-100k').isEarned(baseStats({ totalWords: 100000 }))).toBe(true)
  })

  it('earns editing badges from editedNoteCount', () => {
    expect(find('edited-10').isEarned(baseStats({ editedNoteCount: 10 }))).toBe(true)
    expect(find('edited-100').isEarned(baseStats({ editedNoteCount: 50 }))).toBe(false)
  })

  it('derives account-age badges from firstItemCreated', () => {
    const tenDaysAgo = Date.now() - 10 * MS_PER_DAY
    const fortyDaysAgo = Date.now() - 40 * MS_PER_DAY

    expect(accountAgeDays(baseStats())).toBe(0)
    expect(accountAgeDays(baseStats({ firstItemCreated: tenDaysAgo }))).toBe(10)

    expect(find('age-week').isEarned(baseStats({ firstItemCreated: tenDaysAgo }))).toBe(true)
    expect(find('age-month').isEarned(baseStats({ firstItemCreated: tenDaysAgo }))).toBe(false)
    expect(find('age-month').isEarned(baseStats({ firstItemCreated: fortyDaysAgo }))).toBe(true)
    expect(find('age-year').isEarned(baseStats({ firstItemCreated: fortyDaysAgo }))).toBe(false)
  })

  it('counts the right number of earned achievements for a mixed snapshot', () => {
    const stats = baseStats({
      noteCount: 100,
      tagCount: 1,
      fileCount: 1,
      totalWords: 1000,
      pinnedCount: 1,
      editedNoteCount: 10,
      firstItemCreated: Date.now() - 10 * MS_PER_DAY,
    })
    // notes-1, notes-10, notes-100, tags-1, files-1, words-1k, pinned-1, edited-10, age-week
    expect(countEarned(stats)).toBe(9)
  })
})
