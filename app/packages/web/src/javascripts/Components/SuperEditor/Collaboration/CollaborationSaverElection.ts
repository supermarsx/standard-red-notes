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
export const SAVER_INITIALIZATION_TIMEOUT_MS = 15_000
const pendingFenceReleasesByApplication = new WeakMap<WebApplication, Map<string, Promise<void>>>()

/** Installs once per provider lifetime; no account-wide body saves are emitted by non-savers. */
export function installCollaborationSaver(
  application: WebApplication,
  room: string,
  userUuid: string | undefined,
  initialLeaseId: string,
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
  const registryOwner = {}
  const initialNote = application.items.findItem<SNNote>(room)
  let saveFence: { room: string; token: string; expiresAt: number } | undefined
  let renewing = false
  let leaseId = initialLeaseId
  let identity = { room, roomEpoch, leaseId }
  let activeIdentityValid = false
  let generation = 0
  let initializationTimer: ReturnType<typeof setTimeout> | undefined
  let blockedInitialization: number | undefined
  let fenceIdentity = identity
  const pendingFenceReleases = pendingFenceReleasesByApplication.get(application) ?? new Map<string, Promise<void>>()
  pendingFenceReleasesByApplication.set(application, pendingFenceReleases)
  const identityKey = (value: typeof identity) => JSON.stringify([value.room, value.roomEpoch, value.leaseId])
  const queueFenceRelease = (value: typeof identity, fence: NonNullable<typeof saveFence>) => {
    const key = identityKey(value)
    const previous = pendingFenceReleases.get(key) ?? Promise.resolve()
    const release = previous.then(() => releaseCollaborationSaveFence(application, value, fence)).catch(() => undefined)
    pendingFenceReleases.set(key, release)
    void release.then(() => {
      if (pendingFenceReleases.get(key) === release) {
        pendingFenceReleases.delete(key)
      }
    })
  }

  const releaseFence = () => {
    const previous = saveFence
    saveFence = undefined
    if (previous) {
      queueFenceRelease(fenceIdentity, previous)
    }
  }
  const releaseStaleFence = (staleIdentity: typeof identity, staleFence: NonNullable<typeof saveFence>) => {
    const replacement = CollaborationSaverRegistry.get(room)
    if (!CollaborationSaverRegistry.isOwner(room, registryOwner) && replacement?.leaseId === staleIdentity.leaseId) {
      // A replacement installer can be waiting for, or already own, this same
      // SQL token. Its current lifetime decides when to release the proof.
      return
    }
    // A repeated claim by the same gateway lease may return the same SQL token.
    // A newer attempt can already own it, or be waiting for that same response.
    if (
      !disposed &&
      activeIdentityValid &&
      electedLease === leaseId &&
      identity.leaseId === staleIdentity.leaseId &&
      identity.roomEpoch === staleIdentity.roomEpoch &&
      (!saveFence || saveFence.token === staleFence.token)
    ) {
      return
    }
    queueFenceRelease(staleIdentity, staleFence)
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
    generation += 1
    renewing = false
    clearTimeout(initializationTimer)
    initializationTimer = undefined
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
        const attemptGeneration = generation
        const attemptIdentity = identity
        const isCurrent = () => !disposed && generation === attemptGeneration && electedLease === next
        initializationTimer = setTimeout(() => {
          if (!isCurrent()) {
            return
          }
          blockedInitialization = attemptGeneration
          generation += 1
          renewing = false
          initializationTimer = undefined
          releaseFence()
          quarantineUntil = Date.now() + 5_000
          advertise()
        }, SAVER_INITIALIZATION_TIMEOUT_MS)
        void (async () => {
          if (next === leaseId) {
            const releaseKey = identityKey(attemptIdentity)
            while (pendingFenceReleases.has(releaseKey)) {
              await pendingFenceReleases.get(releaseKey)
              if (!isCurrent()) {
                return
              }
            }
            const claimed = await claimCollaborationSaveFence(application, attemptIdentity)
            if (!isCurrent()) {
              releaseStaleFence(attemptIdentity, claimed)
              return
            }
            saveFence = claimed
            fenceIdentity = attemptIdentity
            // Pull the server's current base before a replacement starts saving.
            // A local propagation callback is not a remote acknowledgement.
            await provider.flush()
            if (!isCurrent()) {
              return
            }
            const synchronized = await application.sync.sync({
              downloadOnly: true,
              awaitAll: false,
              queueStrategy: SyncQueueStrategy.ForceSpawnNew,
              isUserInitiated: true,
              sourceDescription: 'Collaboration saver takeover',
            })
            if (!isCurrent()) {
              return
            }
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
          if (!isCurrent()) {
            return
          }
          clearTimeout(initializationTimer)
          initializationTimer = undefined
          if (next === leaseId) {
            awaiting = undefined
            stalled = false
          }
          settledLease = next === leaseId || chosen?.saving === true ? next : undefined
          saveRequest += 1
          publishRegistry()
        })()
          .catch(() => {
            if (!isCurrent()) {
              return
            }
            clearTimeout(initializationTimer)
            initializationTimer = undefined
            releaseFence()
            quarantineUntil = Date.now() + 5_000
            advertise()
          })
          .finally(() => {
            if (blockedInitialization === attemptGeneration) {
              blockedInitialization = undefined
              advertise()
            }
          })
      }, SAVER_HANDOFF_SETTLE_MS)
    }
  }
  const maintainFence = () => {
    if (saveFence && electedLease === leaseId && !renewing && saveFence.expiresAt - Date.now() < 10_000) {
      const previous = saveFence
      const renewalGeneration = generation
      const renewalIdentity = fenceIdentity
      renewing = true
      void renewCollaborationSaveFence(application, renewalIdentity, previous)
        .then((renewed) => {
          if (!disposed && generation === renewalGeneration && saveFence === previous) {
            saveFence = renewed
          } else {
            releaseStaleFence(renewalIdentity, renewed)
          }
        })
        .catch(() => {
          if (disposed || generation !== renewalGeneration || saveFence !== previous) {
            return
          }
          releaseFence()
          quarantineUntil = Date.now() + 5_000
          advertise()
        })
        .finally(() => {
          if (generation === renewalGeneration) {
            renewing = false
          }
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
      canSaveOverSocket:
        activeIdentityValid &&
        blockedInitialization === undefined &&
        constraintPersisted &&
        application.syncSaveLane.usable &&
        Date.now() >= quarantineUntil,
      canonicalReady: activeIdentityValid && provider.isCanonicalReady() && provider.isRoomJoined(),
      saving: settledLease === leaseId && !stalled && saveFence !== undefined && saveFence.expiresAt > Date.now(),
    } satisfies SaverParticipant)
    elect()
  }
  const rebindIdentity = () => {
    const active = provider.getActiveEditorLeaseIdentity()
    const valid = active !== undefined && active.roomEpoch === roomEpoch
    if (activeIdentityValid === valid && (!valid || active?.leaseId === leaseId)) {
      return
    }
    generation += 1
    blockedInitialization = undefined
    clearTimeout(initializationTimer)
    initializationTimer = undefined
    clearTimeout(settleTimer)
    settleTimer = undefined
    releaseFence()
    electedLease = undefined
    settledLease = undefined
    renewing = false
    stalled = false
    quarantineUntil = 0
    activeIdentityValid = valid
    if (valid && active) {
      leaseId = active.leaseId
      identity = { room, roomEpoch: active.roomEpoch, leaseId }
    }
    publishRegistry()
    advertise()
  }
  awareness.on('change', elect)
  const stopLane = application.subscribeSyncSaveLane(advertise)
  const stopCanonical = provider.onCanonicalReadyChange(advertise)
  const stopIdentity = provider.onActiveEditorLeaseChange(rebindIdentity)
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
  rebindIdentity()
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
    generation += 1
    clearInterval(watchdog)
    clearTimeout(initializationTimer)
    if (settleTimer !== undefined) {
      clearTimeout(settleTimer)
    }
    stopLane()
    stopCanonical()
    stopIdentity()
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
