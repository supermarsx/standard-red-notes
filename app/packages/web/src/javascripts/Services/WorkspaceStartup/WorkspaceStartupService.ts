import type { WebApplication } from '@/Application/WebApplication'
import { ChecklistEditorOpeningCanceledError } from '@/Components/NoteView/Controller/ItemGroupController'
import { ApplicationEvent, ContentType, FileItem, SNNote } from '@standardnotes/snjs'
import { reaction } from 'mobx'
import {
  readWorkspaceState,
  serializeWorkspaceState,
  startupBehavior,
  startupView,
  STARTUP_BEHAVIOR_KEY,
  STARTUP_VIEW_KEY,
  WORKSPACE_STATE_KEY,
  WorkspaceState,
} from './workspaceState'

/** Restore all real tabs after data readiness, without recording startup fallbacks. */
export class WorkspaceStartupService {
  private readonly disposers: (() => void)[] = []
  private disposed = false
  private captured = false
  private applied = false
  private pending = false
  private retry = false
  private attempts = 0
  private timer?: ReturnType<typeof setTimeout>
  private owner?: string
  private initial?: WorkspaceState
  private mode: ReturnType<typeof startupBehavior> = 'resume'
  private view: ReturnType<typeof startupView> = startupView(undefined)
  private lastSaved?: string
  private interacted = false
  private generation = 0

  constructor(private readonly application: WebApplication) {
    this.disposers.push(
      application.itemControllerGroup.addActiveControllerChangeObserver(() => this.persist()),
      reaction(
        () => JSON.stringify([application.paneController.viewTabs, application.paneController.activeViewTabId]),
        () => this.persist(),
      ),
      application.addEventObserver(async (event) => {
        if (event === ApplicationEvent.SignedIn || event === ApplicationEvent.SignedOut) {
          this.generation += 1
          clearTimeout(this.timer)
          this.captured = false
          this.applied = false
          this.owner = undefined
          this.initial = undefined
          this.interacted = false
          this.lastSaved = undefined
          this.attempts = 0
        }
        if (event === ApplicationEvent.LocalDataIncrementalLoad) {
          this.capture()
        }
        if (
          event === ApplicationEvent.LocalDataLoaded ||
          event === ApplicationEvent.CompletedFullSync ||
          event === ApplicationEvent.Launched
        ) {
          this.capture()
          this.schedule()
        }
      }),
    )
    const onPageHide = () => this.persist()
    const onInput = (event: Event) => {
      if (event.isTrusted && !this.applied) {
        this.interacted = true
      }
    }
    window.addEventListener('pagehide', onPageHide)
    document.addEventListener('pointerdown', onInput, true)
    document.addEventListener('keydown', onInput, true)
    this.disposers.push(() => window.removeEventListener('pagehide', onPageHide))
    this.disposers.push(() => document.removeEventListener('pointerdown', onInput, true))
    this.disposers.push(() => document.removeEventListener('keydown', onInput, true))
  }

  private currentOwner(): string {
    return this.application.sessions.getUser()?.uuid ?? 'offline'
  }

  private capture(): void {
    if (this.captured || this.disposed) {
      return
    }
    this.owner = this.currentOwner()
    this.initial = readWorkspaceState(this.application.getValue(WORKSPACE_STATE_KEY), this.owner)
    this.mode = startupBehavior(this.application.getValue(STARTUP_BEHAVIOR_KEY))
    this.view = startupView(this.application.getValue(STARTUP_VIEW_KEY))
    this.captured = true
  }

  private schedule(): void {
    if (this.disposed || this.applied || !this.captured || !this.application.sync.isDatabaseLoaded()) {
      return
    }
    if (this.pending) {
      this.retry = true
      return
    }
    if (this.application.itemControllerGroup.isOpeningItemController) {
      clearTimeout(this.timer)
      this.timer = setTimeout(() => this.schedule(), 500)
      return
    }
    this.pending = true
    void this.restore()
      .catch((error: unknown) => {
        if (!(error instanceof ChecklistEditorOpeningCanceledError)) {
          // Keep the saved workspace intact; a later readiness event can retry.
          this.retry = false
        }
      })
      .finally(() => {
        this.pending = false
        if (this.disposed || this.applied) {
          return
        }
        if (this.retry || this.attempts < 3) {
          this.retry = false
          this.timer = setTimeout(() => this.schedule(), 500)
        }
      })
  }

