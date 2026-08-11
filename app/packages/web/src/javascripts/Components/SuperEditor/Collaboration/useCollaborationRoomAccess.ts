import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import {
  ApplicationEvent,
  ContentType,
  isLitePayload,
  SNNote,
  VaultLockServiceEvent,
  WebSocketsServiceEvent,
} from '@standardnotes/snjs'
import type { WebApplication } from '@/Application/WebApplication'
import {
  PreparedCollaborationAccess,
  prepareCollaborationAccess,
  resolveCollaborationKeySource,
} from './CollaborationKeyDerivation'
import {
  COLLABORATION_MAX_TRANSFER_BYTES,
  COLLABORATION_PROTOCOL_VERSION,
  createCollaborationRequestId,
} from './CollabChannel'
import { createGatewayCollabChannel } from './GatewayCollabChannel'
import { SUPER_COLLABORATION_TRANSPORT_REASON } from './CollaborationAvailability'

type LeaseFailure = { reason: string }

export type ActiveEditorCollaborationLease = {
  requestId: string
  shouldBootstrap: boolean
  protocolVersion: typeof COLLABORATION_PROTOCOL_VERSION
  maxTransferBytes: number
  release(): void
}

export type EditorCollaborationLease = ActiveEditorCollaborationLease & {
  /** Final synchronous durable-revision guard run before the provider can relay. */
  validateAttachment(): boolean
  /** True after the exact pre-attachment revision barrier has been consumed. */
  isAttached(): boolean
  /** Provider transport currently owns an established canonical Y.Doc. */
  setProviderCanonicalOwnership?(active: boolean): void
  /** Obtain and activate a fresh lease after the shared socket reconnects. */
  reactivate(): Promise<ActiveEditorCollaborationLease | LeaseFailure>
  /** Drop back to ordinary encrypted persistence after a fatal transport limit. */
  fail(reason: string): void
  /** Release this lease and repeat canonical reserve/activate for bootstrap failover. */
  retryBootstrap(): void
}

type AvailablePreparedRoomAccess = Extract<PreparedCollaborationAccess, { available: true }> & {
  editorLease?: EditorCollaborationLease
  /** Exact clean persisted body whose server revision was authorized. */
  initialEditorState?: string
}

type PreparedRoomAccess = Exclude<PreparedCollaborationAccess, { available: true }> | AvailablePreparedRoomAccess

type AvailableSynchronizedEditorAccess = AvailablePreparedRoomAccess & {
  noteUuid: string
  initialEditorState: string
}

type SynchronizedEditorAccess =
  Exclude<PreparedCollaborationAccess, { available: true }> | AvailableSynchronizedEditorAccess

export type CollaborationRoomAccessState =
  { status: 'disabled'; reason: string } | { status: 'preparing' } | ({ status: 'ready' } & AvailablePreparedRoomAccess)

const EDITOR_LEASE_TIMEOUT_MS = 10_000
const MAX_BOOTSTRAP_REVISION_ATTEMPTS = 3

type CanonicalEditorSnapshot = {
  noteUuid: string
  sourceId: string
  userUuid: string
  sessionUser: object
  serverUpdatedAtTimestamp: number
  initialEditorState: string
  invalidate(): void
}

function matchesCanonicalEditorSnapshot(
  application: WebApplication,
  snapshot: Omit<CanonicalEditorSnapshot, 'invalidate'>,
  candidate = application.items.findItem<SNNote>(snapshot.noteUuid),
): boolean {
  if (
    !candidate ||
    isLitePayload(candidate.payload) ||
    candidate.dirty === true ||
    candidate.serverUpdatedAtTimestamp !== snapshot.serverUpdatedAtTimestamp ||
    candidate.text !== snapshot.initialEditorState
  ) {
    return false
  }
  const source = resolveCollaborationKeySource(application, candidate)
  return (
    candidate.uuid === snapshot.noteUuid &&
    source.available &&
    source.noteUuid === snapshot.noteUuid &&
    source.sourceId === snapshot.sourceId &&
    source.userUuid === snapshot.userUuid &&
    source.sessionUser === snapshot.sessionUser
  )
}

type CollaborationAuthorizationContext = {
  leaseRequestId?: string
  bootstrapChallenge?: string
}

