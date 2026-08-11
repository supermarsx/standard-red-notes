import { FunctionComponent, Suspense, useEffect, useState } from 'react'
import { ApplicationEvent, ContentType, SNNote, VaultLockServiceEvent } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { lazyWithRetry } from '@/Utils/lazyWithRetry'
import { NoteViewController } from '../NoteView/Controller/NoteViewController'
import { canMutateSuperChecklistNote } from './todoAuthorization'

const SuperEditor = lazyWithRetry(() => import('../SuperEditor/SuperEditorLazy'))

export type TodoChecklistEditorOwnerState = {
  application: WebApplication
  generation: number
  noteUuid: string
  leaseId: string
  controller: NoteViewController
  /** A post-mutation persistence failure owns potentially unsent authoritative state. */
  retainOnFailure?: boolean
}

type OwnerRegistryEntry = {
  owner?: TodoChecklistEditorOwnerState
  releasing?: Promise<boolean>
  releaseToken?: object
  listeners: Set<() => void>
}

const ownerRegistry = new WeakMap<WebApplication, OwnerRegistryEntry>()

function registryEntry(application: WebApplication): OwnerRegistryEntry {
  let entry = ownerRegistry.get(application)
  if (!entry) {
    entry = { listeners: new Set() }
    ownerRegistry.set(application, entry)
  }
  return entry
}

function notifyOwnerRegistry(application: WebApplication): void {
  for (const listener of ownerRegistry.get(application)?.listeners ?? []) {
    listener()
  }
}

export function getTodoChecklistEditorOwner(application: WebApplication): TodoChecklistEditorOwnerState | undefined {
  return ownerRegistry.get(application)?.owner
}

export function publishTodoChecklistEditorOwner(owner: TodoChecklistEditorOwnerState): void {
  const entry = registryEntry(owner.application)
  if (entry.releasing) {
    throw new Error('The previous detached Todo editor owner is still being released.')
  }
  if (entry.owner && entry.owner !== owner) {
    throw new Error('A detached Todo editor owner is already active.')
  }
  entry.owner = owner
  notifyOwnerRegistry(owner.application)
}

export function clearTodoChecklistEditorOwner(
  application: WebApplication,
  expected: TodoChecklistEditorOwnerState,
): void {
  const entry = ownerRegistry.get(application)
  if (entry?.owner !== expected) {
    return
  }
  entry.owner = undefined
  notifyOwnerRegistry(application)
}

export function closeTodoChecklistEditorOwnerForSecurity(application: WebApplication): void {
  const entry = ownerRegistry.get(application)
  if (entry) {
    // Cancel the ordinary release generation. Its late continuation must never
    // close an owner created by a subsequent authenticated session.
    entry.releasing = undefined
    entry.releaseToken = undefined
  }
  const owner = getTodoChecklistEditorOwner(application)
  if (!owner) {
    return
  }
  // Unmount the provider first; the controller is then synchronously scrubbed.
  clearTodoChecklistEditorOwner(application, owner)
  application.itemControllerGroup.closeDetachedNoteControllerImmediately(owner.controller)
}

/**
 * Normal TodoView closure keeps the persistent host alive until any already
 * queued mutation has acknowledged local persistence and provider delivery.
 */
export function releaseTodoChecklistEditorOwnerAfter(
  application: WebApplication,
  queuedActions: Promise<unknown>,
): Promise<boolean> {
  const entry = registryEntry(application)
  if (entry.releasing) {
    return entry.releasing
  }
  const releaseToken = {}
  const release = performTodoChecklistEditorOwnerRelease(application, queuedActions, releaseToken)
  entry.releasing = release
  entry.releaseToken = releaseToken
  void release.finally(() => {
    if (entry.releasing === release && entry.releaseToken === releaseToken) {
      entry.releasing = undefined
      entry.releaseToken = undefined
      if (!entry.owner && entry.listeners.size === 0) {
        ownerRegistry.delete(application)
      }
    }
  })
  return release
}

export function waitForTodoChecklistEditorOwnerRelease(
  application: WebApplication,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<boolean> {
  const releasing = ownerRegistry.get(application)?.releasing
  if (!releasing) {
    return Promise.resolve(true)
  }
  if (options.timeoutMs <= 0 || options.signal?.aborted) {
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (released: boolean) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', handleAbort)
      resolve(released)
    }
    const handleAbort = () => finish(false)
    const timeout = setTimeout(() => finish(false), options.timeoutMs)
    options.signal?.addEventListener('abort', handleAbort, { once: true })
    void releasing.then(
      () => finish(true),
      () => finish(true),
    )
  })
}

async function performTodoChecklistEditorOwnerRelease(
  application: WebApplication,
  queuedActions: Promise<unknown>,
  releaseToken: object,
): Promise<boolean> {
  try {
    await queuedActions
  } catch {
    // The serial queue normally settles failures, but an unexpected rejection
    // must still proceed to the strict controller durability check below.
  }
  if (ownerRegistry.get(application)?.releaseToken !== releaseToken) {
    return true
  }
  const owner = getTodoChecklistEditorOwner(application)
  if (!owner) {
    return true
  }
  try {
    await application.itemControllerGroup.flushAndCloseDetachedNoteController(owner.controller)
    clearTodoChecklistEditorOwner(application, owner)
    return true
  } catch {
    owner.retainOnFailure = true
    return false
  }
}

