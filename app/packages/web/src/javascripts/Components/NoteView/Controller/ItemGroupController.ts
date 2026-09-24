import { removeFromArray } from '@standardnotes/utils'
import { ContentType } from '@standardnotes/domain-core'
import {
  AlertService,
  ComponentManagerInterface,
  FileItem,
  ItemManagerInterface,
  MutatorClientInterface,
  PreferenceServiceInterface,
  SNNote,
  NoteType,
  SessionsClientInterface,
  SyncServiceInterface,
} from '@standardnotes/snjs'
import { NoteViewController } from './NoteViewController'
import { FileViewController } from './FileViewController'
import { TemplateNoteViewControllerOptions } from './TemplateNoteViewControllerOptions'
import { IsNativeMobileWeb } from '@standardnotes/ui-services'
import {
  captureChecklistSessionPrincipal,
  ChecklistSessionPrincipal,
  checklistSessionPrincipalMatches,
} from '../../SuperEditor/Checklist/checklistSessionPrincipal'

type ItemControllerGroupChangeCallback = (activeController: NoteViewController | FileViewController | undefined) => void

type ChecklistPrincipal = ChecklistSessionPrincipal & { keySystemIdentifier?: string }
type VisibleChecklistReservation = {
  token: object
  noteUuid: string
  principal: ChecklistPrincipal
  generation: number
  canceled: boolean
  controller?: NoteViewController
  ready: boolean
}
type DetachedChecklistPreparation = {
  token: object
  noteUuid: string
  principal: ChecklistPrincipal
  generation: number
  canceled: boolean
  promise: Promise<NoteViewController | undefined>
  resolve: (controller: NoteViewController | undefined) => void
}

