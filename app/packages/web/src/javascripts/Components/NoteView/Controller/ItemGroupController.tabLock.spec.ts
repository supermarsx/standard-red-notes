import {
  AlertService,
  ComponentManagerInterface,
  ItemManagerInterface,
  LocalPrefKey,
  LocalPrefValue,
  MutatorClientInterface,
  NoteType,
  PreferenceServiceInterface,
  SessionsClientInterface,
  SyncServiceInterface,
} from '@standardnotes/snjs'
import { IsNativeMobileWeb } from '@standardnotes/ui-services'
import { ItemGroupController } from './ItemGroupController'
import { NoteViewController } from './NoteViewController'

/**
 * Standard Red Notes: a LOCKED editor tab must not be taken over by a note the
 * user opens from the list.
 *
 * The rule itself is pure (`takeoverTabIndex` in `@/Tabs/lockedTabs`, covered by
 * its own spec). What is under test here is that the controller group actually
 * CONSULTS it on the real open path, that the locked tab's controller is left
 * alive, and that a lock written here is readable by a freshly constructed group
 * reading the same device-local store — which is what surviving a reload means.
 *
 * The view controllers are stubbed (as in ItemGroupController.spec.ts) because
 * the real ones do heavy async initialization against many services, and none of
 * that is what decides where a note lands.
 */
jest.mock('./NoteViewController', () => {
  class MockNoteViewController {
    runtimeId = `${Math.random()}`
    item: { uuid: string }
    dealloced = false
    initialize = jest.fn().mockResolvedValue(undefined)
    deinit = jest.fn(() => {
      this.dealloced = true
    })
    deinitImmediatelyForSecurity = jest.fn(() => {
      this.dealloced = true
    })
    syncOnlyIfLargeNote = jest.fn()
    flushAndAwaitPendingSave = jest.fn().mockResolvedValue(undefined)
    flushAndAwaitPendingSaveStrict = jest.fn().mockResolvedValue(undefined)

    constructor(item?: { uuid: string }) {
      this.item = item ?? { uuid: this.runtimeId }
    }
  }
  return { NoteViewController: MockNoteViewController }
})

jest.mock('./FileViewController', () => {
  class MockFileViewController {}
  return { FileViewController: MockFileViewController }
})

/** The device-local preference store, shared between groups so a "reload" can read it. */
const makeLocalPreferences = () => {
  const values = new Map<string, unknown>()
  return {
    values,
    preferences: {
      getLocalValue: ((key: LocalPrefKey, defaultValue?: unknown) =>
        values.has(key as unknown as string)
          ? values.get(key as unknown as string)
          : defaultValue) as PreferenceServiceInterface['getLocalValue'],
      setLocalValue: ((key: LocalPrefKey, value: LocalPrefValue[LocalPrefKey]) => {
        values.set(key as unknown as string, value)
      }) as PreferenceServiceInterface['setLocalValue'],
    } as unknown as PreferenceServiceInterface,
  }
}

