import type { ChangeEditorFunction } from '../Plugins/ChangeContentCallback/ChangeContentCallback'
import type { NoteEncryptionIdentity } from './CollaborationKeyDerivation'
import {
  isLitePayload,
  PayloadSource,
  type DecryptedPayloadInterface,
  type FullyFormedPayloadInterface,
  type NoteContent,
} from '@standardnotes/snjs'

type AttachedCollaboration = {
  isAttached(): boolean
}

export type RetrievedEditorUpdateToken = object

const MAX_RETRIEVED_EDITOR_RESTORE_ATTEMPTS = 3

type PersistedPayloadEnvelope = Pick<
  DecryptedPayloadInterface,
  | 'uuid'
  | 'content_type'
  | 'content'
  | 'deleted'
  | 'created_at'
  | 'created_at_timestamp'
  | 'updated_at'
  | 'updated_at_timestamp'
  | 'dirty'
  | 'duplicate_of'
  | 'user_uuid'
  | 'key_system_identifier'
  | 'shared_vault_uuid'
  | 'last_edited_by_uuid'
>

function canonicalJsonValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString()
  }
  if (Array.isArray(value)) {
    return value.map((entry) => (entry === undefined ? null : canonicalJsonValue(entry)))
  }
  if (typeof value !== 'object' || value === null) {
    return value
  }

  const result: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const entry = (value as Record<string, unknown>)[key]
    if (entry !== undefined) {
      result[key] = canonicalJsonValue(entry)
    }
  }
  return result
}

/** Compare values exactly as their JSON persistence representation does. */
export function persistedJsonValuesEqual(first: unknown, second: unknown): boolean {
  try {
    return JSON.stringify(canonicalJsonValue(first)) === JSON.stringify(canonicalJsonValue(second))
  } catch {
    return false
  }
}

/**
 * Build the teardown fallback from the latest authorized primary content, not
 * from the earlier incoming snapshot. The JSON round trip independently owns
 * nested references/appData so a later live mutation cannot rewrite the copy
 * while it is being persisted.
 */
export function buildRetrievedEditorFallbackContent(input: {
  currentContent: NoteContent
  text: string
  previewPlain: string
  previewHtml: string | undefined
}): NoteContent {
  const currentContent = JSON.parse(JSON.stringify(input.currentContent)) as NoteContent
  return {
    ...currentContent,
    text: input.text,
    preview_plain: input.previewPlain,
    preview_html: input.previewHtml ?? '',
  }
}

export function persistedPayloadEnvelopesEqual(
  first: PersistedPayloadEnvelope,
  second: PersistedPayloadEnvelope,
): boolean {
  return (
    first.uuid === second.uuid &&
    first.content_type === second.content_type &&
    first.deleted === second.deleted &&
    first.created_at.getTime() === second.created_at.getTime() &&
    first.created_at_timestamp === second.created_at_timestamp &&
    first.updated_at.getTime() === second.updated_at.getTime() &&
    first.updated_at_timestamp === second.updated_at_timestamp &&
    first.dirty === second.dirty &&
    first.duplicate_of === second.duplicate_of &&
    first.user_uuid === second.user_uuid &&
    first.key_system_identifier === second.key_system_identifier &&
    first.shared_vault_uuid === second.shared_vault_uuid &&
    first.last_edited_by_uuid === second.last_edited_by_uuid &&
    persistedJsonValuesEqual(first.content, second.content)
  )
}

/**
 * Verify the stable payload envelope written by LocalStorage conversion plus the
 * complete decrypted content. Dirty-index/last-sync bookkeeping is intentionally
 * excluded because the LocalStorage contextual payload does not persist it;
 * source and all fields it does persist are checked explicitly.
 */
export function isExactLocalDatabasePayload(
  persisted: DecryptedPayloadInterface | undefined,
  expected: PersistedPayloadEnvelope,
): persisted is DecryptedPayloadInterface {
  return Boolean(
    persisted &&
    persisted.source === PayloadSource.LocalDatabaseLoaded &&
    !isLitePayload(persisted) &&
    persistedPayloadEnvelopesEqual(persisted, expected),
  )
}

/**
 * Persist both representations in one storage transaction and independently
 * prove both exact UUIDs came back from the local database. Resolution of the
 * persistence call alone is deliberately insufficient: SyncService may be
 * deallocated and no-op, and a stale/session-swapped read must fail closed.
 */