/**
 * Establish a freshness barrier before an editor lease can become authoritative.
 * Authorization returns the server's canonical encrypted-item revision; after
 * an ordinary awaited encrypted sync, the live item must be clean and match it
 * exactly. A revision race retries only after that completed sync.
 */
export async function prepareSynchronizedEditorAccess(
  application: WebApplication,
  initialNote: SNNote,
  authorizationContext?: CollaborationAuthorizationContext,
): Promise<SynchronizedEditorAccess> {
  if (isLitePayload(initialNote.payload)) {
    return {
      available: false,
      reason: 'Live collaboration is waiting for the full encrypted note body to load.',
    }
  }
  let candidate = initialNote
  for (let attempt = 0; attempt < MAX_BOOTSTRAP_REVISION_ATTEMPTS; attempt += 1) {
    const result = await prepareCollaborationAccess(application, candidate, authorizationContext)
    if (!result.available) {
      return result
    }
    if (result.noteUuid !== initialNote.uuid) {
      return {
        available: false,
        sourceId: result.sourceId,
        reason: 'The note changed while collaboration was synchronizing.',
      }
    }
    await application.sync.sync({
      awaitAll: true,
      sourceDescription: 'Confirming the canonical encrypted note revision before live collaboration',
    })
    const current = application.items.findItem<SNNote>(initialNote.uuid)
    if (!current || isLitePayload(current.payload)) {
      return {
        available: false,
        sourceId: result.sourceId,
        reason: current
          ? 'Live collaboration is waiting for the full encrypted note body to load.'
          : 'Live collaboration stopped because the note no longer exists after sync.',
      }
    }

    const currentSource = resolveCollaborationKeySource(application, current)
    if (
      !currentSource.available ||
      current.uuid !== initialNote.uuid ||
      currentSource.noteUuid !== initialNote.uuid ||
      currentSource.sourceId !== result.sourceId ||
      currentSource.userUuid !== result.userUuid ||
      currentSource.sessionUser !== result.sessionUser
    ) {
      return {
        available: false,
        sourceId: result.sourceId,
        reason: currentSource.available
          ? 'The note encryption key changed while collaboration was synchronizing.'
          : currentSource.reason,
      }
    }

    if (current.dirty !== true && current.serverUpdatedAtTimestamp === result.serverUpdatedAtTimestamp) {
      return {
        ...result,
        noteUuid: current.uuid,
        initialEditorState: current.text,
      }
    }

    candidate = current
  }

  return {
    available: false,
    reason: 'Live collaboration could not confirm a clean current server revision. Sync and retry.',
  }
}

type EditorLeaseReservation = {
  requestId: string
  shouldBootstrap: boolean
  bootstrapChallenge?: string
  protocolVersion: typeof COLLABORATION_PROTOCOL_VERSION
  maxTransferBytes: number
}

/**
 * Reserve, then activate, one request-bound editor lease on the existing socket.
 * A reservation is deliberately not a room member and cannot relay content.
 * The returned active lease is already acknowledged by the gateway; the Lexical
 * provider must attach to it and must not replay `room-join`.
 */
