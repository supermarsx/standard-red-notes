import type { WebApplication } from '@/Application/WebApplication'
import type { EncryptedYjsProvider } from './EncryptedYjsProvider'
import type { Awareness } from 'y-protocols/awareness'
import { SyncQueueStrategy } from '@standardnotes/snjs'
import type { SNNote } from '@standardnotes/models'
import {
  claimCollaborationSaveFence,
  renewCollaborationSaveFence,
  releaseCollaborationSaveFence,
} from './CollaborationSaveFence'
import { CollaborativeDocumentRegistry } from './CollaborativeDocumentRegistry'
import {
  readCollaborationRevisionStamp,
  revisionStampCoversDocumentState,
  type CollaborativeDocumentState,
} from './CollaborationRevisionStamp'

export type SaverParticipant = {
  userUuid: string
  leaseId: string
  canSaveOverSocket: boolean
  canonicalReady: boolean
  saving?: boolean
}

export type CollaborationSaverState = {
  active: true
  isSaver: boolean
  paused: boolean
  leaseId: string
  saverLeaseId?: string
  /** Requests another serialization on election and while durability is pending. */
  saveRequest: number
  saveFence?: { room: string; token: string }
}

/** Locale-independent ordering, shared by every participant. Unknown clients never qualify. */
export function electCollaborationSaver(participants: SaverParticipant[]): SaverParticipant | undefined {
  return participants
    .filter(
      (peer) =>
        peer.canSaveOverSocket &&
        peer.canonicalReady &&
        typeof peer.userUuid === 'string' &&
        peer.userUuid.length > 0 &&
        peer.userUuid.length <= 128 &&
        typeof peer.leaseId === 'string' &&
        peer.leaseId.length > 0 &&
        peer.leaseId.length <= 128,
    )
    .sort((a, b) => {
      if (a.userUuid !== b.userUuid) {
        return a.userUuid < b.userUuid ? -1 : 1
      }
      if (a.leaseId !== b.leaseId) {
        return a.leaseId < b.leaseId ? -1 : 1
      }
      return 0
    })[0]
}

class CollaborationSaverRegistryImpl {
  private readonly rooms = new Map<string, CollaborationSaverState>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly flushers = new Map<string, () => Promise<void>>()
  private readonly durabilityFlushers = new Map<string, () => Promise<void>>()
  private readonly owners = new Map<string, object>()
  private readonly pendingReaders = new Map<string, () => boolean>()

  get(room: string): CollaborationSaverState | undefined {
    return this.rooms.get(room)
  }
  set(room: string, state: CollaborationSaverState, owner?: object): void {
    if (owner) {
      this.owners.set(room, owner)
    }
    this.rooms.set(room, state)
    this.listeners.get(room)?.forEach((listener) => listener())
  }
  clear(room: string, leaseId: string, owner?: object): void {
    if (owner && this.owners.get(room) !== owner) {
      return
    }
    if (this.rooms.get(room)?.leaseId === leaseId) {
      this.rooms.delete(room)
      this.flushers.delete(room)
      this.durabilityFlushers.delete(room)
      this.owners.delete(room)
      this.pendingReaders.delete(room)
      this.listeners.get(room)?.forEach((listener) => listener())
    }
  }
  isOwner(room: string, owner: object): boolean {
    return this.owners.get(room) === owner
  }
  subscribe(room: string, listener: () => void): () => void {
    const listeners = this.listeners.get(room) ?? new Set<() => void>()
    this.listeners.set(room, listeners)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        this.listeners.delete(room)
      }
    }
  }
  setFlusher(room: string, flusher: () => Promise<void>): void {
    this.flushers.set(room, flusher)
  }
  flush(room: string): Promise<void> {
    return this.flushers.get(room)?.() ?? Promise.resolve()
  }
  setDurabilityFlusher(room: string, flusher: () => Promise<void>): void {
    this.durabilityFlushers.set(room, flusher)
  }
  awaitDurable(room: string): Promise<void> {
    return this.durabilityFlushers.get(room)?.() ?? Promise.resolve()
  }
  setPendingReader(room: string, reader: () => boolean): void {
    this.pendingReaders.set(room, reader)
  }
  hasUndurableState(room: string): boolean {
    return this.pendingReaders.get(room)?.() ?? false
  }
}

