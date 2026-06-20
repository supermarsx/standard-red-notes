/**
 * @jest-environment jsdom
 *
 * Quick-actions: local persistence + "most recent note in a collection" resolution.
 *
 * Persistence uses localStorage (not a synced PrefKey) because adding a PrefKey would
 * require touching @standardnotes/models, which is off-limits for this web-only change.
 * The resolver mirrors how the bar opens the newest note in a tag: it sorts the notes
 * referencing the tag by `userModifiedDate` descending and returns the newest.
 */
import {
  DEFAULT_QUICK_ACTIONS,
  loadQuickActions,
  QuickAction,
  saveQuickActions,
} from './quickActionsStorage'
import { resolveMostRecentNote } from './resolveMostRecentNote'

const STORAGE_KEY = 'standardnotes.quickActions.v1'

const makeAction = (overrides: Partial<QuickAction> = {}): QuickAction => ({
  id: 'qa_1',
  type: 'new-note-in',
  targetUuid: 'tag-uuid',
  ...overrides,
})

describe('quickActionsStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns the defaults when nothing is stored', () => {
    expect(loadQuickActions()).toEqual(DEFAULT_QUICK_ACTIONS)
  })

  it('persists and restores a list of quick actions', () => {
    const actions = [
      makeAction({ id: 'qa_a', type: 'new-note-in', targetUuid: 'tag-a', label: 'Diary' }),
      makeAction({ id: 'qa_b', type: 'recent-in', targetUuid: 'tag-b' }),
      makeAction({ id: 'qa_c', type: 'open-note', targetUuid: 'note-c', icon: 'notes' }),
    ]

    saveQuickActions(actions)

    expect(loadQuickActions()).toEqual(actions)
  })

  it('drops malformed entries and unknown action types on load', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        makeAction({ id: 'good', type: 'go-to', targetUuid: 'tag-x' }),
        { id: 'bad-type', type: 'frobnicate', targetUuid: 'tag-y' },
        { id: 'no-target', type: 'go-to' },
        'not-an-object',
      ]),
    )

    const loaded = loadQuickActions()

    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe('good')
  })

  it('falls back to defaults when stored JSON is corrupt', () => {
    localStorage.setItem(STORAGE_KEY, '{ this is not json')

    expect(loadQuickActions()).toEqual(DEFAULT_QUICK_ACTIONS)
  })

  it('falls back to defaults when stored value is not an array', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ not: 'an array' }))

    expect(loadQuickActions()).toEqual(DEFAULT_QUICK_ACTIONS)
  })
})

describe('resolveMostRecentNote', () => {
  const note = (uuid: string, msAgo: number, trashed = false) => ({
    uuid,
    userModifiedDate: new Date(Date.now() - msAgo),
    trashed,
  })

  it('returns undefined for an empty collection', () => {
    expect(resolveMostRecentNote([])).toBeUndefined()
  })

  it('returns the most recently modified note', () => {
    const notes = [note('old', 10_000), note('newest', 100), note('middle', 5_000)]

    expect(resolveMostRecentNote(notes)?.uuid).toBe('newest')
  })

  it('ignores trashed notes', () => {
    const notes = [note('trashed-newest', 50, true), note('kept', 5_000)]

    expect(resolveMostRecentNote(notes)?.uuid).toBe('kept')
  })

  it('treats a missing modified date as the oldest possible', () => {
    const notes = [{ uuid: 'no-date' }, note('dated', 9_999)]

    expect(resolveMostRecentNote(notes)?.uuid).toBe('dated')
  })
})