export async function persistAndVerifyRetrievedPayloadPair(input: {
  first: DecryptedPayloadInterface
  second: DecryptedPayloadInterface
  validate(): boolean
  persist(payloads: FullyFormedPayloadInterface[]): Promise<void>
  read(uuid: string): Promise<DecryptedPayloadInterface | undefined>
}): Promise<void> {
  const validate = (): boolean => {
    try {
      return input.validate()
    } catch {
      return false
    }
  }
  if (
    !validate() ||
    input.first.uuid === input.second.uuid ||
    isLitePayload(input.first) ||
    isLitePayload(input.second)
  ) {
    throw new Error('retrieved-conflict-persistence-not-authorized')
  }

  await input.persist([input.first, input.second])
  if (!validate()) {
    throw new Error('retrieved-conflict-persistence-identity-changed')
  }

  const [firstReadback, secondReadback] = await Promise.all([
    input.read(input.first.uuid),
    input.read(input.second.uuid),
  ])
  if (
    !validate() ||
    !isExactLocalDatabasePayload(firstReadback, input.first) ||
    !isExactLocalDatabasePayload(secondReadback, input.second)
  ) {
    throw new Error('retrieved-conflict-persistence-readback-mismatch')
  }
}

/** Schedule ordinary upload only after the complete local proof succeeded. */
export async function scheduleRetrievedSyncAfterPreservation(input: {
  work: Promise<boolean>
  validate(): boolean
  schedule(): void
}): Promise<boolean> {
  const preserved = await input.work
  let valid = false
  try {
    valid = input.validate()
  } catch {
    valid = false
  }
  if (preserved && valid) {
    input.schedule()
  }
  return preserved && valid
}

type PreserveDivergentRetrieved = (value: {
  incomingText: string
  collaborativeText: string
  serverUpdatedAtTimestamp: number
}) => boolean | Promise<boolean>

type RetrievedConflictTask = {
  revision: number
  incomingText: string
  collaborativeText: string
  currentCollaborativeText?: () => string
  preserve: PreserveDivergentRetrieved
}

type RetrievedConflictQueue = {
  active?: RetrievedConflictTask
  queued?: RetrievedConflictTask
}

export type RetrievedDurableState = {
  serverUpdatedAtTimestamp: number
  text: string
  /** At most one in-flight preservation and one coalesced latest revision. */
  pending?: RetrievedConflictQueue
}

export type RetrievedReconciliationLifetime = {
  identity?: NoteEncryptionIdentity
  noteUuid: string
  latestEditorText: { current: string }
  latestEditorPreview: {
    current: {
      previewPlain: string
      previewHtml: string | undefined
    }
  }
  durableState: RetrievedDurableState
  conflictPreservationQueue: { current: Promise<void> }
}

function identitiesMatch(
  first: NoteEncryptionIdentity | undefined,
  second: NoteEncryptionIdentity | undefined,
): boolean {
  if (!first || !second) {
    return first === second
  }
  return (
    first.noteUuid === second.noteUuid &&
    first.userUuid === second.userUuid &&
    first.sessionUser === second.sessionUser &&
    first.sourceId === second.sourceId &&
    first.keySystemIdentifier === second.keySystemIdentifier &&
    first.sharedVaultUuid === second.sharedVaultUuid
  )
}

/**
 * A detached relay does not erase an editor body that was already accepted by
 * this exact committed session/root-key lifetime. Preserve that demonstrably
 * divergent body, but fail closed for a speculative render, identity rollover,
 * or a clean detached editor that has nothing local to protect.
 */
export function ownsRetrievedEditorBody(input: {
  committedLifetime: RetrievedReconciliationLifetime | undefined
  expectedLifetime: RetrievedReconciliationLifetime
  expectedIdentity: NoteEncryptionIdentity | undefined
  liveIdentity: NoteEncryptionIdentity | undefined
  ownerMatchesCurrentPrincipal: boolean
  collaboration: { validateAttachment(): boolean } | undefined
  latestEditorText: string
  durableText: string
}): boolean {
  if (
    input.committedLifetime !== input.expectedLifetime ||
    !input.ownerMatchesCurrentPrincipal ||
    !input.expectedIdentity ||
    !identitiesMatch(input.expectedLifetime.identity, input.expectedIdentity) ||
    !identitiesMatch(input.expectedIdentity, input.liveIdentity)
  ) {
    return false
  }

  try {
    if (input.collaboration?.validateAttachment()) {
      return true
    }
  } catch {
    // A closed lease is expected while offline; divergence below remains the
    // only accepted proof that this committed lifetime still owns local work.
  }
  return input.latestEditorText !== input.durableText
}