export function beginEditorLeaseReservation(
  application: WebApplication,
  room: string,
  capability: string,
  timeoutMs = EDITOR_LEASE_TIMEOUT_MS,
  requestId = createCollaborationRequestId(),
): {
  requestId: string
  promise: Promise<EditorLeaseReservation | LeaseFailure>
  activate(capability: string): Promise<ActiveEditorCollaborationLease | LeaseFailure>
  cancel(): void
} {
  const channel = createGatewayCollabChannel(application)
  let phase: 'reserving' | 'reserved' | 'activating' | 'active' | 'failed' | 'released' = 'reserving'
  let leaveSent = false
  let reserveSent = false
  let activationSent = false
  let reservation: EditorLeaseReservation | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let unsubscribe: (() => void) | undefined
  let resolveReservation!: (value: EditorLeaseReservation | LeaseFailure) => void
  let resolveActivation: ((value: ActiveEditorCollaborationLease | LeaseFailure) => void) | undefined
  const promise = new Promise<EditorLeaseReservation | LeaseFailure>((resolve) => {
    resolveReservation = resolve
  })

  const clearPhaseTimeout = (): void => {
    if (timeout !== undefined) {
      clearTimeout(timeout)
      timeout = undefined
    }
  }
  const cleanupListener = (): void => {
    clearPhaseTimeout()
    try {
      unsubscribe?.()
    } catch {
      // Listener cleanup cannot weaken the request-bound gateway lease.
    }
    unsubscribe = undefined
  }
  const release = (): void => {
    if (leaveSent) {
      return
    }
    leaveSent = true
    try {
      channel.send({ t: 'room-leave', room, requestId })
    } catch {
      // Socket cleanup is best-effort; connection cleanup/lease expiry backstop it.
    }
  }
  const fail = (reason: string): void => {
    if (phase === 'failed' || phase === 'released') {
      return
    }
    const previousPhase = phase
    phase = 'failed'
    cleanupListener()
    release()
    const failure = { reason }
    if (previousPhase === 'reserving') {
      resolveReservation(failure)
    }
    resolveActivation?.(failure)
  }
  const armTimeout = (reason: string): void => {
    clearPhaseTimeout()
    timeout = setTimeout(() => fail(reason), timeoutMs)
  }

  unsubscribe = channel.subscribe((frame) => {
    if (frame.room !== room || !('requestId' in frame) || frame.requestId !== requestId) {
      return
    }
    if (frame.t === 'room-denied') {
      fail('The server did not authorize an editor lease for this note.')
      return
    }
    if (frame.t === 'room-reserved' && phase === 'reserving' && reserveSent) {
      const challengeIsValid = frame.bootstrap
        ? typeof frame.bootstrapChallenge === 'string' && frame.bootstrapChallenge.length > 0
        : frame.bootstrapChallenge === undefined
      if (
        frame.protocolVersion !== COLLABORATION_PROTOCOL_VERSION ||
        frame.maxTransferBytes !== COLLABORATION_MAX_TRANSFER_BYTES ||
        !challengeIsValid
      ) {
        fail('The collaboration gateway protocol is incompatible with this app.')
        return
      }
      clearPhaseTimeout()
      phase = 'reserved'
      reservation = {
        requestId,
        shouldBootstrap: frame.bootstrap,
        ...(frame.bootstrapChallenge ? { bootstrapChallenge: frame.bootstrapChallenge } : {}),
        protocolVersion: frame.protocolVersion,
        maxTransferBytes: frame.maxTransferBytes,
      }
      resolveReservation(reservation)
      return
    }
    if (frame.t === 'room-joined' && phase === 'activating' && activationSent) {
      if (
        !reservation ||
        frame.protocolVersion !== COLLABORATION_PROTOCOL_VERSION ||
        frame.maxTransferBytes !== COLLABORATION_MAX_TRANSFER_BYTES ||
        frame.bootstrap !== reservation.shouldBootstrap
      ) {
        fail('The collaboration gateway activation did not match its reservation.')
        return
      }
      clearPhaseTimeout()
      phase = 'active'
      cleanupListener()
      resolveActivation?.({
        requestId,
        shouldBootstrap: reservation.shouldBootstrap,
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        maxTransferBytes: COLLABORATION_MAX_TRANSFER_BYTES,
        release,
      })
    }
  })

  armTimeout('The encrypted collaboration room did not acknowledge the editor reservation.')
  try {
    reserveSent = true
    channel.send({
      t: 'room-reserve',
      room,
      cap: capability,
      requestId,
      role: 'editor',
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
    })
  } catch {
    fail('The encrypted collaboration room could not reserve an editor lease.')
  }

  return {
    requestId,
    promise,
    activate: (activationCapability: string) => {
      if (phase !== 'reserved') {
        return Promise.resolve({ reason: 'The editor reservation is not available for activation.' })
      }
      phase = 'activating'
      const activation = new Promise<ActiveEditorCollaborationLease | LeaseFailure>((resolve) => {
        resolveActivation = resolve
      })
      armTimeout('The encrypted collaboration room did not acknowledge editor activation.')
      try {
        activationSent = true
        channel.send({
          t: 'room-join',
          room,
          cap: activationCapability,
          requestId,
          role: 'editor',
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        })
      } catch {
        fail('The encrypted collaboration room could not activate the editor lease.')
      }
      return activation
    },
    cancel: () => {
      const wasActive = phase === 'active'
      cleanupListener()
      release()
      if (!wasActive) {
        fail('The editor lease was cancelled.')
      } else {
        phase = 'released'
      }
    },
  }
}

