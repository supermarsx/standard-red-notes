import type { WebApplication } from '@/Application/WebApplication'
import type { NoteViewController } from '../NoteView/Controller/NoteViewController'
import {
  ApplicationEvent,
  ContentType,
  FeatureStatus,
  NoteType,
  SNNote,
  VaultLockServiceEvent,
} from '@standardnotes/snjs'
import {
  closeTodoChecklistEditorOwnerForSecurity,
  getTodoChecklistEditorOwner,
  observeTodoChecklistEditorOwnerSecurity,
  publishTodoChecklistEditorOwner,
  releaseTodoChecklistEditorOwnerAfter,
  TodoChecklistEditorOwnerState,
  waitForTodoChecklistEditorOwnerRelease,
} from './TodoChecklistEditorOwner'

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  return {
    promise: new Promise<void>((done) => {
      resolve = done
    }),
    resolve: () => resolve(),
  }
}

function fixture() {
  const controller = {} as NoteViewController
  const flushAndCloseDetachedNoteController = jest.fn().mockResolvedValue(undefined)
  const closeDetachedNoteControllerImmediately = jest.fn()
  const application = {
    itemControllerGroup: {
      flushAndCloseDetachedNoteController,
      closeDetachedNoteControllerImmediately,
      cancelChecklistEditorReservationsForSecurity: jest.fn(),
    },
  } as unknown as WebApplication
  const owner: TodoChecklistEditorOwnerState = {
    application,
    generation: 1,
    noteUuid: 'note-a',
    leaseId: 'lease-a',
    controller,
  }
  publishTodoChecklistEditorOwner(owner)
  return {
    application,
    owner,
    controller,
    flushAndCloseDetachedNoteController,
    closeDetachedNoteControllerImmediately,
  }
}

