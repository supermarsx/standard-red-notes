import {
  COLLABORATION_PRESENCE_MAX_TTL_MS,
  COLLABORATION_PRESENCE_MIN_TTL_MS,
  COLLABORATION_PROTOCOL_VERSION,
  type CollabFrame,
} from './CollabChannel'

const MAX_PRESENCE_SESSIONS = 64
const MAX_PRESENCE_ID_LENGTH = 128
const MAX_USER_UUID_LENGTH = 128
const MAX_DISPLAY_LABEL_LENGTH = 128
const MAX_YJS_CLIENT_ID = 0xffff_ffff

type PresenceFrame = Extract<CollabFrame, { t: 'room-presence' }>
type PresenceLeftReason = Extract<PresenceFrame, { action: 'left' }>['reason']

export type EncryptedAwarenessIdentity = {
  userUuid?: string
  label?: string
}

export type CollaborationPresenceActivity = {
  action: 'joined' | 'left'
  presenceId: string
  userUuid: string
  clientId: number
  label: string
  reason?: PresenceLeftReason
}

type PresenceSession = {
  presenceId: string
  userUuid: string
  clientId: number
  expiresAt: number
  label?: string
  joinedActivityEmitted: boolean
}

export type EphemeralRoomPresenceOptions = {
  room: string
  roomEpoch: string
  localClientId: number
  resolveEncryptedAwarenessIdentity(clientId: number): EncryptedAwarenessIdentity | undefined
  onActivity(activity: CollaborationPresenceActivity): void
  onTerminalClient?(clientId: number, reason: PresenceLeftReason): void
  now?(): number
}

/**
 * Content-free, memory-only lifecycle for gateway-authenticated editor presence.
 *
 * The gateway event proves that an editor lease is alive; the user-facing label
 * is resolved separately from the already E2E-encrypted Yjs awareness state.
 * Nothing in this ledger is persisted, and one timer covers the entire bounded
 * room rather than allocating a timer per peer.
 */