/**
 * Bind all mutable reconciliation state to one exact note/session/root-key
 * lifetime. Old asynchronous tasks retain the old object and therefore cannot
 * advance or overwrite a same-UUID lifetime created after sign-in/key rotation.
 */
export function bindRetrievedReconciliationLifetime(
  current: RetrievedReconciliationLifetime | undefined,
  input: {
    identity?: NoteEncryptionIdentity
    noteUuid: string
    serverUpdatedAtTimestamp: number
    text: string
    previewPlain: string
    previewHtml: string | undefined
  },
): RetrievedReconciliationLifetime {
  if (current?.noteUuid === input.noteUuid && identitiesMatch(current.identity, input.identity)) {
    return current
  }
  return {
    identity: input.identity,
    noteUuid: input.noteUuid,
    latestEditorText: { current: input.text },
    latestEditorPreview: {
      current: {
        previewPlain: input.previewPlain,
        previewHtml: input.previewHtml,
      },
    },
    durableState: {
      serverUpdatedAtTimestamp: input.serverUpdatedAtTimestamp,
      text: input.text,
    },
    conflictPreservationQueue: { current: Promise.resolve() },
  }
}

/** Clear composer-owned references before a replacement identity can prepare access. */
export type RetrievedEditorSurfaceState<Owner, Note> = {
  owner: Owner
  lifetime: RetrievedReconciliationLifetime
  generation: number
  note: Note
}

/**
 * Publish a render-local surface plan only after React commits that render.
 * The expected-previous guard makes an obsolete concurrent render a no-op,
 * while an abandoned render never calls this function at all and therefore
 * cannot invalidate the editor that is still mounted on screen.
 */
export function commitRetrievedEditorSurfaceForLifetime<Owner, Note>(input: {
  expectedPrevious: RetrievedEditorSurfaceState<Owner, Note>
  next: RetrievedEditorSurfaceState<Owner, Note>
  committedSurfaceRef: { current: RetrievedEditorSurfaceState<Owner, Note> }
  ownerRef: { current: Owner }
  lifetimeRef: { current: RetrievedReconciliationLifetime }
  generationRef: { current: number }
  noteRef: { current: Note }
  changeEditorFunctionRef: { current: ChangeEditorFunction | undefined }
  ignoreNextChangeRef: { current: RetrievedEditorUpdateToken | undefined }
}): boolean {
  if (input.committedSurfaceRef.current === input.next) {
    return true
  }
  if (input.committedSurfaceRef.current !== input.expectedPrevious) {
    return false
  }

  const resetComposerOwnedState =
    input.expectedPrevious.owner !== input.next.owner || input.expectedPrevious.lifetime !== input.next.lifetime
  input.committedSurfaceRef.current = input.next
  input.ownerRef.current = input.next.owner
  input.lifetimeRef.current = input.next.lifetime
  input.generationRef.current = input.next.generation
  input.noteRef.current = input.next.note
  if (resetComposerOwnedState) {
    input.changeEditorFunctionRef.current = undefined
    input.ignoreNextChangeRef.current = undefined
  }
  return true
}

/**
 * Flush a pending serialize while the handler that owns it still sees its exact
 * committed lifetime. React runs layout-effect cleanup before publishing the
 * replacement layout effects, which prevents a later passive editor cleanup
 * from finding the new lifetime and silently discarding the old note's tail.
 */
export function flushAuthorizedRetrievedEditorSurfaceBeforeTransition<Owner>(input: {
  expectedOwner: Owner
  expectedLifetime: RetrievedReconciliationLifetime
  ownerRef: { current: Owner }
  lifetimeRef: { current: RetrievedReconciliationLifetime }
  validateAuthorization(): boolean
  hasPendingChanges(): boolean
  flushPendingChanges(): void
}): boolean {
  if (input.ownerRef.current !== input.expectedOwner || input.lifetimeRef.current !== input.expectedLifetime) {
    return false
  }

  try {
    if (!input.validateAuthorization()) {
      return false
    }
    if (input.hasPendingChanges()) {
      input.flushPendingChanges()
    }
    return true
  } catch {
    return false
  }
}

/**
 * Consume the ignore token with the exact programmatic Lexical update. Lexical's
 * onUpdate runs after update listeners have queued BlocksEditor's serialization,
 * so flushing here cannot coalesce a later user keystroke into the ignored work.
 */