describe('persistent detached Todo owner lifecycle', () => {
  it('keeps the owner mounted while a close races a delayed mutation flush', async () => {
    const { application, owner, controller, flushAndCloseDetachedNoteController } = fixture()
    const mutationFlush = deferred()
    const release = releaseTodoChecklistEditorOwnerAfter(application, mutationFlush.promise)

    await Promise.resolve()
    expect(getTodoChecklistEditorOwner(application)).toBe(owner)
    expect(flushAndCloseDetachedNoteController).not.toHaveBeenCalled()

    mutationFlush.resolve()
    await expect(release).resolves.toBe(true)
    expect(flushAndCloseDetachedNoteController).toHaveBeenCalledWith(controller)
    expect(getTodoChecklistEditorOwner(application)).toBeUndefined()
  })

  it('blocks a reopened view from adopting an owner while stale cleanup releases it', async () => {
    const { application } = fixture()
    const mutationFlush = deferred()
    const release = releaseTodoChecklistEditorOwnerAfter(application, mutationFlush.promise)

    let reopened = false
    const reopen = waitForTodoChecklistEditorOwnerRelease(application, { timeoutMs: 1_000 }).then(() => {
      reopened = true
    })
    await Promise.resolve()
    expect(reopened).toBe(false)

    mutationFlush.resolve()
    await release
    await reopen
    expect(reopened).toBe(true)
    expect(getTodoChecklistEditorOwner(application)).toBeUndefined()
  })

  it('retains the exact host when strict local/provider durability fails', async () => {
    const { application, owner, flushAndCloseDetachedNoteController } = fixture()
    flushAndCloseDetachedNoteController.mockRejectedValueOnce(new Error('provider disconnected'))

    await expect(releaseTodoChecklistEditorOwnerAfter(application, Promise.resolve())).resolves.toBe(false)
    expect(getTodoChecklistEditorOwner(application)).toBe(owner)
    expect(owner.retainOnFailure).toBe(true)
  })

  it('security loss unmounts the host and scrubs immediately without waiting', () => {
    const { application, owner, controller, closeDetachedNoteControllerImmediately } = fixture()

    closeTodoChecklistEditorOwnerForSecurity(application)

    expect(getTodoChecklistEditorOwner(application)).toBeUndefined()
    expect(closeDetachedNoteControllerImmediately).toHaveBeenCalledWith(controller)
    expect(owner.retainOnFailure).toBeUndefined()
  })

  it('prevents a canceled stale release from closing a new authenticated owner', async () => {
    const first = fixture()
    const queued = deferred()
    const staleRelease = releaseTodoChecklistEditorOwnerAfter(first.application, queued.promise)
    closeTodoChecklistEditorOwnerForSecurity(first.application)

    const nextController = {} as NoteViewController
    const nextOwner: TodoChecklistEditorOwnerState = {
      ...first.owner,
      leaseId: 'lease-next-session',
      controller: nextController,
    }
    publishTodoChecklistEditorOwner(nextOwner)
    queued.resolve()
    await staleRelease

    expect(getTodoChecklistEditorOwner(first.application)).toBe(nextOwner)
    expect(first.flushAndCloseDetachedNoteController).not.toHaveBeenCalledWith(nextController)
    closeTodoChecklistEditorOwnerForSecurity(first.application)
  })

  function securityObserverFixture() {
    const base = fixture()
    let currentNote: SNNote | undefined = {
      uuid: base.owner.noteUuid,
      noteType: NoteType.Super,
      trashed: false,
      locked: false,
      payload: { content: {} },
    } as SNNote
    let authorized = true
    let vaultReadonly = false
    let noteObserver!: (change: { changed: SNNote[]; inserted: SNNote[]; removed: SNNote[] }) => void
    let identityObserver!: (change: { changed: unknown[]; inserted: unknown[]; removed: unknown[] }) => void
    let vaultObserver!: (event: VaultLockServiceEvent) => void
    let applicationObserver!: (event: ApplicationEvent) => Promise<void>
    const removeNote = jest.fn()
    const removeIdentity = jest.fn()
    const removeVault = jest.fn()
    const removeApplication = jest.fn()
    const controller = base.controller as NoteViewController
    controller.item = currentNote
    controller.dealloced = false
    base.owner.retainOnFailure = true

    Object.assign(base.application, {
      items: {
        findItem: () => currentNote,
        streamItems: jest.fn((types: string | string[], observer: unknown) => {
          const values = Array.isArray(types) ? types : [types]
          if (values.includes(ContentType.TYPES.Note)) {
            noteObserver = observer as typeof noteObserver
            return removeNote
          }
          identityObserver = observer as typeof identityObserver
          return removeIdentity
        }),
      },
      isAuthorizedToRenderItem: () => authorized,
      sessions: { isCurrentSessionReadOnly: () => false },
      vaults: { getItemVault: () => (vaultReadonly ? { isSharedVaultListing: () => true } : undefined) },
      vaultUsers: { isCurrentUserReadonlyVaultMember: () => vaultReadonly },
      features: { getFeatureStatus: () => FeatureStatus.Entitled },
      vaultLocks: {
        addEventObserver: (observer: typeof vaultObserver) => {
          vaultObserver = observer
          return removeVault
        },
      },
      addEventObserver: (observer: typeof applicationObserver) => {
        applicationObserver = observer
        return removeApplication
      },
    })

    const dispose = observeTodoChecklistEditorOwnerSecurity(base.application)
    return {
      ...base,
      dispose,
      note: () => currentNote,
      setNote: (note: SNNote | undefined) => {
        currentNote = note
      },
      setAuthorized: (value: boolean) => {
        authorized = value
      },
      setVaultReadonly: (value: boolean) => {
        vaultReadonly = value
      },
      noteObserver: (change: { changed: SNNote[]; inserted: SNNote[]; removed: SNNote[] }) => noteObserver(change),
      identityObserver: () => identityObserver({ changed: [{}], inserted: [], removed: [] }),
      vaultObserver: (event: VaultLockServiceEvent) => vaultObserver(event),
      applicationObserver: (event: ApplicationEvent) => applicationObserver(event),
      removers: [removeNote, removeIdentity, removeVault, removeApplication],
    }
  }

  it('synchronously scrubs a retained owner when its vault locks', () => {
    const state = securityObserverFixture()
    state.setAuthorized(false)

    state.vaultObserver(VaultLockServiceEvent.VaultLocked)

    expect(getTodoChecklistEditorOwner(state.application)).toBeUndefined()
    expect(state.closeDetachedNoteControllerImmediately).toHaveBeenCalledWith(state.controller)
  })

  it('scrubs on shared-vault membership/listing revocation and MajorDataChange', async () => {
    const membership = securityObserverFixture()
    membership.setVaultReadonly(true)
    membership.identityObserver()
    expect(getTodoChecklistEditorOwner(membership.application)).toBeUndefined()

    const major = securityObserverFixture()
    major.setAuthorized(false)
    await major.applicationObserver(ApplicationEvent.MajorDataChange)
    expect(getTodoChecklistEditorOwner(major.application)).toBeUndefined()
  })

  it.each(['deleted', 'locked', 'lite', 'unauthorized'] as const)(
    'scrubs on an exact note %s transition',
    (transition) => {
      const state = securityObserverFixture()
      const previous = state.note() as SNNote
      if (transition === 'deleted') {
        state.setNote(undefined)
        state.noteObserver({ changed: [], inserted: [], removed: [previous] })
      } else {
        const changed = {
          ...previous,
          locked: transition === 'locked',
          payload: transition === 'lite' ? { content: { __lazyLite: true } } : previous.payload,
        } as SNNote
        state.setNote(changed)
        if (transition === 'unauthorized') {
          state.setAuthorized(false)
        }
        state.noteObserver({ changed: [changed], inserted: [], removed: [] })
      }
      expect(getTodoChecklistEditorOwner(state.application)).toBeUndefined()
      expect(state.closeDetachedNoteControllerImmediately).toHaveBeenCalledWith(state.controller)
    },
  )

  it('unsubscribes every note, identity, vault-lock and application observer', () => {
    const state = securityObserverFixture()
    state.dispose()
    for (const remove of state.removers) {
      expect(remove).toHaveBeenCalledTimes(1)
    }
    closeTodoChecklistEditorOwnerForSecurity(state.application)
  })
})