type EstablishedEditorAccess = {
  access: AvailableSynchronizedEditorAccess
  lease: ActiveEditorCollaborationLease
}

type ExpectedEditorIdentity = Pick<
  AvailableSynchronizedEditorAccess,
  'noteUuid' | 'sourceId' | 'userUuid' | 'sessionUser'
>

function matchesExpectedEditorIdentity(
  access: Extract<PreparedRoomAccess, { available: true }>,
  noteUuid: string,
  expected: ExpectedEditorIdentity,
): boolean {
  return (
    noteUuid === expected.noteUuid &&
    access.sourceId === expected.sourceId &&
    access.userUuid === expected.userUuid &&
    access.sessionUser === expected.sessionUser
  )
}

async function establishEditorAccess(
  application: WebApplication,
  initialNote: SNNote,
  expectedIdentity?: ExpectedEditorIdentity,
): Promise<EstablishedEditorAccess | LeaseFailure> {
  for (let attempt = 0; attempt < MAX_BOOTSTRAP_REVISION_ATTEMPTS; attempt += 1) {
    const requestId = createCollaborationRequestId()
    const beforeReservation = await prepareSynchronizedEditorAccess(application, initialNote, {
      leaseRequestId: requestId,
    })
    if (!beforeReservation.available) {
      return { reason: beforeReservation.reason }
    }
    if (
      expectedIdentity &&
      !matchesExpectedEditorIdentity(beforeReservation, beforeReservation.noteUuid, expectedIdentity)
    ) {
      return { reason: 'The signed-in session or note encryption key changed while collaboration was reconnecting.' }
    }

    const transaction = beginEditorLeaseReservation(
      application,
      initialNote.uuid,
      beforeReservation.capability,
      EDITOR_LEASE_TIMEOUT_MS,
      requestId,
    )
    const reservation = await transaction.promise
    if ('reason' in reservation) {
      return reservation
    }

    const liveAfterReservation = application.items.findItem<SNNote>(initialNote.uuid)
    if (!liveAfterReservation) {
      transaction.cancel()
      return { reason: 'Live collaboration stopped because the note no longer exists.' }
    }

    // This challenge-bound authorization and full sync happen while the unique
    // Redis reservation is held. It is the bootstrap election linearization
    // point: no elected client can seed from a pre-election revision.
    const activationAccess = await prepareSynchronizedEditorAccess(application, liveAfterReservation, {
      leaseRequestId: requestId,
      bootstrapChallenge: reservation.bootstrapChallenge,
    })
    if (
      !activationAccess.available ||
      !matchesExpectedEditorIdentity(activationAccess, activationAccess.noteUuid, beforeReservation)
    ) {
      transaction.cancel()
      return {
        reason: activationAccess.available
          ? 'The note encryption key changed before collaboration activation.'
          : activationAccess.reason,
      }
    }

    const lease = await transaction.activate(activationAccess.capability)
    if ('reason' in lease) {
      return lease
    }

    // The gateway activation is acknowledged before Lexical mounts. Re-run the
    // exact revision barrier while the active lease is silent; if a durable R+1
    // landed during activation, release and retry instead of seeding stale text.
    const liveAfterAck = application.items.findItem<SNNote>(initialNote.uuid)
    if (!liveAfterAck) {
      lease.release()
      return { reason: 'Live collaboration stopped because the note no longer exists.' }
    }
    const postAckAccess = await prepareSynchronizedEditorAccess(application, liveAfterAck, {
      leaseRequestId: requestId,
      bootstrapChallenge: reservation.bootstrapChallenge,
    })
    if (
      !postAckAccess.available ||
      !matchesExpectedEditorIdentity(postAckAccess, postAckAccess.noteUuid, activationAccess)
    ) {
      lease.release()
      return {
        reason: postAckAccess.available
          ? 'The note encryption key changed after collaboration activation.'
          : postAckAccess.reason,
      }
    }
    if (postAckAccess.serverUpdatedAtTimestamp !== activationAccess.serverUpdatedAtTimestamp) {
      lease.release()
      continue
    }

    return { access: postAckAccess, lease }
  }

  return { reason: 'Live collaboration could not establish a stable current revision. Sync and retry.' }
}