export const CollaborationSaverRegistry = new CollaborationSaverRegistryImpl()
export const SAVER_HANDOFF_SETTLE_MS = 2_000
export const SAVER_DURABILITY_TIMEOUT_MS = 15_000

/** Installs once per provider lifetime; no account-wide body saves are emitted by non-savers. */
export function installCollaborationSaver(
  application: WebApplication,
  room: string,
  userUuid: string | undefined,
  leaseId: string,
  provider: EncryptedYjsProvider,
  roomEpoch: string,
): () => void {
  const constraintPersisted = application.requireSocketSavesForItem(room) !== false
  const awareness = provider.awareness as unknown as Awareness
  let disposed = false
  let electedLease: string | undefined
  let settledLease: string | undefined
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let saveRequest = 0
  let stalled = false
  let quarantineUntil = 0
  let awaiting: { state: CollaborativeDocumentState; since: number; epoch: string } | undefined
  const identity = { room, roomEpoch, leaseId }
  const registryOwner = {}
  const initialNote = application.items.findItem<SNNote>(room)
  let saveFence: { room: string; token: string; expiresAt: number } | undefined
  let renewing = false

  const releaseFence = () => {
    const previous = saveFence
    saveFence = undefined
    if (previous) {
      void releaseCollaborationSaveFence(application, identity, previous).catch(() => undefined)
    }
  }

  const publishRegistry = () => {
    if (disposed) {
      return
    }
    const localSaver =
      settledLease === leaseId && !stalled && saveFence !== undefined && saveFence.expiresAt > Date.now()
    const localAwareness = awareness.getLocalState()?.saver as SaverParticipant | undefined
    if (localAwareness && localAwareness.saving !== localSaver) {
      awareness.setLocalStateField('saver', { ...localAwareness, saving: localSaver })
    }
    application.setCollaborationSaver(room, localSaver)
    CollaborationSaverRegistry.set(
      room,
      {
        active: true,
        leaseId,
        isSaver: localSaver,
        paused: !settledLease || stalled || (settledLease === leaseId && !localSaver),
        ...(settledLease ? { saverLeaseId: settledLease } : {}),
        saveRequest,
        ...(localSaver && saveFence ? { saveFence: { room, token: saveFence.token } } : {}),
      },
      registryOwner,
    )
  }
  const elect = () => {
    const participants: SaverParticipant[] = []
    awareness.getStates().forEach((state) => {
      const candidate = (state as { saver?: SaverParticipant }).saver
      if (
        candidate &&
        typeof candidate.canSaveOverSocket === 'boolean' &&
        typeof candidate.canonicalReady === 'boolean'
      ) {
        participants.push(candidate)
      }
    })
    const chosen = electCollaborationSaver(participants)
    const next = chosen?.leaseId
    if (next === electedLease) {
      if (next && next !== leaseId) {
        const ready = chosen?.saving === true ? next : undefined
        if (settledLease !== ready) {
          settledLease = ready
          publishRegistry()
        }
      }
      return
    }
    electedLease = next
    releaseFence()
    settledLease = undefined
    if (settleTimer !== undefined) {
      clearTimeout(settleTimer)
    }
    if (next && next !== leaseId) {
      settledLease = chosen?.saving === true ? next : undefined
      publishRegistry()
      return
    }
    publishRegistry()
    if (next) {
      // Allow awareness changes and the previous editor's mutation debounce to
      // drain before taking over. Recheck at every boundary, including the save.
      settleTimer = setTimeout(() => {
        settleTimer = undefined
        if (disposed || electedLease !== next) {
          return
        }
        void (async () => {
          if (next === leaseId) {
            const claimed = await claimCollaborationSaveFence(application, identity)
            if (disposed || electedLease !== next) {
              void releaseCollaborationSaveFence(application, identity, claimed).catch(() => undefined)
              return
            }
            saveFence = claimed
            // Pull the server's current base before a replacement starts saving.
            // A local propagation callback is not a remote acknowledgement.
            await provider.flush()
            const synchronized = await application.sync.sync({
              downloadOnly: true,
              awaitAll: false,
              queueStrategy: SyncQueueStrategy.ForceSpawnNew,
              isUserInitiated: true,
              sourceDescription: 'Collaboration saver takeover',
            })
            const current = application.items.findItem<SNNote>(room)
            const currentStamp = current ? readCollaborationRevisionStamp(current.content) : undefined
            const dirtyCovered =
              currentStamp?.epoch === roomEpoch && CollaborativeDocumentRegistry.covers(room, currentStamp)
            if (
              !synchronized ||
              typeof synchronized !== 'object' ||
              (synchronized as { downloadOnly?: boolean; successful?: boolean }).downloadOnly !== true ||
              (synchronized as { successful?: boolean }).successful !== true ||
              application.sync.getSyncStatus().error ||
              !current ||
              current.key_system_identifier !== initialNote?.key_system_identifier ||
              current.shared_vault_uuid !== initialNote?.shared_vault_uuid ||
              (current.dirty && !dirtyCovered)
            ) {
              throw new Error('The collaboration saver could not confirm a clean server base.')
            }
            if (!saveFence || saveFence.expiresAt <= Date.now()) {
              throw new Error('The collaboration saver lease expired during synchronization.')
            }
          }
          if (disposed || electedLease !== next) {
            return
          }
          if (next === leaseId) {
            awaiting = undefined
            stalled = false
          }
          settledLease = next === leaseId || chosen?.saving === true ? next : undefined
          saveRequest += 1
          publishRegistry()
        })().catch(() => {
          if (disposed || electedLease !== next) {
            return
          }
          releaseFence()
          quarantineUntil = Date.now() + 5_000
          advertise()
        })
      }, SAVER_HANDOFF_SETTLE_MS)
    }
  }
  const maintainFence = () => {
    if (saveFence && electedLease === leaseId && !renewing && saveFence.expiresAt - Date.now() < 10_000) {
      const previous = saveFence
      renewing = true
      void renewCollaborationSaveFence(application, identity, previous)
        .then((renewed) => {
          if (!disposed && saveFence === previous) {
            saveFence = renewed
          }
        })
        .catch(() => {
          if (disposed || saveFence !== previous) {
            return
          }
          releaseFence()
          quarantineUntil = Date.now() + 5_000
          advertise()
        })
        .finally(() => {
          renewing = false
        })
    }
    if (saveFence && saveFence.expiresAt <= Date.now()) {
      releaseFence()
      quarantineUntil = Date.now() + 5_000
      advertise()
    }
  }
  const advertise = () => {
    if (disposed) {
      return
    }
    awareness.setLocalStateField('saver', {
      userUuid: userUuid ?? '',
      leaseId,
      canSaveOverSocket: constraintPersisted && application.syncSaveLane.usable && Date.now() >= quarantineUntil,
      canonicalReady: provider.isCanonicalReady() && provider.isRoomJoined(),
      saving: settledLease === leaseId && !stalled && saveFence !== undefined && saveFence.expiresAt > Date.now(),
    } satisfies SaverParticipant)
    elect()
  }
  awareness.on('change', elect)
  const stopLane = application.subscribeSyncSaveLane(advertise)
  const stopCanonical = provider.onCanonicalReadyChange(advertise)
  CollaborationSaverRegistry.setFlusher(room, () => provider.flush())
  CollaborationSaverRegistry.setPendingReader(room, () => {
    const document = CollaborativeDocumentRegistry.get(room)
    const state = document?.state() ?? document?.retainedState?.() ?? awaiting?.state
    if (!state) {
      return false
    }
    const note = application.items.findItem(room)
    const stamp = note ? readCollaborationRevisionStamp(note.content) : undefined
    return (
      note?.dirty !== false || !stamp || stamp.epoch !== roomEpoch || !revisionStampCoversDocumentState(stamp, state)
    )
  })
  CollaborationSaverRegistry.setDurabilityFlusher(room, async () => {
    await provider.flush()
    const target = CollaborativeDocumentRegistry.get(room)?.state()
    if (!target) {
      throw new Error('The collaboration document is not ready to persist.')
    }
    if (CollaborationSaverRegistry.get(room)?.isSaver) {
      await application.sync.sync({
        queueStrategy: SyncQueueStrategy.ForceSpawnNew,
        isUserInitiated: true,
        awaitAll: false,
        sourceDescription: 'Persisting the outgoing collaborative note over its socket saver',
      })
    }
    const deadline = Date.now() + SAVER_DURABILITY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (disposed) {
        break
      }
      const note = application.items.findItem(room)
      const stamp = note ? readCollaborationRevisionStamp(note.content) : undefined
      if (note?.dirty === false && stamp?.epoch === roomEpoch && revisionStampCoversDocumentState(stamp, target)) {
        return
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('The collaboration room has not acknowledged this note over its socket saver.')
  })
  publishRegistry()
  advertise()

  const watchdog = setInterval(() => {
    if (disposed) {
      return
    }
    maintainFence()
    if (quarantineUntil && Date.now() >= quarantineUntil) {
      quarantineUntil = 0
      stalled = false
      advertise()
    }
    const document = CollaborativeDocumentRegistry.get(room)
    const state = document?.state()
    const note = application.items.findItem(room)
    const stamp = note ? readCollaborationRevisionStamp(note.content) : undefined
    const target = awaiting?.state ?? state
    const covered =
      target &&
      stamp &&
      !note?.dirty &&
      stamp.epoch === document?.epoch &&
      revisionStampCoversDocumentState(stamp, target)
    if (covered) {
      awaiting = undefined
      stalled = false
      publishRegistry()
      return
    }
    if (!state || !document) {
      return
    }
    if (!awaiting || awaiting.epoch !== document.epoch) {
      awaiting = { state, epoch: document.epoch, since: Date.now() }
    }
    if (Date.now() - awaiting.since >= SAVER_DURABILITY_TIMEOUT_MS) {
      // Presence is not proof of durability. Stop accepting edits when the
      // server has not acknowledged even the state seen at the start of this wait.
      stalled = true
      if (settledLease === leaseId) {
        quarantineUntil = Date.now() + 30_000
        advertise()
      }
      publishRegistry()
    } else if (settledLease === leaseId) {
      saveRequest += 1
      publishRegistry()
    }
  }, 1_000)
  return () => {
    const outgoingDocument = CollaborativeDocumentRegistry.get(room)
    const outgoingState = outgoingDocument?.state() ?? outgoingDocument?.retainedState?.() ?? awaiting?.state
    const outgoingFence = saveFence
    const outgoingSaver = settledLease === leaseId && !stalled && outgoingFence !== undefined
    disposed = true
    clearInterval(watchdog)
    if (settleTimer !== undefined) {
      clearTimeout(settleTimer)
    }
    stopLane()
    stopCanonical()
    awareness.off('change', elect)
    awareness.setLocalStateField('saver', null)
    const finish = () => {
      if (!CollaborationSaverRegistry.isOwner(room, registryOwner)) {
        return
      }
      releaseFence()
      CollaborationSaverRegistry.clear(room, leaseId, registryOwner)
      const note = application.items.findItem(room)
      const stamp = note ? readCollaborationRevisionStamp(note.content) : undefined
      const clean =
        note?.dirty === false &&
        (!outgoingState || (stamp?.epoch === roomEpoch && revisionStampCoversDocumentState(stamp, outgoingState)))
      application.setCollaborationSaver(room, clean)
      application.releaseSocketSavesForItem(room, clean)
    }
    if (!outgoingSaver || !outgoingFence || outgoingFence.expiresAt <= Date.now()) {
      finish()
      return
    }
    // Ordinary closes already waited for remote durability. For abrupt unmount,
    // allow the serialized item to drain under this proof within its remaining TTL.
    // Never renew a detached editor's room lease or fall back to HTTP.
    let finishing = false
    const finishOnce = () => {
      if (!finishing) {
        finishing = true
        clearTimeout(deadline)
        finish()
      }
    }
    const deadline = setTimeout(finishOnce, Math.min(15_000, outgoingFence.expiresAt - Date.now()))
    void application.sync
      .sync({
        queueStrategy: SyncQueueStrategy.ForceSpawnNew,
        isUserInitiated: true,
        awaitAll: false,
        sourceDescription: 'Draining the detached collaboration saver before releasing its proof',
      })
      .then(finishOnce, finishOnce)
  }
}