describe('locked editor tabs in the controller group', () => {
  let group: ItemGroupController
  let store: ReturnType<typeof makeLocalPreferences>

  const makeGroup = (preferences: PreferenceServiceInterface) => {
    const items = {
      findItem: jest.fn((uuid: string) => ({ uuid, noteType: NoteType.Plain })),
      streamItems: jest.fn(() => jest.fn()),
      getItems: jest.fn().mockReturnValue([]),
      conflictsOf: jest.fn().mockReturnValue([]),
    } as unknown as ItemManagerInterface

    return new ItemGroupController(
      items,
      {} as MutatorClientInterface,
      {} as SyncServiceInterface,
      { isSignedIn: jest.fn().mockReturnValue(false), getUser: jest.fn() } as unknown as SessionsClientInterface,
      preferences,
      {} as ComponentManagerInterface,
      {} as AlertService,
      (() => false) as unknown as IsNativeMobileWeb,
    )
  }

  const note = (uuid: string) => ({ uuid, noteType: NoteType.Plain }) as never

  /** Opens a note the way the notes list does: taking the current tab over. */
  const openFromList = (uuid: string) => group.createItemController({ note: note(uuid) })
  const openInNewTab = (uuid: string) => group.createItemController({ note: note(uuid), openInNewTile: true })
  const openUuids = () => group.itemControllers.map((controller) => controller.item?.uuid)

  beforeEach(() => {
    store = makeLocalPreferences()
    group = makeGroup(store.preferences)
  })

  it('takes the active tab over when it is NOT locked (unchanged behavior)', async () => {
    const first = await openFromList('note-a')

    await openFromList('note-b')

    expect(openUuids()).toEqual(['note-b'])
    expect((first as unknown as { dealloced: boolean }).dealloced).toBe(true)
  })

  it('refuses to take a LOCKED tab over, giving the incoming note a tab of its own', async () => {
    const locked = await openFromList('note-a')
    group.setTabLocked('note-a', true)

    await openFromList('note-b')

    expect(openUuids()).toEqual(['note-a', 'note-b'])
    // The locked tab's editor is still live, not just still listed.
    expect((locked as unknown as { dealloced: boolean }).dealloced).toBe(false)
    expect(group.activeItemViewController?.item?.uuid).toBe('note-b')
  })

  it('redirects the takeover to the nearest UNLOCKED tab rather than spawning one per click', async () => {
    const lockedController = await openFromList('note-a')
    await openInNewTab('note-b')
    group.setTabLocked('note-a', true)
    group.setActiveItemController(lockedController)

    await openFromList('note-c')

    // note-b was reused, in its own slot; note-a untouched. No third tab appeared.
    expect(openUuids()).toEqual(['note-a', 'note-c'])
    expect((lockedController as unknown as { dealloced: boolean }).dealloced).toBe(false)
  })

  it('creates a new tab when EVERY open tab is locked, rather than refusing the open', async () => {
    await openFromList('note-a')
    await openInNewTab('note-b')
    group.setTabLocked('note-a', true)
    group.setTabLocked('note-b', true)

    await openFromList('note-c')

    expect(openUuids()).toEqual(['note-a', 'note-b', 'note-c'])
    expect(group.activeItemViewController?.item?.uuid).toBe('note-c')
  })

  it('unlocking restores the takeover', async () => {
    await openFromList('note-a')
    group.setTabLocked('note-a', true)
    group.setTabLocked('note-a', false)

    await openFromList('note-b')

    expect(openUuids()).toEqual(['note-b'])
  })

  it('persists the lock so a reload reads it back', async () => {
    await openFromList('note-a')
    group.setTabLocked('note-a', true)

    // A fresh group over the SAME device-local store is what a reload amounts to.
    const reloaded = makeGroup(store.preferences)
    expect(reloaded.isTabLocked('note-a')).toBe(true)
    expect(reloaded.isTabLocked('note-b')).toBe(false)
    expect(store.values.get('lockedEditorTabs')).toEqual(['note-a'])

    // And the reloaded group honours it on its own open path.
    group = reloaded
    await openFromList('note-a')
    await openFromList('note-b')
    expect(openUuids()).toEqual(['note-a', 'note-b'])
  })

  it('notifies observers when a lock changes, so the tab bar re-renders', async () => {
    await openFromList('note-a')
    const observer = jest.fn()
    group.addActiveControllerChangeObserver(observer)
    observer.mockClear()

    group.setTabLocked('note-a', true)
    expect(observer).toHaveBeenCalledTimes(1)

    // Setting the same value again is not a change and must not churn the UI.
    group.setTabLocked('note-a', true)
    expect(observer).toHaveBeenCalledTimes(1)
  })

  it('treats a tab with no locked uuid as lockable only once it has one', async () => {
    await group.createItemController({ templateOptions: {}, openInNewTile: true })

    expect(group.isTabLocked(undefined)).toBe(false)
    expect([...group.lockedTabUuids]).toEqual([])
  })
})

describe('tab placement in the controller group', () => {
  let group: ItemGroupController

  beforeEach(() => {
    const items = {
      findItem: jest.fn((uuid: string) => ({ uuid, noteType: NoteType.Plain })),
      streamItems: jest.fn(() => jest.fn()),
      getItems: jest.fn().mockReturnValue([]),
      conflictsOf: jest.fn().mockReturnValue([]),
    } as unknown as ItemManagerInterface
    group = new ItemGroupController(
      items,
      {} as MutatorClientInterface,
      {} as SyncServiceInterface,
      { isSignedIn: jest.fn().mockReturnValue(false), getUser: jest.fn() } as unknown as SessionsClientInterface,
      {} as PreferenceServiceInterface,
      {} as ComponentManagerInterface,
      {} as AlertService,
      (() => false) as unknown as IsNativeMobileWeb,
    )
  })

  const note = (uuid: string) => ({ uuid, noteType: NoteType.Plain }) as never
  const openUuids = () => group.itemControllers.map((controller) => controller.item?.uuid)

  it('keeps a taken-over tab in its own slot instead of moving it to the end', async () => {
    await group.createItemController({ note: note('note-a'), openInNewTile: true })
    const middle = await group.createItemController({ note: note('note-b'), openInNewTile: true })
    await group.createItemController({ note: note('note-c'), openInNewTile: true })
    group.setActiveItemController(middle)

    await group.createItemController({ note: note('note-d') })

    expect(openUuids()).toEqual(['note-a', 'note-d', 'note-c'])
  })

  it('places a controller at an explicit index without stealing the active tab', async () => {
    const active = await group.createItemController({ note: note('note-b'), openInNewTile: true })

    await group.createItemController({
      note: note('note-a'),
      openInNewTile: true,
      insertAtIndex: 0,
      keepActiveController: true,
    })

    expect(openUuids()).toEqual(['note-a', 'note-b'])
    expect(group.activeItemViewController).toBe(active)
  })

  it('falls back to appending when the requested index is out of range', async () => {
    await group.createItemController({ note: note('note-a'), openInNewTile: true })

    await group.createItemController({ note: note('note-b'), openInNewTile: true, insertAtIndex: 9 })

    expect(openUuids()).toEqual(['note-a', 'note-b'])
  })
})