function subscribeTodoChecklistEditorOwner(application: WebApplication, listener: () => void): () => void {
  const entry = registryEntry(application)
  entry.listeners.add(listener)
  return () => {
    entry.listeners.delete(listener)
    if (!entry.owner && !entry.releasing && entry.listeners.size === 0) {
      ownerRegistry.delete(application)
    }
  }
}

export function revalidateTodoChecklistEditorOwnerForSecurity(application: WebApplication): boolean {
  const owner = getTodoChecklistEditorOwner(application)
  if (!owner) {
    return true
  }
  const liveNote = application.items.findItem<SNNote>(owner.noteUuid)
  const exactOwnerIsCurrent =
    owner.application === application &&
    !owner.controller.dealloced &&
    owner.controller.item?.uuid === owner.noteUuid &&
    liveNote?.uuid === owner.noteUuid
  if (exactOwnerIsCurrent && canMutateSuperChecklistNote(application, liveNote)) {
    return true
  }
  application.itemControllerGroup.cancelChecklistEditorReservationsForSecurity()
  closeTodoChecklistEditorOwnerForSecurity(application)
  return false
}

/**
 * Observe every boundary that can revoke access to one retained detached note.
 * Callbacks re-read the authoritative item and synchronously scrub on denial;
 * stale controller state is never trusted as evidence of continued access.
 */
export function observeTodoChecklistEditorOwnerSecurity(application: WebApplication): () => void {
  const revalidate = () => revalidateTodoChecklistEditorOwnerForSecurity(application)
  const removeNoteObserver = application.items.streamItems<SNNote>(
    ContentType.TYPES.Note,
    ({ changed, inserted, removed }) => {
      const owner = getTodoChecklistEditorOwner(application)
      const affected = [...changed, ...inserted, ...removed]
      for (const candidate of affected) {
        const liveNote = application.items.findItem<SNNote>(candidate.uuid)
        if (!canMutateSuperChecklistNote(application, liveNote)) {
          application.itemControllerGroup.cancelChecklistEditorReservationsForSecurity(candidate.uuid)
        }
      }
      if (owner && affected.some((candidate) => candidate.uuid === owner.noteUuid)) {
        revalidate()
      }
    },
  )
  const removeIdentityObserver = application.items.streamItems(
    [ContentType.TYPES.KeySystemRootKey, ContentType.TYPES.VaultListing],
    () => {
      application.itemControllerGroup.cancelChecklistEditorReservationsForSecurity()
      revalidate()
    },
  )
  const removeVaultLockObserver = application.vaultLocks.addEventObserver((event) => {
    if (event === VaultLockServiceEvent.VaultLocked || event === VaultLockServiceEvent.VaultUnlocked) {
      application.itemControllerGroup.cancelChecklistEditorReservationsForSecurity()
      revalidate()
    }
  })
  const removeApplicationObserver = application.addEventObserver(async (event) => {
    if (
      event === ApplicationEvent.SignedIn ||
      event === ApplicationEvent.SignedOut ||
      event === ApplicationEvent.KeyStatusChanged ||
      event === ApplicationEvent.UnprotectedSessionBegan ||
      event === ApplicationEvent.UnprotectedSessionExpired ||
      event === ApplicationEvent.UserRolesChanged ||
      event === ApplicationEvent.FeaturesAvailabilityChanged
    ) {
      application.itemControllerGroup.cancelChecklistEditorReservationsForSecurity()
      closeTodoChecklistEditorOwnerForSecurity(application)
      return
    }
    if (
      event === ApplicationEvent.MajorDataChange ||
      event === ApplicationEvent.CompletedFullSync ||
      event === ApplicationEvent.LocalDataLoaded
    ) {
      revalidate()
    }
  })

  return () => {
    removeNoteObserver()
    removeIdentityObserver()
    removeVaultLockObserver()
    removeApplicationObserver()
  }
}

/**
 * A short-lived, exact-note Lexical/Yjs owner used only to execute Todo actions.
 * It intentionally mounts no NoteView chrome, attachments, global component
 * stacks, active tab, or item-list selection.
 */
export const TodoChecklistEditorOwner: FunctionComponent<{
  owner: TodoChecklistEditorOwnerState
}> = ({ owner }) => (
  <div hidden aria-hidden="true" data-srn-print-exclude="true" data-todo-checklist-owner={owner.noteUuid}>
    <Suspense fallback={null}>
      <SuperEditor
        application={owner.application}
        controller={owner.controller}
        linkingController={owner.application.linkingController}
        filesController={owner.application.filesController}
        spellcheck={false}
        checklistOwnerLeaseId={owner.leaseId}
        backgroundOwner
      />
    </Suspense>
  </div>
)

/** Persistent host above TodoView so a closing tab cannot tear down an in-flight flush. */
export const TodoChecklistEditorOwnerHost: FunctionComponent<{ application: WebApplication }> = ({ application }) => {
  const [owner, setOwner] = useState(() => getTodoChecklistEditorOwner(application))

  useEffect(() => {
    const refresh = () => setOwner(getTodoChecklistEditorOwner(application))
    refresh()
    const unsubscribe = subscribeTodoChecklistEditorOwner(application, refresh)
    const removeSecurityObservers = observeTodoChecklistEditorOwnerSecurity(application)
    return () => {
      unsubscribe()
      removeSecurityObservers()
      closeTodoChecklistEditorOwnerForSecurity(application)
    }
  }, [application])

  return owner?.application === application ? <TodoChecklistEditorOwner key={owner.leaseId} owner={owner} /> : null
}
