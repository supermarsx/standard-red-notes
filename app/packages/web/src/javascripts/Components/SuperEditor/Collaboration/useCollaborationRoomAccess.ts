import { useEffect, useReducer, useRef, useState } from 'react'
import {
  ApplicationEvent,
  ContentType,
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
import { createCollaborationRequestId } from './CollabChannel'
import { createGatewayCollabChannel } from './GatewayCollabChannel'
import { SUPER_COLLABORATION_TRANSPORT_REASON } from './CollaborationAvailability'

export type EditorCollaborationLease = {
  requestId: string
  shouldBootstrap: boolean
}

type AvailablePreparedRoomAccess = Extract<PreparedCollaborationAccess, { available: true }> & {
  editorLease?: EditorCollaborationLease
}

type PreparedRoomAccess = Exclude<PreparedCollaborationAccess, { available: true }> | AvailablePreparedRoomAccess

export type CollaborationRoomAccessState =
  | { status: 'disabled'; reason: string }
  | { status: 'preparing' }
  | ({ status: 'ready' } & Omit<AvailablePreparedRoomAccess, 'sourceId'>)

const EDITOR_LEASE_TIMEOUT_MS = 10_000

export function beginEditorLeaseReservation(
  application: WebApplication,
  room: string,
  capability: string,
  timeoutMs = EDITOR_LEASE_TIMEOUT_MS,
): {
  promise: Promise<EditorCollaborationLease | { reason: string }>
  cancel(): void
} {
  const channel = createGatewayCollabChannel(application)
  const requestId = createCollaborationRequestId()
  let joinSent = false
  let leaveSent = false
  let settled = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  let unsubscribe: (() => void) | undefined
  let resolveResult!: (value: EditorCollaborationLease | { reason: string }) => void
  const promise = new Promise<EditorCollaborationLease | { reason: string }>((resolve) => {
    resolveResult = resolve
  })

  const release = (): void => {
    if (!joinSent || leaveSent) {
      return
    }
    leaveSent = true
    try {
      channel.send({ t: 'room-leave', room, requestId })
    } catch {
      // Socket cleanup is best-effort; server expiry is the backstop.
    }
  }
  const finish = (result: EditorCollaborationLease | { reason: string }): void => {
    if (settled) {
      return
    }
    settled = true
    if (timeout !== undefined) {
      clearTimeout(timeout)
      timeout = undefined
    }
    try {
      unsubscribe?.()
    } catch {
      // Transport cleanup cannot prevent lease settlement or best-effort leave.
    }
    unsubscribe = undefined
    if ('reason' in result) {
      release()
    }
    resolveResult(result)
  }
  unsubscribe = channel.subscribe((frame) => {
    if (!joinSent) {
      return
    }
    if (frame.room !== room || !('requestId' in frame) || frame.requestId !== requestId) {
      return
    }
    if (frame.t === 'room-joined' && typeof frame.bootstrap === 'boolean') {
      finish({ requestId, shouldBootstrap: frame.bootstrap })
    } else if (frame.t === 'room-denied') {
      finish({ reason: 'The server did not authorize an editor lease for this note.' })
    }
  })
  timeout = setTimeout(() => {
    finish({ reason: 'The encrypted collaboration room did not acknowledge the editor lease.' })
  }, timeoutMs)

  try {
    // Set before send so a transport that acknowledges synchronously can settle
    // safely. If send throws after a partial write, finish also attempts the
    // request-bound leave as a fail-closed cleanup.
    joinSent = true
    channel.send({
      t: 'room-join',
      room,
      cap: capability,
      requestId,
      role: 'editor',
    })
  } catch {
    finish({ reason: 'The encrypted collaboration room could not reserve an editor lease.' })
  }

  return {
    promise,
    cancel: () => {
      release()
      finish({ reason: 'The editor lease was cancelled.' })
    },
  }
}

export function useCollaborationRoomAccess(
  application: WebApplication,
  note: SNNote,
  electEditorBootstrap = false,
): CollaborationRoomAccessState {
  const noteRef = useRef(note)
  noteRef.current = note
  const [revision, refresh] = useReducer((value: number) => value + 1, 0)
  const [connectionRevision, retryAfterConnectionOpen] = useReducer((value: number) => value + 1, 0)
  const hasReadyAccess = useRef(false)

  useEffect(() => {
    const disposeItems = application.items.streamItems(
      [ContentType.TYPES.KeySystemRootKey, ContentType.TYPES.VaultListing],
      refresh,
    )
    const disposeVaultLocks = application.vaultLocks.addEventObserver((event) => {
      if (event === VaultLockServiceEvent.VaultLocked || event === VaultLockServiceEvent.VaultUnlocked) {
        refresh()
      }
      return Promise.resolve()
    })
    const disposeSocket = application.sockets.addEventObserver((event) => {
      // Once a Y.Doc is mounted it owns reconnect: destroying it on close would
      // discard the CRDT history needed to merge edits made while offline. An
      // editor that first opened offline, however, retries preparation on open.
      if (event === WebSocketsServiceEvent.WebSocketDidOpen && !hasReadyAccess.current) {
        retryAfterConnectionOpen()
      }
      return Promise.resolve()
    })
    const disposeApplication = application.addEventObserver((event) => {
      if (
        event === ApplicationEvent.SignedIn ||
        event === ApplicationEvent.SignedOut ||
        event === ApplicationEvent.KeyStatusChanged ||
        event === ApplicationEvent.MajorDataChange ||
        event === ApplicationEvent.CompletedFullSync
      ) {
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
  const sourceUnavailableReason = source.available ? undefined : source.reason
  const [prepared, setPrepared] = useState<{ sourceId: string; result?: PreparedRoomAccess }>(() => ({
    sourceId,
  }))
  hasReadyAccess.current = prepared.sourceId === sourceId && prepared.result !== undefined && prepared.result.available

  useEffect(() => {
    let cancelled = false
    let reservation: ReturnType<typeof beginEditorLeaseReservation> | undefined
    setPrepared({ sourceId })

    if (sourceUnavailableReason) {
      setPrepared({ sourceId, result: { available: false, reason: sourceUnavailableReason } })
      return
    }
    if (application.sockets.isWebSocketConnectionOpen?.() === false) {
      setPrepared({
        sourceId,
        result: { available: false, reason: SUPER_COLLABORATION_TRANSPORT_REASON, sourceId },
      })
      return
    }

    const activeNote = noteRef.current
    void prepareCollaborationAccess(application, activeNote)
      .then(async (result): Promise<void> => {
        if (cancelled || !result.available || !electEditorBootstrap) {
          if (!cancelled) {
            setPrepared({ sourceId, result })
          }
          return
        }

        reservation = beginEditorLeaseReservation(application, noteUuid, result.capability)
        const lease = await reservation.promise
        if (cancelled) {
          return
        }
        if ('reason' in lease) {
          setPrepared({
            sourceId,
            result: {
              available: false,
              sourceId: result.sourceId,
              reason: lease.reason,
            },
          })
        } else {
          setPrepared({
            sourceId,
            result: {
              ...result,
              editorLease: lease,
            },
          })
        }
      })
      .catch(() => {
        if (cancelled) {
          return
        }
        setPrepared({
          sourceId,
          result: {
            available: false,
            sourceId,
            reason: 'Live collaboration could not establish a secure room.',
          },
        })
      })

    return () => {
      cancelled = true
      reservation?.cancel()
    }
  }, [application, connectionRevision, electEditorBootstrap, noteUuid, sourceId, sourceUnavailableReason])

  // A key/vault/session transition invalidates the prior result immediately,
  // before the effect runs, so a stale provider is synchronously unmounted.
  if (prepared.sourceId !== sourceId || !prepared.result) {
    return source.available ? { status: 'preparing' } : { status: 'disabled', reason: source.reason }
  }

  if (!prepared.result.available) {
    return { status: 'disabled', reason: prepared.result.reason }
  }

  const { sourceId: _sourceId, ...publicResult } = prepared.result
  return { status: 'ready', ...publicResult }
}
