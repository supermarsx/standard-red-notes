import { WebApplication } from '@/Application/WebApplication'
import { ContentType, SNNote } from '@standardnotes/snjs'
import { DEFAULT_DIARY_SETTINGS, diaryTitleForDate } from './diary'
import {
  DiaryLastPromptedKey,
  DiarySettingsKey,
  DiaryTagTitle,
  diaryEntryExistsForDate,
  findDiaryNoteForDate,
  getDiarySettings,
  getLastPromptedDateKey,
  openOrCreateDiaryEntry,
  setDiarySettings,
  setLastPromptedDateKey,
} from './diaryService'

/**
 * Standard Red Notes: tests for the application-bound Diary side effects.
 *
 * The pure core (diary.ts) is covered by diary.spec.ts; here we exercise the
 * storage K/V, the localStorage dedupe marker, note lookup by dated title, and the
 * open-or-create flow (reuse vs. create + tag + sync + open).
 */

const makeNote = (overrides: Partial<SNNote>): SNNote =>
  ({
    uuid: 'n1',
    title: 'Note',
    trashed: false,
    ...overrides,
  }) as unknown as SNNote

type AppMock = {
  store: Record<string, unknown>
  application: WebApplication
  getItems: jest.Mock
  openNote: jest.Mock
  insertItem: jest.Mock
  findOrCreateTag: jest.Mock
  addTagToNote: jest.Mock
  sync: jest.Mock
}

const makeApplication = (notes: SNNote[] = []): AppMock => {
  const store: Record<string, unknown> = {}
  const getItems = jest.fn((contentType: string) => (contentType === ContentType.TYPES.Note ? notes : []))
  const openNote = jest.fn().mockResolvedValue(undefined)
  const insertItem = jest.fn((template: SNNote) => Promise.resolve(makeNote({ uuid: 'new', title: template.title })))
  const findOrCreateTag = jest.fn().mockResolvedValue({ uuid: 'tag1' })
  const addTagToNote = jest.fn().mockResolvedValue(undefined)
  const sync = jest.fn().mockResolvedValue(undefined)

  const application = {
    getValue: <T>(key: string): T => store[key] as T,
    setValue: (key: string, value: unknown) => {
      store[key] = value
    },
    items: {
      getItems,
      createTemplateItem: (_type: string, content: { title: string }) => makeNote({ title: content.title }),
    },
    mutator: { insertItem, findOrCreateTag, addTagToNote },
    sync: { sync },
    itemListController: { openNote },
  } as unknown as WebApplication

  return { store, application, getItems, openNote, insertItem, findOrCreateTag, addTagToNote, sync }
}

beforeEach(() => {
  window.localStorage.clear()
})

describe('getDiarySettings / setDiarySettings', () => {
  it('returns normalized defaults when nothing is stored', () => {
    const { application } = makeApplication()
    expect(getDiarySettings(application)).toEqual(DEFAULT_DIARY_SETTINGS)
  })

  it('round-trips and normalizes persisted settings', () => {
    const { application, store } = makeApplication()
    setDiarySettings(application, { enabled: true, hour: 7, minute: 30 })
    expect(store[DiarySettingsKey]).toEqual({ enabled: true, hour: 7, minute: 30 })
    expect(getDiarySettings(application)).toEqual({ enabled: true, hour: 7, minute: 30 })
  })

  it('normalizes garbage on read (clamps out-of-range time)', () => {
    const { application, store } = makeApplication()
    store[DiarySettingsKey] = { enabled: 'yes', hour: 99, minute: -5 }
    expect(getDiarySettings(application)).toEqual({ enabled: false, hour: 23, minute: 0 })
  })
})

describe('last-prompted date marker', () => {
  it('returns null when never set', () => {
    expect(getLastPromptedDateKey()).toBeNull()
  })

  it('persists and reads back the marker', () => {
    setLastPromptedDateKey('2026-06-20')
    expect(getLastPromptedDateKey()).toBe('2026-06-20')
    expect(window.localStorage.getItem(DiaryLastPromptedKey)).toBe('2026-06-20')
  })

  it('returns null when localStorage.getItem throws', () => {
    const spy = jest.spyOn(window.localStorage.__proto__, 'getItem').mockImplementation(() => {
      throw new Error('unavailable')
    })
    expect(getLastPromptedDateKey()).toBeNull()
    spy.mockRestore()
  })

  it('swallows errors when localStorage.setItem throws', () => {
    const spy = jest.spyOn(window.localStorage.__proto__, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(() => setLastPromptedDateKey('2026-06-20')).not.toThrow()
    spy.mockRestore()
  })
})

describe('findDiaryNoteForDate / diaryEntryExistsForDate', () => {
  const date = new Date(2026, 5, 20)
  const title = diaryTitleForDate(date)

  it('finds the non-trashed note whose title matches the dated title', () => {
    const match = makeNote({ uuid: 'match', title })
    const { application } = makeApplication([makeNote({ title: 'Other' }), match])
    expect(findDiaryNoteForDate(application, date)).toBe(match)
    expect(diaryEntryExistsForDate(application, date)).toBe(true)
  })

  it('ignores trashed entries with the matching title', () => {
    const { application } = makeApplication([makeNote({ uuid: 'trash', title, trashed: true })])
    expect(findDiaryNoteForDate(application, date)).toBeUndefined()
    expect(diaryEntryExistsForDate(application, date)).toBe(false)
  })

  it('returns undefined when no entry exists', () => {
    const { application } = makeApplication([])
    expect(findDiaryNoteForDate(application, date)).toBeUndefined()
  })
})

describe('openOrCreateDiaryEntry', () => {
  const date = new Date(2026, 5, 20)
  const title = diaryTitleForDate(date)

  it('reuses and opens an existing dated note without creating one', async () => {
    const existing = makeNote({ uuid: 'existing', title })
    const app = makeApplication([existing])
    const result = await openOrCreateDiaryEntry(app.application, date)
    expect(result).toBe(existing)
    expect(app.openNote).toHaveBeenCalledWith('existing')
    expect(app.insertItem).not.toHaveBeenCalled()
  })

  it('creates a dated note, files it under the Diary tag, syncs, and opens it', async () => {
    const app = makeApplication([])
    const result = await openOrCreateDiaryEntry(app.application, date)
    expect(app.insertItem).toHaveBeenCalledTimes(1)
    expect(app.findOrCreateTag).toHaveBeenCalledWith(DiaryTagTitle)
    expect(app.addTagToNote).toHaveBeenCalledTimes(1)
    expect(app.sync).toHaveBeenCalledTimes(1)
    expect(app.openNote).toHaveBeenCalledWith('new')
    expect(result?.title).toBe(title)
  })

  it('still creates/opens the note when tagging fails (best-effort filing)', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const app = makeApplication([])
    app.findOrCreateTag.mockRejectedValue(new Error('tag failed'))
    const result = await openOrCreateDiaryEntry(app.application, date)
    expect(result?.uuid).toBe('new')
    expect(app.sync).toHaveBeenCalledTimes(1)
    expect(app.openNote).toHaveBeenCalledWith('new')
  })
})
