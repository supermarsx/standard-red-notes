import { ApplicationEvent, ContentType, PrefKey, RecentNoteEntry, SNNote } from '@standardnotes/snjs'
import { runInAction } from 'mobx'
import { WebApplication } from '@/Application/WebApplication'
import { ItemGroupController } from '@/Components/NoteView/Controller/ItemGroupController'
import { NoteViewController } from '@/Components/NoteView/Controller/NoteViewController'
import { MAX_RECENT_NOTES, RecentNotesState } from './RecentNotesState'

/**
 * Standard Red Notes: tests for the recently-opened-notes tracker.
 *
 * Drives the real ItemGroupController's nonobservable active-controller events, and
 * asserts: malformed-entry filtering on load, dedup + most-recent-first ordering,
 * the MAX cap, persistence, deleted/trashed resolution, and clear().
 */

type ActiveItem = { uuid: string; content_type: string } | undefined

const makeHarness = (
  opts: {
    stored?: unknown
    items?: Record<string, SNNote>
    enabled?: boolean
    limit?: number
    databaseLoaded?: boolean
  } = {},
) => {
  const group = Object.create(ItemGroupController.prototype) as ItemGroupController
  group.itemControllers = []
  group.changeObservers = []
  const activeBox = {
    set: (item: ActiveItem) => {
      const controller = { item } as unknown as NoteViewController
      group.itemControllers = [controller]
      group.setActiveItemController(controller)
    },
  }
  const prefs: Record<string, unknown> = {
    [PrefKey.RecentNotesHistory]: opts.stored,
    [PrefKey.RecentNotesRecordingEnabled]: opts.enabled,
    [PrefKey.RecentNotesHistoryLimit]: opts.limit,
  }
  const setPreference = jest.fn((key: string, value: unknown) => {
    prefs[key] = value
    return Promise.resolve()
  })
  const items = opts.items ?? {}
  const observers = new Map<ApplicationEvent, () => Promise<void>>()

  const application = {
    getPreference: (key: string, def: unknown) => (prefs[key] !== undefined ? prefs[key] : def),
    setPreference,
    itemControllerGroup: group,
    sync: { isDatabaseLoaded: () => opts.databaseLoaded !== false },
    addEventObserver: (callback: () => Promise<void>, event: ApplicationEvent) => {
      observers.set(event, callback)
      return () => observers.delete(event)
    },
    items: {
      findItem: <T>(uuid: string): T | undefined => items[uuid] as unknown as T,
    },
    get itemListController() {
      return {
        get activeControllerItem() {
          return group.activeItemViewController?.item
        },
      }
    },
  } as unknown as WebApplication

  const openNote = (uuid: string) => runInAction(() => activeBox.set({ uuid, content_type: ContentType.TYPES.Note }))

  return { application, openNote, setPreference, prefs, activeBox, group, observers }
}

const note = (uuid: string, flags: { trashed?: boolean } = {}): SNNote =>
  ({ uuid, trashed: flags.trashed ?? false, title: uuid }) as unknown as SNNote

describe('RecentNotesState load', () => {
  it('starts empty when no preference is stored', () => {
    const { application } = makeHarness()
    const state = new RecentNotesState(application)
    expect(state.entries).toEqual([])
    state.deinit()
  })

  it('filters out malformed stored entries', () => {
    const stored = [
      { uuid: 'good', openedAt: 5 },
      { uuid: 123, openedAt: 1 }, // bad uuid
      { uuid: 'bad', openedAt: 'x' }, // bad openedAt
      null,
      { openedAt: 1 },
    ]
    const { application } = makeHarness({ stored })
    const state = new RecentNotesState(application)
    expect(state.entries).toEqual([{ uuid: 'good', openedAt: 5 }])
    state.deinit()
  })

  it('ignores a non-array stored value', () => {
    const { application } = makeHarness({ stored: { not: 'an array' } })
    const state = new RecentNotesState(application)
    expect(state.entries).toEqual([])
    state.deinit()
  })
})