export function applyRetrievedEditorContent(input: {
  text: string
  changeEditor: ChangeEditorFunction
  ignoreNextChangeRef: { current: RetrievedEditorUpdateToken | undefined }
  isLifetimeCurrent(): boolean
  flushEditorSerialize(): void
}): boolean {
  let current = false
  try {
    current = input.isLifetimeCurrent()
  } catch {
    current = false
  }
  if (!current) {
    return false
  }

  const token: RetrievedEditorUpdateToken = {}
  input.ignoreNextChangeRef.current = token
  try {
    input.changeEditor(input.text, () => {
      if (input.ignoreNextChangeRef.current !== token) {
        return
      }
      let lifetimeIsCurrent = false
      try {
        lifetimeIsCurrent = input.isLifetimeCurrent()
      } catch {
        lifetimeIsCurrent = false
      }
      if (!lifetimeIsCurrent) {
        input.ignoreNextChangeRef.current = undefined
        return
      }
      try {
        input.flushEditorSerialize()
      } finally {
        if (input.ignoreNextChangeRef.current === token) {
          input.ignoreNextChangeRef.current = undefined
        }
      }
    })
    return true
  } catch {
    if (input.ignoreNextChangeRef.current === token) {
      input.ignoreNextChangeRef.current = undefined
    }
    return false
  }
}

export function authorizedRetrievedEditorSurfaceNote<Note>(input: {
  lifetime: RetrievedReconciliationLifetime
  identity: NoteEncryptionIdentity | undefined
  note: Note
}): Note | undefined {
  return input.identity && identitiesMatch(input.lifetime.identity, input.identity) ? input.note : undefined
}

export function retrievedEditorComposerLifetimeKey(input: {
  noteUuid: string
  generation: number
  leaseRequestId?: string
}): string {
  return input.leaseRequestId
    ? `${input.noteUuid}:${input.generation}:${input.leaseRequestId}`
    : `${input.noteUuid}:${input.generation}:solo`
}

/** Serialize conflict-copy writes and read the live editor body only after copy. */
export function serializeRetrievedConflictPreservation<Value>(input: {
  previous: Promise<void>
  validateBeforeDuplicate(): boolean
  duplicate(): Promise<void>
  validateBeforeSave(): boolean
  getLatestValue(): Value
  save(value: Value): Promise<void>
  preserveLatestFallback?(value: Value): Promise<void>
}): { work: Promise<boolean>; tail: Promise<void> } {
  const work = input.previous
    .catch(() => undefined)
    .then(async (): Promise<boolean> => {
      try {
        if (!input.validateBeforeDuplicate()) {
          return false
        }
        await input.duplicate()
        for (let attempt = 0; attempt < MAX_RETRIEVED_EDITOR_RESTORE_ATTEMPTS; attempt += 1) {
          if (!input.validateBeforeSave()) {
            return false
          }
          try {
            const exactValue = input.getLatestValue()
            await input.save(exactValue)
            return true
          } catch {
            // The conflict copy already exists. Retry only the authoritative E3
            // restore so one transient local persistence failure cannot advance
            // the retrieved revision high-water or create duplicate conflict copies.
          }
        }
        if (!input.preserveLatestFallback || !input.validateBeforeSave()) {
          return false
        }
        await input.preserveLatestFallback(input.getLatestValue())
        // The original may still contain the retrieved body, but both bodies are
        // now durably represented. This closes permanent-save/unmount loss without
        // duplicating the incoming conflict a second time.
        return true
      } catch {
        return false
      }
    })
  return {
    work,
    tail: work.then(
      () => undefined,
      () => undefined,
    ),
  }
}

function runRetrievedConflictTask(
  durableState: RetrievedDurableState,
  queue: RetrievedConflictQueue,
  task: RetrievedConflictTask,
): void {
  queue.active = task
  // Defer one microtask so an already-delivered Yjs update can settle before we
  // create a false conflict copy from its lagging HTTP echo.
  void Promise.resolve()
    .then(async (): Promise<boolean> => {
      if (task.revision <= durableState.serverUpdatedAtTimestamp) {
        return false
      }
      const currentCollaborativeText = task.currentCollaborativeText?.() ?? task.collaborativeText
      if (currentCollaborativeText === task.incomingText) {
        return true
      }
      return task.preserve({
        incomingText: task.incomingText,
        collaborativeText: currentCollaborativeText,
        serverUpdatedAtTimestamp: task.revision,
      })
    })
    .then((preserved) => {
      if (preserved && task.revision > durableState.serverUpdatedAtTimestamp) {
        durableState.serverUpdatedAtTimestamp = task.revision
        durableState.text = task.incomingText
      }
    })
    .catch(() => undefined)
    .finally(() => {
      if (durableState.pending !== queue || queue.active !== task) {
        return
      }
      queue.active = undefined
      const queued = queue.queued
      queue.queued = undefined
      if (queued && queued.revision > durableState.serverUpdatedAtTimestamp) {
        runRetrievedConflictTask(durableState, queue, queued)
        return
      }
      durableState.pending = undefined
    })
}