export class ChecklistEditorOwnershipError extends Error {}
export class ChecklistEditorOpeningCanceledError extends ChecklistEditorOwnershipError {}

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
  private readonly detachedNoteControllers = new Set<NoteViewController>()
  private readonly detachedControllerClosedCallbacks = new Map<NoteViewController, () => void>()
  private readonly visibleChecklistReservations = new Map<string, Set<VisibleChecklistReservation>>()
  private readonly detachedChecklistPreparations = new Map<string, DetachedChecklistPreparation>()
  private checklistSecurityGeneration = 0
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
  ) {
    /**
     * Standard Red Notes (t97): a note/file can be removed from the local item store out
     * from under an open editor — a remote delete, or a conflict resolution that discards
     * this uuid in favor of a duplicate (see recoverRemovedItemController below) — and
     * nothing previously reacted to that here. The controller kept holding a uuid that no
     * longer resolved, so the FIRST anyone heard about it was NoteSyncController's
     * save-time guard raising InfoStrings.InvalidNote on the user's next keystroke. This
     * mirrors the existing vault-scoped close-on-removal in ItemListController
     * (closeRemovedVaultItemControllers) but generalizes it to any removal, and — unlike
     * that one — tries to recover first rather than only closing.
     */
    this.eventObservers.push(
      this.items.streamItems<SNNote | FileItem>([ContentType.TYPES.Note, ContentType.TYPES.File], ({ removed }) => {
        if (removed.length === 0) {
          return
        }
        this.handleRemovedItems(removed)
      }),
    )
  }

  public deinit(): void {
    this.cancelChecklistEditorReservationsForSecurity()
    ;(this.items as unknown) = undefined

    this.eventObservers.forEach((removeObserver) => {
      removeObserver()
    })

    this.changeObservers.length = 0

    for (const controller of this.itemControllers) {
      this.closeItemController(controller, { notify: false })
    }
    for (const controller of this.detachedNoteControllers) {
      controller.deinitImmediatelyForSecurity()
      this.notifyDetachedControllerClosed(controller)
    }
    this.detachedNoteControllers.clear()

    this.itemControllers.length = 0
  }

  async createItemController(context: CreateItemControllerContext): Promise<NoteViewController | FileViewController> {
    const reservation =
      context.note?.noteType === NoteType.Super ? this.reserveVisibleChecklistOwner(context.note) : undefined
    try {
      if (reservation) {
        // Reserve before any asynchronous outgoing-controller flush so Todo
        // acquisition cannot mount a second whole-body editor in the gap.
        await this.releaseDetachedChecklistOwnerForVisibleOpen(reservation)
        this.assertVisibleChecklistReservationCurrent(reservation)
      }
      return await this.createItemControllerAfterChecklistPreflight(context, reservation)
    } catch (error) {
      if (reservation) {
        this.clearVisibleChecklistReservation(reservation)
      }
      throw error
    }
  }

  private async createItemControllerAfterChecklistPreflight(
    context: CreateItemControllerContext,
    reservation?: VisibleChecklistReservation,
  ): Promise<NoteViewController | FileViewController> {
    /**
     * Default (legacy) behavior replaces the active tile by closing it first, so that
     * selecting a note in the list reuses the single open editor. When `openInNewTile`
     * is set we keep the existing controllers open and simply add a new one.
     */
    if (!context.openInNewTile && this.activeItemViewController) {
      /**
       * Standard Red Notes (last-edit-loss fix — note-switch): the outgoing controller
       * is closed/deinited SYNCHRONOUSLY here, BEFORE React unmounts its
       * <SuperEditor key={uuid}>. The editor's unmount-flush would then fire on a
       * deinited controller (item nulled) and the edit would be lost. So FLUSH the
       * outgoing editor's pending debounced serialize AND await local propagation
       * (also inserts a brand-new template note) BEFORE closing it.
       */
      await this.flushAndCloseItemController(
        this.activeItemViewController,
        reservation ? () => this.visibleChecklistReservationIsCurrent(reservation) : undefined,
      )
      if (reservation) {
        this.assertVisibleChecklistReservationCurrent(reservation)
      }
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

    try {
      await controller.initialize()
      if (reservation) {
        this.assertVisibleChecklistReservationCurrent(reservation)
      }
    } catch (error) {
      removeFromArray(this.itemControllers, controller)
      if (this.activeControllerRef === controller) {
        this.activeControllerRef = this.itemControllers[this.itemControllers.length - 1]
      }
      if (controller instanceof NoteViewController) {
        controller.deinitImmediatelyForSecurity()
      } else {
        controller.deinit()
      }
      throw error
    }

    if (reservation && controller instanceof NoteViewController) {
      reservation.controller = controller
    }

    if (reservation) {
      this.assertVisibleChecklistReservationCurrent(reservation)
    }
    this.itemControllers.push(controller)
    this.activeControllerRef = controller

    this.notifyObservers()

    return controller
  }

  /** Create an initialized editor owner without changing visible tabs/selection. */
  async createDetachedNoteController(
    note: SNNote,
    onCreated?: (controller: NoteViewController) => (() => void) | undefined,
  ): Promise<NoteViewController> {
    const preparation = this.reserveDetachedChecklistOwner(note)
    const controller = new NoteViewController(
      note,
      this.items,
      this.mutator,
      this.sync,
      this.sessions,
      this.preferences,
      this.components,
      this.alerts,
      this._isNativeMobileWeb,
    )
    this.detachedNoteControllers.add(controller)
    try {
      await controller.initialize()
      if (
        preparation.canceled ||
        preparation.generation !== this.checklistSecurityGeneration ||
        this.detachedChecklistPreparations.get(note.uuid)?.token !== preparation.token ||
        !this.checklistPrincipalIsCurrent(note.uuid, preparation.principal)
      ) {
        throw new ChecklistEditorOwnershipError('Checklist editor ownership changed while the source note was loading.')
      }
      const onClosed = onCreated?.(controller)
      if (onClosed) {
        this.detachedControllerClosedCallbacks.set(controller, onClosed)
      }
      this.detachedChecklistPreparations.delete(note.uuid)
      preparation.resolve(controller)
      return controller
    } catch (error) {
      if (this.detachedChecklistPreparations.get(note.uuid)?.token === preparation.token) {
        this.detachedChecklistPreparations.delete(note.uuid)
      }
      preparation.resolve(undefined)
      this.detachedNoteControllers.delete(controller)
      controller.deinitImmediatelyForSecurity()
      this.notifyDetachedControllerClosed(controller)
      throw error
    }
  }

  async flushAndCloseDetachedNoteController(controller: NoteViewController): Promise<void> {
    if (!this.detachedNoteControllers.has(controller)) {
      return
    }
    await controller.flushAndAwaitPendingSaveStrict()
    this.detachedNoteControllers.delete(controller)
    controller.deinit()
    this.notifyDetachedControllerClosed(controller)
  }

  closeDetachedNoteControllerImmediately(controller: NoteViewController): void {
    if (!this.detachedNoteControllers.delete(controller)) {
      return
    }
    controller.deinitImmediatelyForSecurity()
    this.notifyDetachedControllerClosed(controller)
  }

  public hasVisibleChecklistController(noteUuid: string): boolean {
    return (
      (this.visibleChecklistReservations.get(noteUuid)?.size ?? 0) > 0 ||
      this.itemControllers.some(
        (controller) => controller instanceof NoteViewController && controller.item?.uuid === noteUuid,
      )
    )
  }

  public markVisibleChecklistControllerReady(controller: NoteViewController): void {
    for (const reservation of this.visibleChecklistReservations.get(controller.item.uuid) ?? []) {
      if (reservation.controller === controller && this.visibleChecklistReservationIsCurrent(reservation)) {
        reservation.ready = true
      }
    }
  }

  public cancelChecklistEditorReservationsForSecurity(noteUuid?: string): void {
    // A note-scoped revocation must not invalidate editors for every other note.
    // The note's reservations/preparations are canceled explicitly below; reserve
    // the shared generation bump for account, vault-key, and lifecycle boundaries
    // that intentionally invalidate all checklist editor work.
    if (!noteUuid) {
      this.checklistSecurityGeneration += 1
    }
    const visibleEntries = noteUuid
      ? [[noteUuid, this.visibleChecklistReservations.get(noteUuid)] as const]
      : [...this.visibleChecklistReservations.entries()]
    for (const [, reservations] of visibleEntries) {
      if (!reservations) {
        continue
      }
      for (const reservation of reservations) {
        reservation.canceled = true
      }
    }
    if (noteUuid) {
      this.visibleChecklistReservations.delete(noteUuid)
    } else {
      this.visibleChecklistReservations.clear()
    }
    const detachedEntries = noteUuid
      ? [[noteUuid, this.detachedChecklistPreparations.get(noteUuid)] as const]
      : [...this.detachedChecklistPreparations.entries()]
    for (const [, preparation] of detachedEntries) {
      if (!preparation) {
        continue
      }
      preparation.canceled = true
      preparation.resolve(undefined)
    }
    if (noteUuid) {
      this.detachedChecklistPreparations.delete(noteUuid)
    } else {
      this.detachedChecklistPreparations.clear()
    }
  }

  private captureChecklistPrincipal(note: SNNote): ChecklistPrincipal {
    return {
      ...captureChecklistSessionPrincipal(this.sessions),
      keySystemIdentifier: note.key_system_identifier,
    }
  }

  private checklistPrincipalIsCurrent(noteUuid: string, expected: ChecklistPrincipal): boolean {
    const note = this.items.findItem<SNNote>(noteUuid)
    if (!note || note.uuid !== noteUuid || note.key_system_identifier !== expected.keySystemIdentifier) {
      return false
    }
    const current = captureChecklistSessionPrincipal(this.sessions)
    return checklistSessionPrincipalMatches(expected, current)
  }

  private reserveVisibleChecklistOwner(note: SNNote): VisibleChecklistReservation {
    const reservation: VisibleChecklistReservation = {
      token: {},
      noteUuid: note.uuid,
      principal: this.captureChecklistPrincipal(note),
      generation: this.checklistSecurityGeneration,
      canceled: false,
      ready: false,
    }
    let reservations = this.visibleChecklistReservations.get(note.uuid)
    if (!reservations) {
      reservations = new Set()
      this.visibleChecklistReservations.set(note.uuid, reservations)
    }
    reservations.add(reservation)
    return reservation
  }

  private visibleChecklistReservationIsCurrent(expected: VisibleChecklistReservation): boolean {
    const reservations = this.visibleChecklistReservations.get(expected.noteUuid)
    return (
      !expected.canceled &&
      expected.generation === this.checklistSecurityGeneration &&
      Boolean(
        [...((reservations as Set<VisibleChecklistReservation> | undefined) ?? [])].find(
          (candidate) => candidate === expected && candidate.token === expected.token,
        ),
      ) &&
      this.checklistPrincipalIsCurrent(expected.noteUuid, expected.principal)
    )
  }

  private assertVisibleChecklistReservationCurrent(expected: VisibleChecklistReservation): void {
    if (!this.visibleChecklistReservationIsCurrent(expected)) {
      throw new ChecklistEditorOpeningCanceledError('Source-note authorization changed while opening the editor.')
    }
  }

  private clearVisibleChecklistReservation(expected: VisibleChecklistReservation): void {
    expected.canceled = true
    const reservations = this.visibleChecklistReservations.get(expected.noteUuid)
    reservations?.delete(expected)
    if (reservations?.size === 0) {
      this.visibleChecklistReservations.delete(expected.noteUuid)
    }
  }

  private reserveDetachedChecklistOwner(note: SNNote): DetachedChecklistPreparation {
    if (note.noteType !== NoteType.Super || this.hasVisibleChecklistController(note.uuid)) {
      throw new ChecklistEditorOwnershipError('The source note is already open in another editor.')
    }
    if (
      this.detachedChecklistPreparations.has(note.uuid) ||
      [...this.detachedNoteControllers].some((controller) => controller.item?.uuid === note.uuid)
    ) {
      throw new ChecklistEditorOwnershipError('A detached source-note editor is already being prepared.')
    }
    let resolve!: (controller: NoteViewController | undefined) => void
    const promise = new Promise<NoteViewController | undefined>((done) => {
      resolve = done
    })
    const preparation: DetachedChecklistPreparation = {
      token: {},
      noteUuid: note.uuid,
      principal: this.captureChecklistPrincipal(note),
      generation: this.checklistSecurityGeneration,
      canceled: false,
      promise,
      resolve,
    }
    this.detachedChecklistPreparations.set(note.uuid, preparation)
    return preparation
  }

  private async releaseDetachedChecklistOwnerForVisibleOpen(reservation: VisibleChecklistReservation): Promise<void> {
    const preparing = this.detachedChecklistPreparations.get(reservation.noteUuid)
    if (preparing) {
      await preparing.promise
    }
    this.assertVisibleChecklistReservationCurrent(reservation)
    const conflicts = [...this.detachedNoteControllers].filter(
      (controller) => controller.item?.uuid === reservation.noteUuid,
    )
    for (const controller of conflicts) {
      try {
        // The detached owner remains registered/mounted until this strict local
        // and provider flush succeeds; its exact close callback then clears it.
        await this.flushAndCloseDetachedNoteController(controller)
        this.assertVisibleChecklistReservationCurrent(reservation)
      } catch (error) {
        if (error instanceof ChecklistEditorOpeningCanceledError) {
          throw error
        }
        throw new ChecklistEditorOwnershipError(
          'The pending Todo update could not be saved, so the source note was not opened.',
        )
      }
    }
  }

  private notifyDetachedControllerClosed(controller: NoteViewController): void {
    const callback = this.detachedControllerClosedCallbacks.get(controller)
    this.detachedControllerClosedCallbacks.delete(controller)
    callback?.()
  }

  /**
   * Standard Red Notes (last-edit-loss fix — note-switch): flush the outgoing note
   * editor's pending debounced serialize and AWAIT local propagation before deiniting,
   * so an edit typed within the ~1s debounce window (not yet dirty) is persisted rather
   * than dropped when its <SuperEditor> later unmounts onto a deinited controller. For
   * a template note the flush goes through saveAndAwaitLocalPropagation, which inserts
   * the template first. File controllers have no editor debounce, so this just closes.
   */
  private async flushAndCloseItemController(
    controller: NoteViewController | FileViewController,
    canContinue?: () => boolean,
  ): Promise<void> {
    if (controller instanceof NoteViewController) {
      try {
        await controller.flushAndAwaitPendingSave()
        if (canContinue && !canContinue()) {
          throw new ChecklistEditorOpeningCanceledError('Source-note authorization changed while opening the editor.')
        }
      } catch (error) {
        if (!(error instanceof ChecklistEditorOpeningCanceledError)) {
          console.error(error)
        }
        // A live collaboration durability flush failed. Keep the authoritative
        // controller mounted; closing it would discard its only unsent Y.Doc.
        throw error
      }
    }
    this.closeItemController(controller, { notify: false })
  }

  public closeItemController(
    controller: NoteViewController | FileViewController,
    { notify = true, securitySensitive = false }: { notify?: boolean; securitySensitive?: boolean } = {},
  ): void {
    const controllerNoteUuid = controller instanceof NoteViewController ? controller.item?.uuid : undefined
    if (controller instanceof NoteViewController) {
      if (securitySensitive) {
        // Vault keys or authorization are already gone. Do not flush/sync a
        // retained plaintext editor; synchronously scrub it before notifying UI.
        controller.deinitImmediatelyForSecurity()
      } else {
        controller.syncOnlyIfLargeNote()
        controller.deinit()
      }
    } else {
      controller.deinit()
    }

    removeFromArray(this.itemControllers, controller)
    if (controller instanceof NoteViewController) {
      for (const reservation of [...(this.visibleChecklistReservations.get(controllerNoteUuid ?? '') ?? [])]) {
        if (reservation.controller === controller) {
          this.clearVisibleChecklistReservation(reservation)
        }
      }
    }

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

  /**
   * Standard Red Notes (t97): react to a note/file disappearing from the local item store
   * while it is open in a tile. Dispatches recovery per affected controller; fire-and-forget
   * is safe here because recoverRemovedItemController re-checks membership in
   * itemControllers before and after its only await, so a stale/duplicate notification, or
   * the user closing the tab themselves in the meantime, is a no-op rather than a race.
   */
  private handleRemovedItems(removed: { uuid: string }[]): void {
    const removedUuids = new Set(removed.map((item) => item.uuid))

    for (const controller of [...this.itemControllers]) {
      const uuid = controller.item?.uuid
      if (!uuid || !removedUuids.has(uuid)) {
        continue
      }

      void this.recoverRemovedItemController(controller, uuid)
    }
  }

  /**
   * Standard Red Notes (t97): the removed uuid may already have a successor item under a
   * new uuid, reachable via `findRescueCopy` below. Two distinct, unrelated mechanisms
   * produce one:
   *   - A conflict resolver preserving a dirty local edit against an incoming remote
   *     delete (GenericItem.strategyWhenConflictingWithItem -> ConflictStrategy.DuplicateBaseKeepApply):
   *     the user's unsaved content survives as a genuine conflict copy, tagged BOTH
   *     `content.conflict_of` and `content.duplicate_of` = this uuid.
   *   - A uuid alternation (PayloadsByAlternatingUuid, e.g. importing a backup whose uuids
   *     collide with the account's own): the SAME item is simply re-identified under a new
   *     uuid. Nothing was lost or conflicted — the item is tagged ONLY
   *     `content.duplicate_of`, deliberately not `conflict_of` (setting the latter there
   *     would misrepresent a clean re-identification as a conflict, and would fire a
   *     "Recovered" notification per item during a bulk import).
   * Either way the editor's job is the same — follow to the new uuid — so prefer migrating
   * the open tile to it in place over closing outright. For the conflict case, the
   * alternative is telling the user to manually copy text the app already copied for them,
   * into a note they have no idea exists (worse still: the notes list does not surface
   * conflict copies at all, so migrating here is their only route to it). For the
   * alternation case, closing would show the "this note was deleted" backstop alert, which
   * is simply untrue — the content is intact, just under a different uuid. Only when
   * neither relationship is found is the note genuinely just gone, and the tile is closed.
   */
  private async recoverRemovedItemController(
    controller: NoteViewController | FileViewController,
    removedUuid: string,
  ): Promise<void> {
    if (!this.itemControllers.includes(controller)) {
      return
    }

    const rescueCopy = this.findRescueCopy(removedUuid)
    if (!rescueCopy) {
      this.closeItemController(controller, { securitySensitive: true })
      return
    }

    let replacement: NoteViewController | FileViewController
    try {
      replacement =
        rescueCopy.content_type === ContentType.TYPES.File
          ? new FileViewController(rescueCopy as unknown as FileItem, this.items)
          : new NoteViewController(
              rescueCopy as unknown as SNNote,
              this.items,
              this.mutator,
              this.sync,
              this.sessions,
              this.preferences,
              this.components,
              this.alerts,
              this._isNativeMobileWeb,
            )
      await replacement.initialize()
    } catch {
      // Recovery failed (e.g. the rescue copy itself vanished mid-initialize). Fall back to
      // a clean close rather than leaving a half-initialized controller mounted.
      if (this.itemControllers.includes(controller)) {
        this.closeItemController(controller, { securitySensitive: true })
      }
      return
    }

    if (!this.itemControllers.includes(controller)) {
      // Superseded while the replacement was initializing (the user closed the tab, or a
      // second removal notification for the same uuid already handled it). Discard it.
      if (replacement instanceof NoteViewController) {
        replacement.deinitImmediatelyForSecurity()
      } else {
        replacement.deinit()
      }
      return
    }

    const index = this.itemControllers.indexOf(controller)
    const wasActive = this.activeControllerRef === controller

    this.closeItemController(controller, { securitySensitive: true, notify: false })

    this.itemControllers.splice(index, 0, replacement)
    if (wasActive) {
      this.activeControllerRef = replacement
    }

    this.notifyObservers()
  }

  /**
   * Standard Red Notes (t97): NOT `ItemManager.conflictsOf`. It looks like the right
   * API — it reads the same `content.conflict_of` relationship — but it is backed by
   * `Collection`'s conflictMap, and `Collection.discard()` unconditionally calls
   * `conflictMap.removeFromMap(originalUuid)` when the original uuid is removed
   * (PayloadManager.applyPayloads -> ItemCollection.onChange's `set` then `discard`).
   * That wipes the very relationship entry this method would need, established moments
   * earlier in the SAME batch when the rescue copy was inserted. By the time this
   * removal observer runs, `conflictsOf(removedUuid)` reliably returns nothing —
   * indistinguishable from "no copy exists" — so it cannot be used even as a first
   * attempt behind a fallback. Scan `content.conflict_of` / `content.duplicate_of`
   * directly instead, which sidesteps the map entirely and is unaffected by discard
   * ordering.
   *
   * Matches BOTH relationships in one pass (see the class-doc on
   * recoverRemovedItemController for what each means) rather than two separate lookups
   * concatenated, specifically so an item matching both (every conflict-path copy also
   * carries `duplicate_of`) appears in `candidates` exactly once — not twice, and not
   * tie-broken against itself. Precedent for OR-ing the two relationships in one
   * predicate: `ItemsEncryption.itemsKeyForEncryptedPayload`
   * (`key.uuid === id || key.duplicateOf === id`). If more than one distinct candidate
   * exists (unexpected — normally at most one successor is created per removal), the
   * most recently updated one wins.
   */
  private findRescueCopy(removedUuid: string): SNNote | FileItem | undefined {
    const candidates = this.items
      .getItems<SNNote | FileItem>([ContentType.TYPES.Note, ContentType.TYPES.File])
      .filter((candidate) => candidate.conflictOf === removedUuid || candidate.duplicateOf === removedUuid)

    if (candidates.length === 0) {
      return undefined
    }

    return candidates.reduce((newest, candidate) =>
      (candidate.serverUpdatedAtTimestamp ?? 0) > (newest.serverUpdatedAtTimestamp ?? 0) ? candidate : newest,
    )
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