export class EphemeralRoomPresence {
  private readonly sessions = new Map<string, PresenceSession>()
  private readonly presenceIdByClientId = new Map<number, string>()
  private expiryTimeout: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly options: EphemeralRoomPresenceOptions) {}

  accept(frame: PresenceFrame): boolean {
    if (
      frame.room !== this.options.room ||
      frame.roomEpoch !== this.options.roomEpoch ||
      frame.protocolVersion !== COLLABORATION_PROTOCOL_VERSION
    ) {
      return false
    }

    if (frame.action === 'joined') {
      return this.acceptJoined(frame)
    }
    return this.acceptLeft(frame)
  }

  /** Retry label resolution after a decrypted awareness update is applied. */
  reconcileEncryptedAwareness(): void {
    for (const session of this.sessions.values()) {
      if (session.joinedActivityEmitted) {
        continue
      }
      let identity: EncryptedAwarenessIdentity | undefined
      try {
        identity = this.options.resolveEncryptedAwarenessIdentity(session.clientId)
      } catch {
        identity = undefined
      }
      const label = this.normalizeLabel(identity?.label)
      if (!label || identity?.userUuid !== session.userUuid) {
        continue
      }
      session.label = label
      session.joinedActivityEmitted = true
      this.emitActivity({
        action: 'joined',
        presenceId: session.presenceId,
        userUuid: session.userUuid,
        clientId: session.clientId,
        label,
      })
    }
  }

  clear(): void {
    if (this.expiryTimeout !== undefined) {
      clearTimeout(this.expiryTimeout)
      this.expiryTimeout = undefined
    }
    this.sessions.clear()
    this.presenceIdByClientId.clear()
  }

  get size(): number {
    return this.sessions.size
  }

  private acceptJoined(frame: Extract<PresenceFrame, { action: 'joined' }>): boolean {
    if (
      !this.isBoundedIdentifier(frame.presenceId, MAX_PRESENCE_ID_LENGTH) ||
      !this.isBoundedIdentifier(frame.userUuid, MAX_USER_UUID_LENGTH) ||
      !this.isValidClientId(frame.clientId) ||
      frame.clientId === this.options.localClientId ||
      !Number.isInteger(frame.ttlMilliseconds) ||
      frame.ttlMilliseconds < COLLABORATION_PRESENCE_MIN_TTL_MS ||
      frame.ttlMilliseconds > COLLABORATION_PRESENCE_MAX_TTL_MS
    ) {
      return false
    }

    const existing = this.sessions.get(frame.presenceId)
    if (existing) {
      if (existing.clientId !== frame.clientId || existing.userUuid !== frame.userUuid) {
        return false
      }
      existing.expiresAt = this.now() + frame.ttlMilliseconds
      this.scheduleExpiry()
      this.reconcileEncryptedAwareness()
      return true
    }

    if (this.sessions.size >= MAX_PRESENCE_SESSIONS || this.presenceIdByClientId.has(frame.clientId)) {
      return false
    }

    this.sessions.set(frame.presenceId, {
      presenceId: frame.presenceId,
      userUuid: frame.userUuid,
      clientId: frame.clientId,
      expiresAt: this.now() + frame.ttlMilliseconds,
      joinedActivityEmitted: false,
    })
    this.presenceIdByClientId.set(frame.clientId, frame.presenceId)
    this.scheduleExpiry()
    this.reconcileEncryptedAwareness()
    return true
  }

  private acceptLeft(frame: Extract<PresenceFrame, { action: 'left' }>): boolean {
    if (!this.isBoundedIdentifier(frame.presenceId, MAX_PRESENCE_ID_LENGTH)) {
      return false
    }
    const existing = this.sessions.get(frame.presenceId)
    if (
      !existing ||
      (frame.clientId !== undefined && frame.clientId !== existing.clientId) ||
      (frame.userUuid !== undefined && frame.userUuid !== existing.userUuid)
    ) {
      return false
    }
    this.terminate(existing, frame.reason)
    this.scheduleExpiry()
    return true
  }

  private terminate(session: PresenceSession, reason: PresenceLeftReason): void {
    this.sessions.delete(session.presenceId)
    this.presenceIdByClientId.delete(session.clientId)
    try {
      this.options.onTerminalClient?.(session.clientId, reason)
    } catch {
      // Presence cleanup and editor teardown must not depend on UI observers.
    }
    if (session.joinedActivityEmitted && session.label) {
      this.emitActivity({
        action: 'left',
        presenceId: session.presenceId,
        userUuid: session.userUuid,
        clientId: session.clientId,
        label: session.label,
        reason,
      })
    }
  }

  private scheduleExpiry(): void {
    if (this.expiryTimeout !== undefined) {
      clearTimeout(this.expiryTimeout)
      this.expiryTimeout = undefined
    }
    let earliest = Number.POSITIVE_INFINITY
    for (const session of this.sessions.values()) {
      earliest = Math.min(earliest, session.expiresAt)
    }
    if (!Number.isFinite(earliest)) {
      return
    }
    this.expiryTimeout = setTimeout(
      () => {
        this.expiryTimeout = undefined
        const now = this.now()
        for (const session of [...this.sessions.values()]) {
          if (session.expiresAt <= now) {
            this.terminate(session, 'heartbeat-timeout')
          }
        }
        this.scheduleExpiry()
      },
      Math.max(0, earliest - this.now()),
    )
  }

  private emitActivity(activity: CollaborationPresenceActivity): void {
    try {
      this.options.onActivity(activity)
    } catch {
      // A transient notification failure cannot affect collaboration state.
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private isValidClientId(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0 && value <= MAX_YJS_CLIENT_ID
  }

  private isBoundedIdentifier(value: string, maxLength: number): boolean {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength && value.trim() === value
  }

  private normalizeLabel(value: string | undefined): string | undefined {
    if (typeof value !== 'string') {
      return undefined
    }
    const label = value.trim()
    return label.length > 0 && label.length <= MAX_DISPLAY_LABEL_LENGTH ? label : undefined
  }
}
