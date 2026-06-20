import { removeFromArray } from '@standardnotes/utils'
import {
  AlertService,
  ComponentManagerInterface,
  FileItem,
  ItemManagerInterface,
  MutatorClientInterface,
  PreferenceServiceInterface,
  SNNote,
  SessionsClientInterface,
  SyncServiceInterface,
} from '@standardnotes/snjs'
import { NoteViewController } from './NoteViewController'
import { FileViewController } from './FileViewController'
import { TemplateNoteViewControllerOptions } from './TemplateNoteViewControllerOptions'
import { IsNativeMobileWeb } from '@standardnotes/ui-services'

type ItemControllerGroupChangeCallback = (activeController: NoteViewController | FileViewController | undefined) => void

export type CreateItemControllerContext = {
  file?: FileItem
  note?: SNNote
  templateOptions?: TemplateNoteViewControllerOptions
  /**
   * When true, the new controller is opened as an additional "tile" alongside the
   * currently open ones instead of replacing the active controller. Used by the
   * tiled multi-note editor. Defaults to false (legacy single-note behavior).
   */
  openInNewTile?: boolean
}

export class ItemGroupController {
  public itemControllers: (NoteViewController | FileViewController)[] = []
  changeObservers: ItemControllerGroupChangeCallback[] = []
  eventObservers: (() => void)[] = []

  /**
   * Explicit reference to the active controller. When tiling is off there is only
   * ever one controller and this points at it. When multiple tiles are open this
   * tracks which tile keyboard/commands target.
   */
  private activeControllerRef: NoteViewController | FileViewController | undefined = undefined

  constructor(
    private items: ItemManagerInterface,
    private mutator: MutatorClientInterface,
    private sync: SyncServiceInterface,
    private sessions: SessionsClientInterface,
    private preferences: PreferenceServiceInterface,
    private components: ComponentManagerInterface,
    private alerts: AlertService,
    private _isNativeMobileWeb: IsNativeMobileWeb,
  ) {}

  public deinit(): void {
    ;(this.items as unknown) = undefined

    this.eventObservers.forEach((removeObserver) => {
      removeObserver()
    })

    this.changeObservers.length = 0

    for (const controller of this.itemControllers) {
      this.closeItemController(controller, { notify: false })
    }

    this.itemControllers.length = 0
  }

  async createItemController(context: CreateItemControllerContext): Promise<NoteViewController | FileViewController> {
    /**
     * Default (legacy) behavior replaces the active tile by closing it first, so that
     * selecting a note in the list reuses the single open editor. When `openInNewTile`
     * is set we keep the existing controllers open and simply add a new one.
     */
    if (!context.openInNewTile && this.activeItemViewController) {
      this.closeItemController(this.activeItemViewController, { notify: false })
    }

    let controller!: NoteViewController | FileViewController

    if (context.file) {
      controller = new FileViewController(context.file, this.items)
    } else if (context.note) {
      controller = new NoteViewController(
        context.note,
        this.items,
        this.mutator,
        this.sync,
        this.sessions,
        this.preferences,
        this.components,
        this.alerts,
        this._isNativeMobileWeb,
      )
    } else if (context.templateOptions) {
      controller = new NoteViewController(
        undefined,
        this.items,
        this.mutator,
        this.sync,
        this.sessions,
        this.preferences,
        this.components,
        this.alerts,
        this._isNativeMobileWeb,
        context.templateOptions,
      )
    } else {
      throw Error('Invalid input to createItemController')
    }

    this.itemControllers.push(controller)

    this.activeControllerRef = controller

    await controller.initialize()

    this.notifyObservers()

    return controller
  }

  public closeItemController(
    controller: NoteViewController | FileViewController,
    { notify = true }: { notify: boolean } = { notify: true },
  ): void {
    if (controller instanceof NoteViewController) {
      controller.syncOnlyIfLargeNote()
    }
    controller.deinit()

    removeFromArray(this.itemControllers, controller)

    if (this.activeControllerRef === controller) {
      this.activeControllerRef = this.itemControllers[this.itemControllers.length - 1]
    }

    if (notify) {
      this.notifyObservers()
    }
  }

  /**
   * Marks a given open controller (tile) as the active one without opening/closing
   * anything. Used by the tiled editor when the user clicks into a tile so that
   * keyboard/commands target that note.
   */
  setActiveItemController(controller: NoteViewController | FileViewController): void {
    if (this.activeControllerRef === controller) {
      return
    }

    if (!this.itemControllers.includes(controller)) {
      return
    }

    this.activeControllerRef = controller
    this.notifyObservers()
  }

  closeActiveItemController(): void {
    const activeController = this.activeItemViewController

    if (activeController) {
      this.closeItemController(activeController, { notify: true })
    }
  }

  closeAllItemControllers(): void {
    for (const controller of [...this.itemControllers]) {
      this.closeItemController(controller, { notify: false })
    }

    this.activeControllerRef = undefined

    this.notifyObservers()
  }

  get activeItemViewController(): NoteViewController | FileViewController | undefined {
    if (this.activeControllerRef && this.itemControllers.includes(this.activeControllerRef)) {
      return this.activeControllerRef
    }

    return this.itemControllers[0]
  }

  /**
   * Notifies observer when the active controller has changed.
   */
  public addActiveControllerChangeObserver(callback: ItemControllerGroupChangeCallback): () => void {
    this.changeObservers.push(callback)

    if (this.activeItemViewController) {
      callback(this.activeItemViewController)
    }

    const thislessChangeObservers = this.changeObservers
    return () => {
      removeFromArray(thislessChangeObservers, callback)
    }
  }

  private notifyObservers(): void {
    for (const observer of this.changeObservers) {
      observer(this.activeItemViewController)
    }
  }
}