function enqueueRetrievedConflict(durableState: RetrievedDurableState, task: RetrievedConflictTask): void {
  const queue = (durableState.pending ??= {})
  const active = queue.active
  if (!active) {
    runRetrievedConflictTask(durableState, queue, task)
    return
  }
  if (active.revision === task.revision && active.incomingText === task.incomingText) {
    return
  }
  // Durable server history is monotonic. While one revision is being secured,
  // only the newest later snapshot can affect the final high-water; replacing
  // intermediate closures keeps burst memory deterministic.
  if (task.revision > active.revision && (!queue.queued || task.revision >= queue.queued.revision)) {
    queue.queued = task
  }
}

/**
 * Reconcile a durable retrieved note with the current editor ownership model.
 * Once Yjs is attached, its document is authoritative for the body: an HTTP
 * revision can lag realtime state and must never replace the collaborative
 * editor or emit CRDT deletions. Metadata still advances in the caller.
 */
export function reconcileRetrievedNoteContent(input: {
  text: string
  serverUpdatedAtTimestamp?: number
  collaboration?: AttachedCollaboration
  collaborationHasLocalDivergence?(): boolean
  currentCollaborativeText?: () => string
  durableState?: RetrievedDurableState
  preserveDivergentRetrieved?: PreserveDivergentRetrieved
  editorHasPendingChanges(): boolean
  flushEditorSerialize(): void
  changeEditor?: ChangeEditorFunction
  ignoreNextChangeRef: { current: RetrievedEditorUpdateToken | undefined }
  isEditorLifetimeCurrent?(): boolean
}): 'preserved-collaboration' | 'preserved-conflict' | 'applied' | 'deferred' {
  if (input.editorHasPendingChanges()) {
    input.flushEditorSerialize()
  }
  if (input.collaboration?.isAttached() || input.collaborationHasLocalDivergence?.()) {
    input.ignoreNextChangeRef.current = undefined
    const revision = input.serverUpdatedAtTimestamp
    const durableState = input.durableState
    const collaborativeText = input.currentCollaborativeText?.()
    if (revision === undefined || !durableState || collaborativeText === undefined) {
      return 'preserved-collaboration'
    }
    if (revision <= durableState.serverUpdatedAtTimestamp) {
      return 'preserved-collaboration'
    }
    if (input.text === collaborativeText) {
      durableState.serverUpdatedAtTimestamp = revision
      durableState.text = input.text
      return 'preserved-collaboration'
    }
    if (!input.preserveDivergentRetrieved) {
      return 'preserved-collaboration'
    }
    enqueueRetrievedConflict(durableState, {
      revision,
      incomingText: input.text,
      collaborativeText,
      currentCollaborativeText: input.currentCollaborativeText,
      preserve: input.preserveDivergentRetrieved,
    })
    return 'preserved-conflict'
  }
  if (
    input.durableState &&
    input.serverUpdatedAtTimestamp !== undefined &&
    input.serverUpdatedAtTimestamp > input.durableState.serverUpdatedAtTimestamp
  ) {
    input.durableState.serverUpdatedAtTimestamp = input.serverUpdatedAtTimestamp
    input.durableState.text = input.text
  }
  if (input.changeEditor) {
    return applyRetrievedEditorContent({
      text: input.text,
      changeEditor: input.changeEditor,
      ignoreNextChangeRef: input.ignoreNextChangeRef,
      isLifetimeCurrent: input.isEditorLifetimeCurrent ?? (() => true),
      flushEditorSerialize: input.flushEditorSerialize,
    })
      ? 'applied'
      : 'deferred'
  }

  // Between composer lifetimes there is no editor update to ignore. The next
  // composer initializes from the latest note body.
  input.ignoreNextChangeRef.current = undefined
  return 'deferred'
}