describe('recording opened notes', () => {
  it('waits for stored preferences before recording a note opened during incremental loading', async () => {
    const h = makeHarness({ databaseLoaded: false })
    const state = new RecentNotesState(h.application)
    h.openNote('current')
    expect(h.setPreference).not.toHaveBeenCalled()
    h.prefs[PrefKey.RecentNotesHistory] = [{ uuid: 'previous', openedAt: 10 }]
    await h.observers.get(ApplicationEvent.LocalDataLoaded)!()
    expect(state.entries.map((entry) => entry.uuid)).toEqual(['current', 'previous'])
    h.prefs[PrefKey.RecentNotesRecordingEnabled] = false
    await h.observers.get(ApplicationEvent.PreferencesChanged)!()
    expect(state.recordingEnabled).toBe(false)
    state.deinit()
    expect(h.observers.size).toBe(0)
  })
  it('uses real nonobservable controller notifications without logging repeated updates', () => {
    const h = makeHarness()
    const state = new RecentNotesState(h.application)
    h.openNote('first')
    h.openNote('second')
    h.openNote('second')
    expect(state.entries.map((entry) => entry.uuid)).toEqual(['second', 'first'])
    expect(h.setPreference).toHaveBeenCalledTimes(2)
    state.deinit()
    expect(h.group.changeObservers).toHaveLength(0)
    h.openNote('third')
    expect(h.setPreference).toHaveBeenCalledTimes(2)
  })

  it('can stop and resume recording without deleting existing history', async () => {
    const h = makeHarness()
    const state = new RecentNotesState(h.application)
    h.openNote('first')
    await state.setRecordingEnabled(false)
    h.openNote('private')
    expect(state.entries.map((entry) => entry.uuid)).toEqual(['first'])
    await state.setRecordingEnabled(true)
    h.openNote('next')
    expect(state.entries.map((entry) => entry.uuid)).toEqual(['next', 'first'])
    expect(h.prefs[PrefKey.RecentNotesRecordingEnabled]).toBe(true)
    state.deinit()
  })

  it('starts disabled when configured and applies a bounded configurable history limit', async () => {
    const h = makeHarness({ enabled: false })
    const state = new RecentNotesState(h.application)
    h.openNote('ignored')
    expect(state.entries).toEqual([])
    await state.setRecordingEnabled(true)
    for (let i = 0; i < 12; i++) h.openNote(`note-${i}`)
    await state.setHistoryLimit(10)
    h.openNote('latest')
    expect(state.entries).toHaveLength(10)
    expect(state.entries[0].uuid).toBe('latest')
    await state.setHistoryLimit(1_000_000)
    expect(state.historyLimit).toBe(10)
    expect(h.prefs[PrefKey.RecentNotesHistoryLimit]).toBe(10)
    state.deinit()
  })
  it('records a note opened via the reaction, most-recent-first', () => {
    const h = makeHarness()
    const state = new RecentNotesState(h.application)
    h.openNote('a')
    h.openNote('b')
    expect(state.entries.map((e) => e.uuid)).toEqual(['b', 'a'])
    expect(h.setPreference).toHaveBeenCalledWith(PrefKey.RecentNotesHistory, state.entries)
    state.deinit()
  })

  it('dedupes a re-opened note to the front without duplicating', () => {
    const h = makeHarness()
    const state = new RecentNotesState(h.application)
    h.openNote('a')
    h.openNote('b')
    h.openNote('a')
    expect(state.entries.map((e) => e.uuid)).toEqual(['a', 'b'])
    state.deinit()
  })

  it('caps the history at MAX_RECENT_NOTES', () => {
    const h = makeHarness()
    const state = new RecentNotesState(h.application)
    for (let i = 0; i < MAX_RECENT_NOTES + 10; i++) {
      h.openNote(`note-${i}`)
    }
    expect(state.entries).toHaveLength(MAX_RECENT_NOTES)
    // The most recent is first; the oldest beyond the cap are dropped.
    expect(state.entries[0].uuid).toBe(`note-${MAX_RECENT_NOTES + 9}`)
    state.deinit()
  })

  it('ignores activation of a non-note item', () => {
    const h = makeHarness()
    const state = new RecentNotesState(h.application)
    runInAction(() => h.activeBox.set({ uuid: 'tag1', content_type: ContentType.TYPES.Tag }))
    expect(state.entries).toEqual([])
    state.deinit()
  })
})

describe('resolvedNotes', () => {
  it('resolves live notes and marks deleted/trashed as unavailable', () => {
    const live = note('live')
    const trashed = note('trashed', { trashed: true })
    const h = makeHarness({
      stored: [
        { uuid: 'live', openedAt: 3 },
        { uuid: 'trashed', openedAt: 2 },
        { uuid: 'gone', openedAt: 1 },
      ],
      items: { live, trashed },
    })
    const state = new RecentNotesState(h.application)
    const resolved = state.resolvedNotes
    expect(resolved.map((r) => r.uuid)).toEqual(['live', 'trashed', 'gone'])
    expect(resolved[0].note).toBe(live)
    expect(resolved[1].note).toBeUndefined() // trashed
    expect(resolved[2].note).toBeUndefined() // deleted/missing
    state.deinit()
  })
})

describe('clear', () => {
  it('empties the entries and persists the empty list', () => {
    const h = makeHarness({ stored: [{ uuid: 'a', openedAt: 1 }] })
    const state = new RecentNotesState(h.application)
    state.clear()
    expect(state.entries).toEqual([])
    expect(h.setPreference).toHaveBeenLastCalledWith(PrefKey.RecentNotesHistory, [])
    state.deinit()
  })
})
