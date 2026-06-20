import {
  AlertService,
  ComponentManagerInterface,
  ItemManagerInterface,
  MutatorClientInterface,
  PreferenceServiceInterface,
  SessionsClientInterface,
  SyncServiceInterface,
} from '@standardnotes/snjs'
import { IsNativeMobileWeb } from '@standardnotes/ui-services'
import { ItemGroupController } from './ItemGroupController'
import { NoteViewController } from './NoteViewController'

/**
 * Replace the real NoteViewController/FileViewController with lightweight stubs so the
 * group's add/activate/switch/close logic can be exercised in isolation (the real
 * controllers do heavy async initialization against many services).
 */
jest.mock('./NoteViewController', () => {
  class MockNoteViewController {
    runtimeId = `${Math.random()}`
    item = { uuid: this.runtimeId }
    initialize = jest.fn().mockResolvedValue(undefined)
    deinit = jest.fn()
    syncOnlyIfLargeNote = jest.fn()
  }
  return { NoteViewController: MockNoteViewController }
})

jest.mock('./FileViewController', () => {
  class MockFileViewController {}
  return { FileViewController: MockFileViewController }
})

describe('ItemGroupController tabs/tiles', () => {
  let group: ItemGroupController

  beforeEach(() => {
    group = new ItemGroupController(
      {} as ItemManagerInterface,
      {} as MutatorClientInterface,
      {} as SyncServiceInterface,
      {} as SessionsClientInterface,
      {} as PreferenceServiceInterface,
      {} as ComponentManagerInterface,
      {} as AlertService,
      (() => false) as unknown as IsNativeMobileWeb,
    )
  })

  const addTab = () => group.createItemController({ templateOptions: {}, openInNewTile: true })

  it('adding a tab grows the controller set and makes the new one active', async () => {
    const first = await addTab()
    expect(group.itemControllers).toHaveLength(1)
    expect(group.activeItemViewController).toBe(first)

    const second = await addTab()
    expect(group.itemControllers).toHaveLength(2)
    expect(group.activeItemViewController).toBe(second)

    const third = await addTab()
    expect(group.itemControllers).toHaveLength(3)
    expect(group.activeItemViewController).toBe(third)
  })

  it('switching tabs changes the active controller without closing any', async () => {
    const first = await addTab()
    const second = await addTab()

    expect(group.activeItemViewController).toBe(second)

    group.setActiveItemController(first as NoteViewController)

    expect(group.activeItemViewController).toBe(first)
    expect(group.itemControllers).toHaveLength(2)
  })

  it('opening without openInNewTile replaces the active controller (single-note behavior)', async () => {
    await addTab()
    expect(group.itemControllers).toHaveLength(1)

    const replacement = await group.createItemController({ templateOptions: {} })

    expect(group.itemControllers).toHaveLength(1)
    expect(group.activeItemViewController).toBe(replacement)
  })

  it('notifies change observers when a tab is added', async () => {
    const observer = jest.fn()
    group.addActiveControllerChangeObserver(observer)
    observer.mockClear()

    await addTab()

    expect(observer).toHaveBeenCalled()
  })

  it('closing the active tab activates a remaining one', async () => {
    const first = await addTab()
    const second = await addTab()

    group.closeItemController(second as NoteViewController)

    expect(group.itemControllers).toHaveLength(1)
    expect(group.activeItemViewController).toBe(first)
  })
})
