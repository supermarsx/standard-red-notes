/** @jest-environment jsdom */
import type { WebApplication } from '@/Application/WebApplication'
import { ApplicationEvent, ContentType } from '@standardnotes/snjs'
import { AppPaneId } from '@/Components/Panes/AppPaneMetadata'
import { WorkspaceStartupService } from './WorkspaceStartupService'
import { STARTUP_BEHAVIOR_KEY, STARTUP_VIEW_KEY, WORKSPACE_STATE_KEY } from './workspaceState'

const tick = async () => {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
  }
}

describe('workspace startup arbitration', () => {
  let service: WorkspaceStartupService
  beforeEach(() => {
    jest.useFakeTimers()
    jest.spyOn(document, 'hasFocus').mockReturnValue(true)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  })
  afterEach(() => {
    service?.deinit()
    jest.useRealTimers()
  })
  function setup(mode = 'resume') {
    let owner = 'me'
    let observer!: (event: ApplicationEvent) => Promise<void>
    let changed!: () => void
    const values = new Map<string, unknown>([
      [
        WORKSPACE_STATE_KEY,
        {
          version: 1,
          owner: 'me',
          items: [
            { uuid: 'b', kind: 'note' },
            { uuid: 'a', kind: 'file' },
          ],
          views: [
            { kind: 'pane', paneId: AppPaneId.Calendar },
            { kind: 'empty', id: 'empty:4' },
          ],
          activeItemUuid: 'a',
          activeViewId: AppPaneId.Calendar,
        },
      ],
      [STARTUP_BEHAVIOR_KEY, mode],
      [STARTUP_VIEW_KEY, AppPaneId.Dashboard],
    ])
    const item = (uuid: string) => ({
      uuid,
      content_type: uuid === 'a' ? ContentType.TYPES.File : ContentType.TYPES.Note,
    })
    const group = {
      itemControllers: [{ item: item('fallback') }],
      activeItemViewController: undefined as { item: ReturnType<typeof item> } | undefined,
      isOpeningItemController: false,
      addActiveControllerChangeObserver: (callback: () => void) => {
        changed = callback
        return jest.fn()
      },
      createItemController: jest.fn(async (context) => {
        if (!context.canCommit()) {
          throw new Error('canceled')
        }
        const controller = { item: context.note ?? context.file }
        group.itemControllers.push(controller)
        return controller
      }),
      reorderItemControllers: jest.fn((ids: string[]) => {
        group.itemControllers.sort((a, b) => ids.indexOf(a.item.uuid) - ids.indexOf(b.item.uuid))
      }),
      closeItemControllerAfterSaving: jest.fn(async (controller, canContinue) => {
        if (!canContinue()) {
          throw new Error('canceled')
        }
        group.itemControllers = group.itemControllers.filter((entry) => entry !== controller)
        if (group.activeItemViewController === controller) {
          group.activeItemViewController = group.itemControllers[0]
        }
      }),
      setActiveItemController: jest.fn((controller) => {
        group.activeItemViewController = controller
      }),
    }
    group.activeItemViewController = group.itemControllers[0]
    const panes = {
      viewTabs: [],
      activeViewTabId: undefined,
      viewTabInteractionVersion: 0,
      restoreWorkspaceViewTabs: jest.fn(),
      openPaneTab: jest.fn(),
    }
    const app = {
      sessions: { getUser: () => ({ uuid: owner }) },
      getValue: (key: string) => values.get(key),
      setValue: jest.fn((key, value) => values.set(key, value)),
      itemControllerGroup: group,
      paneController: panes,
      itemListController: { hasExplicitSelectionIntent: false, createNewNote: jest.fn().mockResolvedValue(undefined) },
      items: { findItem: jest.fn(item) },
      sync: { isDatabaseLoaded: () => true },
      addEventObserver: (callback: typeof observer) => {
        observer = callback
        return jest.fn()
      },
    }
    service = new WorkspaceStartupService(app as unknown as WebApplication)
    return {
      app,
      group,
      panes,
      values,
      changed: () => changed(),
      event: (event: ApplicationEvent) => observer(event),
      changeOwner: (value: string) => {
        owner = value
      },
    }
  }
  it('restores all ordered tabs and active view, drains fallback before closing', async () => {
    const state = setup()
    state.changed()
    expect(state.app.setValue).not.toHaveBeenCalled()
    await state.event(ApplicationEvent.LocalDataLoaded)
    await tick()
    expect(state.group.itemControllers.map((entry) => entry.item.uuid)).toEqual(['b', 'a'])
    expect((state.group.activeItemViewController as { item: { uuid: string } } | undefined)?.item.uuid).toBe('a')
    expect(state.group.closeItemControllerAfterSaving).toHaveBeenCalledTimes(1)
    expect(state.panes.restoreWorkspaceViewTabs).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'empty:4' })]),
      AppPaneId.Calendar,
    )
    expect(state.app.setValue).toHaveBeenCalledWith(WORKSPACE_STATE_KEY, expect.objectContaining({ owner: 'me' }))
  })
  it('waits for an existing opening instead of racing its selection', async () => {
    const state = setup()
    state.group.isOpeningItemController = true
    await state.event(ApplicationEvent.LocalDataLoaded)
    await tick()
    expect(state.group.createItemController).not.toHaveBeenCalled()
    state.group.isOpeningItemController = false
    await jest.advanceTimersByTimeAsync(500)
    expect(state.group.itemControllers.map((entry) => entry.item.uuid)).toEqual(['b', 'a'])
  })
  it('restores subsequent tabs when the first opening becomes the first active controller', async () => {
    const state = setup()
    state.group.itemControllers = []
    state.group.activeItemViewController = undefined
    state.group.createItemController.mockImplementation(async (context) => {
      if (!context.canCommit()) {
        throw new Error('canceled')
      }
      const controller = { item: context.note ?? context.file }
      state.group.itemControllers.push(controller)
      state.group.activeItemViewController ??= controller
      return controller
    })
    await state.event(ApplicationEvent.LocalDataLoaded)
    await tick()
    expect(state.group.itemControllers.map((entry) => entry.item.uuid)).toEqual(['b', 'a'])
    expect((state.group.activeItemViewController as { item: { uuid: string } } | undefined)?.item.uuid).toBe('a')
  })
  it('keeps a fallback and the saved workspace when its pending save cannot drain', async () => {
    const state = setup()
    state.group.closeItemControllerAfterSaving.mockRejectedValue(new Error('socket not ready'))
    await state.event(ApplicationEvent.LocalDataLoaded)
    await tick()
    expect(state.group.itemControllers.some((entry) => entry.item.uuid === 'fallback')).toBe(true)
    expect(state.app.setValue).not.toHaveBeenCalled()
    expect(state.panes.restoreWorkspaceViewTabs).not.toHaveBeenCalled()
  })
  it('respects explicit selection while a slow tab is opening', async () => {
    const state = setup()
    let release!: () => void
    state.group.createItemController.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { item: { uuid: 'b', content_type: ContentType.TYPES.Note } }
    })
    await state.event(ApplicationEvent.LocalDataLoaded)
    state.app.itemListController.hasExplicitSelectionIntent = true
    release()
    await tick()
    expect(state.panes.restoreWorkspaceViewTabs).not.toHaveBeenCalled()
    expect(state.group.closeItemControllerAfterSaving).not.toHaveBeenCalled()
  })
  it('fences a pending attempt from a different account generation', async () => {
    const state = setup()
    let release!: () => void
    state.group.createItemController.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { item: { uuid: 'b', content_type: ContentType.TYPES.Note } }
    })
    await state.event(ApplicationEvent.LocalDataLoaded)
    state.changeOwner('other')
    await state.event(ApplicationEvent.SignedIn)
    await state.event(ApplicationEvent.LocalDataIncrementalLoad)
    release()
    await tick()
    expect(state.app.setValue).not.toHaveBeenCalled()
    expect(state.panes.restoreWorkspaceViewTabs).not.toHaveBeenCalled()
  })
  it.each(['new-note', 'view'])('honors startup mode %s', async (mode) => {
    const state = setup(mode)
    await state.event(ApplicationEvent.LocalDataLoaded)
    await tick()
    if (mode === 'new-note') {
      expect(state.app.itemListController.createNewNote).toHaveBeenCalledWith(
        undefined,
        undefined,
        'editor',
        false,
        expect.any(Function),
      )
    } else {
      expect(state.panes.openPaneTab).toHaveBeenCalledWith(AppPaneId.Dashboard, false)
    }
    expect(state.group.createItemController).not.toHaveBeenCalled()
  })
  it('does not finish or overwrite saved work after disposal', async () => {
    const state = setup()
    state.group.isOpeningItemController = true
    await state.event(ApplicationEvent.LocalDataLoaded)
    service.deinit()
    state.group.isOpeningItemController = false
    await jest.advanceTimersByTimeAsync(1000)
    expect(state.app.setValue).not.toHaveBeenCalled()
    expect(state.group.createItemController).not.toHaveBeenCalled()
  })
  it('does not overwrite another tab workspace when an inactive tab changes or closes', async () => {
    const state = setup()
    await state.event(ApplicationEvent.LocalDataLoaded)
    await tick()
    const newer = { version: 1, owner: 'me', items: [{ uuid: 'newer', kind: 'note' }], views: [] }
    state.values.set(WORKSPACE_STATE_KEY, newer)
    state.app.setValue.mockClear()
    jest.spyOn(document, 'hasFocus').mockReturnValue(false)
    state.group.itemControllers = [{ item: { uuid: 'background', content_type: ContentType.TYPES.Note } }]
    state.changed()
    window.dispatchEvent(new Event('pagehide'))
    service.deinit()
    expect(state.app.setValue).not.toHaveBeenCalled()
    expect(state.values.get(WORKSPACE_STATE_KEY)).toEqual(newer)
  })
})