  private async restore(): Promise<void> {
    this.attempts += 1
    const app = this.application
    const group = app.itemControllerGroup
    const panes = app.paneController
    const generation = this.generation
    const owner = this.owner
    const initial = this.initial
    const mode = this.mode
    const view = this.view
    let expectedActive = group.activeItemViewController?.item?.uuid
    const viewIntent = panes.viewTabInteractionVersion
    const canCommit = () =>
      !this.disposed &&
      this.generation === generation &&
      !this.interacted &&
      this.currentOwner() === owner &&
      !app.itemListController.hasExplicitSelectionIntent &&
      panes.viewTabInteractionVersion === viewIntent &&
      group.activeItemViewController?.item?.uuid === expectedActive

    if (!canCommit()) {
      if (this.generation === generation && this.currentOwner() === owner) {
        this.applied = true
        this.persist()
      }
      return
    }
    if (mode === 'new-note') {
      await app.itemListController.createNewNote(undefined, undefined, 'editor', false, canCommit)
    } else if (mode === 'view') {
      panes.openPaneTab(view, false)
    } else if (initial) {
      for (const saved of initial.items) {
        if (!canCommit()) {
          throw new ChecklistEditorOpeningCanceledError('A newer workspace selection superseded startup.')
        }
        if (group.itemControllers.some((controller) => controller.item?.uuid === saved.uuid)) {
          continue
        }
        const item = app.items.findItem<SNNote | FileItem>(saved.uuid)
        if (!item || (item.content_type !== ContentType.TYPES.Note && item.content_type !== ContentType.TYPES.File)) {
          continue
        }
        const opened = await group.createItemController({
          ...(item.content_type === ContentType.TYPES.Note ? { note: item as SNNote } : { file: item as FileItem }),
          openInNewTile: true,
          keepActiveController: true,
          canCommit,
        })
        if (expectedActive === undefined && group.activeItemViewController === opened) {
          expectedActive = opened.item.uuid
        }
      }
      if (!canCommit()) {
        throw new ChecklistEditorOpeningCanceledError('A newer workspace selection superseded startup.')
      }
      const wanted = new Set(initial.items.map((item) => item.uuid))
      const restored = group.itemControllers.filter((controller) => wanted.has(controller.item?.uuid))
      // Preserve order, and remove only automatic fallback tabs once replacements exist.
      if (restored.length) {
        group.reorderItemControllers(initial.items.map((item) => item.uuid))
        for (const controller of [...group.itemControllers]) {
          if (!wanted.has(controller.item?.uuid)) {
            await group.closeItemControllerAfterSaving(controller, canCommit)
            expectedActive = group.activeItemViewController?.item?.uuid
          }
        }
        if (!canCommit()) {
          throw new ChecklistEditorOpeningCanceledError('A newer workspace selection superseded startup.')
        }
        const selected = restored.find((controller) => controller.item?.uuid === initial.activeItemUuid) ?? restored[0]
        group.setActiveItemController(selected)
      }
      const views = initial.views.filter((tab) => tab.kind !== 'conflict' || !!app.items.findItem(tab.noteUuid))
      panes.restoreWorkspaceViewTabs(views, initial.activeViewId)
    }
    if (!this.disposed && this.generation === generation && this.currentOwner() === owner) {
      this.applied = true
      this.persist()
    }
  }

  private persist(): void {
    const app = this.application
    if (
      this.disposed ||
      !this.applied ||
      !app.sync.isDatabaseLoaded() ||
      this.currentOwner() !== this.owner ||
      document.visibilityState !== 'visible' ||
      !document.hasFocus()
    ) {
      return
    }
    const state: WorkspaceState = {
      version: 1,
      owner: this.owner ?? this.currentOwner(),
      items: app.itemControllerGroup.itemControllers.flatMap((controller) => {
        const item = controller.item
        if (!item) {
          return []
        }
        return [
          {
            uuid: item.uuid,
            kind: item.content_type === ContentType.TYPES.File ? ('file' as const) : ('note' as const),
          },
        ]
      }),
      views: app.paneController.viewTabs,
      activeItemUuid: app.itemControllerGroup.activeItemViewController?.item?.uuid,
      activeViewId: app.paneController.activeViewTabId,
    }
    const value = serializeWorkspaceState(state)
    const serialized = JSON.stringify(value)
    if (serialized !== this.lastSaved) {
      this.lastSaved = serialized
      app.setValue(WORKSPACE_STATE_KEY, value)
    }
  }

  deinit(): void {
    this.persist()
    this.disposed = true
    clearTimeout(this.timer)
    this.disposers.splice(0).forEach((dispose) => dispose())
  }
}