export function useCollaborationRoomAccess(
  application: WebApplication,
  note: SNNote,
  electEditorBootstrap = false,
): CollaborationRoomAccessState {
  const committedNote = useRef<{ noteUuid: string; note: SNNote }>({ noteUuid: note.uuid, note })
  const [revision, refresh] = useReducer((value: number) => value + 1, 0)
  const [preparationRetryRevision, retryPreparation] = useReducer((value: number) => value + 1, 0)
  const hasReadyAccess = useRef(false)
  const activePreparations = useRef(0)
  const canonicalEditorSnapshot = useRef<CanonicalEditorSnapshot | undefined>(undefined)

  useLayoutEffect(() => {
    committedNote.current = { noteUuid: note.uuid, note }
  }, [note])

  useEffect(() => {
    const invalidateActiveLease = (): void => {
      canonicalEditorSnapshot.current?.invalidate()
    }
    const disposeItems = application.items.streamItems(
      [ContentType.TYPES.KeySystemRootKey, ContentType.TYPES.VaultListing],
      () => {
        invalidateActiveLease()
        refresh()
      },
    )
    const disposeVaultLocks = application.vaultLocks.addEventObserver((event) => {
      if (event === VaultLockServiceEvent.VaultLocked || event === VaultLockServiceEvent.VaultUnlocked) {
        invalidateActiveLease()
        refresh()
      }
      return Promise.resolve()
    })
    const disposeSocket = application.sockets.addEventObserver((event) => {
      // A mounted provider retains its Y.Doc and performs a fresh authenticated
      // reserve/activate handshake itself. Only a pre-mount preparation retries.
      if (event === WebSocketsServiceEvent.WebSocketDidOpen && !hasReadyAccess.current) {
        retryPreparation()
      }
      return Promise.resolve()
    })
    const disposeApplication = application.addEventObserver((event) => {
      if (event === ApplicationEvent.CompletedFullSync) {
        refresh()
        if (!hasReadyAccess.current && activePreparations.current === 0) {
          retryPreparation()
        }
        return Promise.resolve()
      }
      if (
        event === ApplicationEvent.SignedIn ||
        event === ApplicationEvent.SignedOut ||
        event === ApplicationEvent.KeyStatusChanged ||
        event === ApplicationEvent.MajorDataChange ||
        event === ApplicationEvent.UnprotectedSessionBegan ||
        event === ApplicationEvent.UnprotectedSessionExpired
      ) {
        invalidateActiveLease()
        refresh()
      }
      return Promise.resolve()
    })

    return () => {
      disposeItems()
      disposeVaultLocks()
      disposeSocket()
      disposeApplication()
    }
  }, [application])

  void revision
  const source = resolveCollaborationKeySource(application, note)
  const noteUuid = note.uuid
  const sourceId = source.available ? source.sourceId : `disabled:${source.reason}`
  const sourceUserUuid = source.available ? source.userUuid : undefined
  const sourceSessionUser = source.available ? source.sessionUser : undefined
  const sourceUnavailableReason = source.available ? undefined : source.reason
  const [prepared, setPrepared] = useState<{
    noteUuid: string
    sourceId: string
    userUuid?: string
    sessionUser?: object
    result?: PreparedRoomAccess
  }>(() => ({ noteUuid, sourceId, userUuid: sourceUserUuid, sessionUser: sourceSessionUser }))
  const preparedMatchesSource =
    prepared.noteUuid === noteUuid &&
    prepared.sourceId === sourceId &&
    prepared.userUuid === sourceUserUuid &&
    prepared.sessionUser === sourceSessionUser
  const readyAccessIsCommitted = preparedMatchesSource && prepared.result !== undefined && prepared.result.available

  useLayoutEffect(() => {
    hasReadyAccess.current = readyAccessIsCommitted
  }, [readyAccessIsCommitted])

  useEffect(() => {
    let cancelled = false
    canonicalEditorSnapshot.current = undefined
    const liveLeases = new Set<ActiveEditorCollaborationLease>()
    const trackLease = (lease: ActiveEditorCollaborationLease): ActiveEditorCollaborationLease => {
      let released = false
      const trackedLease: ActiveEditorCollaborationLease = {
        ...lease,
        release: () => {
          if (released) {
            return
          }
          released = true
          liveLeases.delete(trackedLease)
          lease.release()
        },
      }
      liveLeases.add(trackedLease)
      return trackedLease
    }
    const preparedIdentity = {
      noteUuid,
      sourceId,
      userUuid: sourceUserUuid,
      sessionUser: sourceSessionUser,
    }
    setPrepared(preparedIdentity)

    if (sourceUnavailableReason) {
      setPrepared({ ...preparedIdentity, result: { available: false, reason: sourceUnavailableReason } })
      return
    }
    if (application.sockets.isWebSocketConnectionOpen?.() === false) {
      setPrepared({
        ...preparedIdentity,
        result: { available: false, reason: SUPER_COLLABORATION_TRANSPORT_REASON, sourceId },
      })
      return
    }

    const startPreparation = (): void => {
      if (cancelled) {
        return
      }
      const committed = committedNote.current
      if (committed.noteUuid !== noteUuid) {
        return
      }
      const activeNote = committed.note
      activePreparations.current += 1
      const preparation = electEditorBootstrap
        ? establishEditorAccess(application, activeNote, {
            noteUuid,
            sourceId,
            userUuid: sourceUserUuid!,
            sessionUser: sourceSessionUser!,
          }).then((result) => ({ editor: true as const, result }))
        : prepareCollaborationAccess(application, activeNote).then((result) => ({ editor: false as const, result }))
      void preparation
        .then((preparedResult): void => {
          if (cancelled) {
            if (preparedResult.editor && 'lease' in preparedResult.result) {
              preparedResult.result.lease.release()
            }
            return
          }
          const current = committedNote.current
          if (current.noteUuid !== noteUuid) {
            if (preparedResult.editor && 'lease' in preparedResult.result) {
              preparedResult.result.lease.release()
            }
            return
          }
          const currentNote = current.note
          const currentSource = resolveCollaborationKeySource(application, currentNote)
          if (
            currentNote.uuid !== noteUuid ||
            !currentSource.available ||
            currentSource.noteUuid !== noteUuid ||
            currentSource.sourceId !== sourceId ||
            currentSource.userUuid !== sourceUserUuid ||
            currentSource.sessionUser !== sourceSessionUser
          ) {
            if (preparedResult.editor && 'lease' in preparedResult.result) {
              preparedResult.result.lease.release()
            }
            retryPreparation()
            return
          }
          if (!preparedResult.editor) {
            if (
              preparedResult.result.available &&
              !matchesExpectedEditorIdentity(preparedResult.result, noteUuid, {
                noteUuid,
                sourceId,
                userUuid: sourceUserUuid!,
                sessionUser: sourceSessionUser!,
              })
            ) {
              retryPreparation()
              return
            }
            setPrepared({ ...preparedIdentity, result: preparedResult.result })
            return
          }
          const { result } = preparedResult
          if ('reason' in result) {
            setPrepared({
              ...preparedIdentity,
              result: { available: false, sourceId, reason: result.reason },
            })
            return
          }

          if (
            typeof result.access.initialEditorState !== 'string' ||
            !matchesCanonicalEditorSnapshot(application, {
              noteUuid,
              sourceId,
              userUuid: result.access.userUuid,
              sessionUser: result.access.sessionUser,
              serverUpdatedAtTimestamp: result.access.serverUpdatedAtTimestamp,
              initialEditorState: result.access.initialEditorState,
            })
          ) {
            result.lease.release()
            retryPreparation()
            return
          }

          const initialLease = trackLease(result.lease)
          let invalidated = false
          let attached = false
          let providerOwnsCanonicalState = false
          const snapshot: CanonicalEditorSnapshot = {
            noteUuid,
            sourceId,
            userUuid: result.access.userUuid,
            sessionUser: result.access.sessionUser,
            serverUpdatedAtTimestamp: result.access.serverUpdatedAtTimestamp,
            initialEditorState: result.access.initialEditorState,
            invalidate: () => {
              if (cancelled || invalidated) {
                return
              }
              invalidated = true
              providerOwnsCanonicalState = false
              if (canonicalEditorSnapshot.current === snapshot) {
                canonicalEditorSnapshot.current = undefined
              }
              for (const lease of liveLeases) {
                lease.release()
              }
              setPrepared(preparedIdentity)
              retryPreparation()
            },
          }
          canonicalEditorSnapshot.current = snapshot
          const editorLease: EditorCollaborationLease = {
            ...initialLease,
            validateAttachment: () => {
              const current = application.items.findItem<SNNote>(noteUuid)
              const currentSource = current ? resolveCollaborationKeySource(application, current) : undefined
              const sourceStillValid =
                currentSource?.available === true &&
                current?.uuid === noteUuid &&
                currentSource.noteUuid === noteUuid &&
                currentSource.sourceId === sourceId &&
                currentSource.userUuid === snapshot.userUuid &&
                currentSource.sessionUser === snapshot.sessionUser
              const valid =
                !cancelled &&
                !invalidated &&
                canonicalEditorSnapshot.current === snapshot &&
                sourceStillValid &&
                (attached || matchesCanonicalEditorSnapshot(application, snapshot, current))
              if (!valid) {
                snapshot.invalidate()
              } else {
                attached = true
              }
              return valid
            },
            isAttached: () => attached && providerOwnsCanonicalState && !cancelled && !invalidated,
            setProviderCanonicalOwnership: (active: boolean) => {
              providerOwnsCanonicalState = active && attached && !cancelled && !invalidated
            },
            reactivate: async () => {
              const current = application.items.findItem<SNNote>(noteUuid)
              if (!current) {
                return { reason: 'Live collaboration stopped because the note no longer exists.' }
              }
              const reactivated = await establishEditorAccess(application, current, snapshot)
              if ('reason' in reactivated) {
                return reactivated
              }
              if (cancelled) {
                reactivated.lease.release()
                return { reason: 'The editor lease was cancelled.' }
              }
              return trackLease(reactivated.lease)
            },
            fail: (reason: string) => {
              if (cancelled) {
                return
              }
              providerOwnsCanonicalState = false
              for (const lease of liveLeases) {
                lease.release()
              }
              if (canonicalEditorSnapshot.current === snapshot) {
                canonicalEditorSnapshot.current = undefined
              }
              setPrepared({
                ...preparedIdentity,
                result: { available: false, sourceId, reason },
              })
            },
            retryBootstrap: () => {
              snapshot.invalidate()
            },
          }
          setPrepared({ ...preparedIdentity, result: { ...result.access, editorLease } })
        })
        .catch(() => {
          if (!cancelled) {
            setPrepared({
              ...preparedIdentity,
              result: { available: false, sourceId, reason: 'Live collaboration could not establish a secure room.' },
            })
          }
        })
        .finally(() => {
          activePreparations.current = Math.max(0, activePreparations.current - 1)
        })
    }
    // React StrictMode performs setup -> cleanup -> setup in one turn. Deferring
    // the distributed reservation by one microtask lets the abandoned setup
    // cancel before it can win the one-bootstrap election.
    queueMicrotask(startPreparation)

    return () => {
      cancelled = true
      const snapshot = canonicalEditorSnapshot.current
      if (snapshot?.noteUuid === noteUuid && snapshot.sourceId === sourceId) {
        canonicalEditorSnapshot.current = undefined
      }
      for (const lease of liveLeases) {
        lease.release()
      }
    }
  }, [
    application,
    electEditorBootstrap,
    noteUuid,
    preparationRetryRevision,
    sourceId,
    sourceSessionUser,
    sourceUnavailableReason,
    sourceUserUuid,
  ])

  if (!preparedMatchesSource || !prepared.result) {
    return source.available ? { status: 'preparing' } : { status: 'disabled', reason: source.reason }
  }
  if (!prepared.result.available) {
    return { status: 'disabled', reason: prepared.result.reason }
  }

  return { status: 'ready', ...prepared.result }
}
