import { SNNote } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { createGatewayCollabChannel } from '@/Components/SuperEditor/Collaboration/GatewayCollabChannel'
import {
  createCollaborationRoomCipher,
  getCollaborationReplayLedger,
  isValidCollaborationRoomEpoch,
  RoomCipher,
} from '@/Components/SuperEditor/Collaboration/RoomCrypto'
import {
  COLLABORATION_MAX_TRANSFER_BYTES,
  COLLABORATION_PROTOCOL_VERSION,
  createCollaborationRequestId,
  type CollabChannel,
  type CollabFrame,
} from '@/Components/SuperEditor/Collaboration/CollabChannel'
import { getSuperCollaborationAvailability } from '@/Components/SuperEditor/Collaboration/CollaborationAvailability'
import {
  matchesNoteEncryptionIdentity,
  resolveNoteEncryptionIdentity,
  type NoteEncryptionIdentity,
} from '@/Components/SuperEditor/Collaboration/CollaborationKeyDerivation'
import {
  compareCommentMutationStamps,
  MAX_COMMENT_MUTATION_RECORDS,
  normalizeComment,
  NoteCommentActorClock,
  NoteComment,
  NoteCommentMutationRecord,
} from './comments'
import {
  readVerifiedCommentMutationState,
  verifyCommentAuthorship,
  verifyCommentMutationAuthorship,
} from './CommentAuthorship'

export type CommentRelayEvent =
  | { version: 3; operation: 'upsert'; comment: NoteComment; mutation: NoteCommentMutationRecord }
  | { version: 3; operation: 'remove'; commentId: string; mutation: NoteCommentMutationRecord }
  | { version: 3; operation: 'resolve'; commentId: string; resolved: boolean; mutation: NoteCommentMutationRecord }

const commentAdditionalData = (room: string): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify([
      'standard-red-notes:collaboration-frame:v3',
      COLLABORATION_PROTOCOL_VERSION,
      room,
      'comment-event-v3',
    ]),
  )
const MAX_PENDING_COMMENT_EVENTS = 32
export const MAX_COMMENT_EVENT_PLAINTEXT_BYTES = 64 * 1024
// AES-GCM base64 plus the bounded v1 room/sender/sequence envelope header.
const MAX_COMMENT_EVENT_ENCODED_BYTES = Math.ceil((MAX_COMMENT_EVENT_PLAINTEXT_BYTES + 64) / 3) * 4 + 512

/**
 * Realtime comment events share the editor's authenticated gateway room and
 * exact same per-note AES key. The relay sees only AES-GCM ciphertext.
 */
export class CommentRelay {
  private readonly channel: CollabChannel
  private readonly cipher: RoomCipher
  private readonly requestId: string
  private readonly expectedIdentity: NoteEncryptionIdentity
  private unsubscribe: (() => void) | null = null
  private unsubscribeStatus: (() => void) | null = null
  private joined = false
  private destroyed = false
  private joinRequested = false
  private lifecycleGeneration = 0
  private joiningGeneration: number | undefined
  private readonly acceptedMutations = new Map<string, NoteCommentMutationRecord>()
  private commentProcessing: Promise<void> = Promise.resolve()
  private pendingCommentEvents = 0

  constructor(
    private readonly application: WebApplication,
    private readonly room: string,
    roomKey: CryptoKey,
    private readonly roomEpoch: string,
    capability: string,
    private readonly onRemoteEvent: (event: CommentRelayEvent) => void | boolean | Promise<void | boolean>,
    expectedIdentity?: NoteEncryptionIdentity,
  ) {
    const availability = getSuperCollaborationAvailability()
    if (!availability.available) {
      throw new Error(availability.reason)
    }
    if (!room || !capability || !isValidCollaborationRoomEpoch(roomEpoch)) {
      throw new Error('Comments require an exact-note collaboration capability.')
    }

    // Validate the key and immutable origin identity before creating or joining
    // any network channel. The sessionUser field is an opaque in-memory epoch;
    // a same-UUID sign-out/login is deliberately a different identity.
    this.cipher = createCollaborationRoomCipher(
      roomKey,
      roomEpoch,
      undefined,
      getCollaborationReplayLedger(application, room, roomEpoch),
    )
    const capturedIdentity =
      expectedIdentity ??
      (() => {
        try {
          const current = application.items.findItem<SNNote>(room)
          return current ? resolveNoteEncryptionIdentity(application, current) : undefined
        } catch {
          return undefined
        }
      })()
    if (!capturedIdentity || capturedIdentity.noteUuid !== room) {
      throw new Error('Comments require the exact current note encryption identity.')
    }
    this.expectedIdentity = capturedIdentity
    if (!this.hasExpectedIdentity()) {
      throw new Error('Comments require the exact current note encryption identity.')
    }
    this.channel = createGatewayCollabChannel(this.application)
    this.requestId = createCollaborationRequestId()
    this.unsubscribe = this.channel.subscribe(this.handleFrame)
    this.joinRequested = true
    this.unsubscribeStatus = this.channel.subscribeStatus?.(this.handleTransportStatus) ?? null
    if (!this.isTransportConnected()) {
      this.joinRequested = false
      return
    }
    try {
      this.channel.send({
        t: 'room-join',
        room,
        cap: capability,
        requestId: this.requestId,
        role: 'comment',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        expectedRoomEpoch: this.roomEpoch,
      })
    } catch (error) {
      this.joinRequested = false
      this.joined = false
      // The production transport exposes status events, so a close/send race
      // must leave this relay alive for a fresh request-bound join on reopen.
      if (this.channel.subscribeStatus) {
        if (this.isTransportConnected()) {
          void this.reauthorizeAndJoin(this.lifecycleGeneration)
        }
        return
      }
      this.destroyed = true
      try {
        this.unsubscribe?.()
      } catch {
        // Preserve the transport's join error while still abandoning the relay.
      }
      this.unsubscribe = null
      try {
        this.unsubscribeStatus?.()
      } catch {
        // Preserve the transport's join error while still abandoning the relay.
      }
      this.unsubscribeStatus = null
      throw error
    }
  }

  isRoomJoined(): boolean {
    return this.joined
  }

  /** Backward-compatible shorthand for broadcasting an upsert. */
  async broadcast(comment: NoteComment, mutation: NoteCommentMutationRecord): Promise<void> {
    await this.broadcastUpsert(comment, mutation)
  }

  async broadcastUpsert(comment: NoteComment, mutation: NoteCommentMutationRecord): Promise<void> {
    const verified = verifyCommentAuthorship(this.application, this.room, comment)
    const mutationVerification = verifyCommentMutationAuthorship(this.application, this.room, mutation)
    const normalized = mutationVerification.status === 'verified' ? mutationVerification.mutation : undefined
    if (
      verified.status !== 'verified' ||
      !normalized ||
      normalized.operation !== 'upsert' ||
      normalized.commentId !== verified.comment.id ||
      normalized.stamp.actorUuid !== verified.comment.authorUuid ||
      normalized.affectedCommentIds.length !== 1
    ) {
      return
    }
    await this.broadcastEvent({ version: 3, operation: 'upsert', comment: verified.comment, mutation: normalized })
  }

  async broadcastRemove(commentId: string, mutation: NoteCommentMutationRecord): Promise<void> {
    const mutationVerification = verifyCommentMutationAuthorship(this.application, this.room, mutation)
    const normalized = mutationVerification.status === 'verified' ? mutationVerification.mutation : undefined
    if (!commentId || !normalized || normalized.operation !== 'remove' || normalized.commentId !== commentId) {
      return
    }
    await this.broadcastEvent({ version: 3, operation: 'remove', commentId, mutation: normalized })
  }

  async broadcastResolve(commentId: string, resolved: boolean, mutation: NoteCommentMutationRecord): Promise<void> {
    const mutationVerification = verifyCommentMutationAuthorship(this.application, this.room, mutation)
    const normalized = mutationVerification.status === 'verified' ? mutationVerification.mutation : undefined
    if (
      !commentId ||
      !normalized ||
      normalized.operation !== 'resolve' ||
      normalized.commentId !== commentId ||
      normalized.affectedCommentIds.length !== 1 ||
      normalized.resolved !== resolved
    ) {
      return
    }
    await this.broadcastEvent({ version: 3, operation: 'resolve', commentId, resolved, mutation: normalized })
  }

  private async broadcastEvent(event: CommentRelayEvent): Promise<void> {
    // Never queue plaintext or emit before the server acknowledges this exact
    // authorized join. Persistence + ordinary encrypted sync remain the fallback.
    const generation = this.lifecycleGeneration
    if (this.destroyed || !this.joined || !this.isTransportConnected() || !this.hasExpectedIdentity()) {
      return
    }
    try {
      const plaintext = new TextEncoder().encode(JSON.stringify(event))
      if (plaintext.byteLength > MAX_COMMENT_EVENT_PLAINTEXT_BYTES) {
        return
      }
      const payload = await this.cipher.encrypt(plaintext, commentAdditionalData(this.room))
      if (
        !this.destroyed &&
        generation === this.lifecycleGeneration &&
        this.joined &&
        this.isTransportConnected() &&
        this.hasExpectedIdentity()
      ) {
        this.channel.send({ t: 'comment', room: this.room, payload })
      }
    } catch {
      // Fail closed without logging plaintext, keys, tokens, or payloads.
    }
  }

  private readonly handleFrame = (frame: CollabFrame): void => {
    if (frame.room !== this.room) {
      return
    }
    if (frame.t === 'room-joined' && frame.requestId === this.requestId && this.joinRequested) {
      if (
        frame.protocolVersion !== COLLABORATION_PROTOCOL_VERSION ||
        frame.maxTransferBytes !== COLLABORATION_MAX_TRANSFER_BYTES ||
        frame.roomEpoch !== this.roomEpoch ||
        !this.hasExpectedIdentity()
      ) {
        this.joinRequested = false
        this.joined = false
        return
      }
      this.joinRequested = false
      this.joined = true
      return
    }
    if (frame.t === 'room-denied' && frame.requestId === this.requestId) {
      const shouldReauthorize = this.joined || this.joinRequested
      this.joinRequested = false
      this.joined = false
      this.lifecycleGeneration += 1
      this.joiningGeneration = undefined
      if (shouldReauthorize && this.isTransportConnected() && this.hasExpectedIdentity()) {
        void this.reauthorizeAndJoin(this.lifecycleGeneration)
      }
      return
    }
    if (frame.t === 'comment' && this.joined && this.hasExpectedIdentity()) {
      this.enqueueComment(frame.payload, this.lifecycleGeneration)
    }
  }

  private enqueueComment(payload: string, generation: number): void {
    if (
      payload.length === 0 ||
      payload.length > MAX_COMMENT_EVENT_ENCODED_BYTES ||
      this.pendingCommentEvents >= MAX_PENDING_COMMENT_EVENTS
    ) {
      return
    }
    this.pendingCommentEvents += 1
    this.commentProcessing = this.commentProcessing
      .then(() => this.decryptAndDeliver(payload, generation))
      .finally(() => {
        this.pendingCommentEvents -= 1
      })
  }

  private readonly handleTransportStatus = (connected: boolean): void => {
    if (this.destroyed) {
      return
    }

    if (!connected) {
      this.lifecycleGeneration += 1
      this.joiningGeneration = undefined
      this.joined = false
      this.joinRequested = false
      return
    }

    if (
      !this.hasExpectedIdentity() ||
      this.joined ||
      this.joinRequested ||
      this.joiningGeneration === this.lifecycleGeneration
    ) {
      return
    }
    void this.reauthorizeAndJoin(this.lifecycleGeneration)
  }

  private isTransportConnected(): boolean {
    try {
      return this.channel.isConnected()
    } catch {
      return false
    }
  }

  private async reauthorizeAndJoin(generation = this.lifecycleGeneration): Promise<void> {
    if (
      this.destroyed ||
      generation !== this.lifecycleGeneration ||
      this.joiningGeneration === generation ||
      !this.isTransportConnected() ||
      !this.hasExpectedIdentity()
    ) {
      return
    }
    this.joiningGeneration = generation
    try {
      let capability: string | undefined
      try {
        const authorization = await this.channel.authorizeEpochBound?.(this.room, this.roomEpoch, this.requestId)
        if (
          authorization?.collaborationProtocolVersion === COLLABORATION_PROTOCOL_VERSION &&
          authorization.roomEpoch === this.roomEpoch
        ) {
          capability = authorization.capability
        }
      } catch {
        capability = undefined
      }
      if (
        !this.destroyed &&
        generation === this.lifecycleGeneration &&
        capability &&
        this.isTransportConnected() &&
        this.hasExpectedIdentity()
      ) {
        try {
          this.joinRequested = true
          this.channel.send({
            t: 'room-join',
            room: this.room,
            cap: capability,
            requestId: this.requestId,
            role: 'comment',
            protocolVersion: COLLABORATION_PROTOCOL_VERSION,
            expectedRoomEpoch: this.roomEpoch,
          })
        } catch {
          this.joinRequested = false
          this.joined = false
          // A reconnect race can close the transport between the connected
          // check and send. Remain unjoined and use durable encrypted sync.
        }
      }
    } catch {
      if (generation === this.lifecycleGeneration) {
        this.joinRequested = false
        this.joined = false
      }
    } finally {
      if (this.joiningGeneration === generation) {
        this.joiningGeneration = undefined
      }
    }
  }

  private async decryptAndDeliver(payload: string, generation: number): Promise<void> {
    try {
      if (this.destroyed || generation !== this.lifecycleGeneration || !this.joined || !this.hasExpectedIdentity()) {
        return
      }
      const bytes = await this.cipher.decrypt(payload, commentAdditionalData(this.room))
      if (
        this.destroyed ||
        generation !== this.lifecycleGeneration ||
        !this.joined ||
        !this.hasExpectedIdentity() ||
        bytes.byteLength > MAX_COMMENT_EVENT_PLAINTEXT_BYTES
      ) {
        return
      }
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<CommentRelayEvent>
      if (parsed.version !== 3) {
        return
      }
      const mutationVerification = parsed.mutation
        ? verifyCommentMutationAuthorship(this.application, this.room, parsed.mutation)
        : undefined
      const mutation = mutationVerification?.status === 'verified' ? mutationVerification.mutation : undefined
      if (!mutation) {
        return
      }
      if (parsed.operation === 'upsert') {
        const comment = normalizeComment(parsed.comment)
        const verified = comment ? verifyCommentAuthorship(this.application, this.room, comment) : undefined
        if (
          verified?.status === 'verified' &&
          mutation.operation === 'upsert' &&
          mutation.commentId === verified.comment.id &&
          mutation.stamp.actorUuid === verified.comment.authorUuid &&
          mutation.affectedCommentIds.length === 1 &&
          this.acceptMutation(mutation)
        ) {
          const applied = await this.onRemoteEvent({
            version: 3,
            operation: 'upsert',
            comment: verified.comment,
            mutation,
          })
          if (
            applied !== false &&
            generation === this.lifecycleGeneration &&
            this.joined &&
            this.hasExpectedIdentity()
          ) {
            this.recordAcceptedMutation(mutation)
          }
        }
      } else if (
        parsed.operation === 'remove' &&
        typeof parsed.commentId === 'string' &&
        parsed.commentId &&
        mutation.operation === 'remove' &&
        mutation.commentId === parsed.commentId &&
        this.acceptMutation(mutation)
      ) {
        const applied = await this.onRemoteEvent({
          version: 3,
          operation: 'remove',
          commentId: parsed.commentId,
          mutation,
        })
        if (applied !== false && generation === this.lifecycleGeneration && this.joined && this.hasExpectedIdentity()) {
          this.recordAcceptedMutation(mutation)
        }
      } else if (
        parsed.operation === 'resolve' &&
        typeof parsed.commentId === 'string' &&
        parsed.commentId &&
        typeof parsed.resolved === 'boolean' &&
        mutation.operation === 'resolve' &&
        mutation.commentId === parsed.commentId &&
        mutation.affectedCommentIds.length === 1 &&
        mutation.resolved === parsed.resolved &&
        this.acceptMutation(mutation)
      ) {
        const applied = await this.onRemoteEvent({
          version: 3,
          operation: 'resolve',
          commentId: parsed.commentId,
          resolved: parsed.resolved,
          mutation,
        })
        if (applied !== false && generation === this.lifecycleGeneration && this.joined && this.hasExpectedIdentity()) {
          this.recordAcceptedMutation(mutation)
        }
      }
    } catch {
      // Wrong/rotated keys and malformed ciphertext are intentionally ignored.
    }
  }

  private acceptMutation(mutation: NoteCommentMutationRecord): boolean {
    const durableState = this.getDurableMutations()
    if (!durableState) {
      return false
    }
    const actorClock = durableState.clocks.find((clock) => clock.actorUuid === mutation.stamp.actorUuid)
    if (actorClock?.replayFloor && compareCommentMutationStamps(mutation.stamp, actorClock.replayFloor.stamp) <= 0) {
      return false
    }
    if (
      durableState.mutations.some(
        (record) =>
          record.stamp.actorUuid === mutation.stamp.actorUuid &&
          record.stamp.counter === mutation.stamp.counter &&
          record.stamp.eventId === mutation.stamp.eventId,
      )
    ) {
      return false
    }
    for (const commentId of mutation.affectedCommentIds) {
      const inMemory = this.acceptedMutations.get(commentId)
      const durable = durableState.mutations
        .filter((record) => record.affectedCommentIds.includes(commentId))
        .sort((left, right) => compareCommentMutationStamps(right.stamp, left.stamp))[0]
      const highWater =
        inMemory && durable
          ? compareCommentMutationStamps(inMemory.stamp, durable.stamp) >= 0
            ? inMemory
            : durable
          : (inMemory ?? durable)
      if (highWater && compareCommentMutationStamps(mutation.stamp, highWater.stamp) <= 0) {
        return false
      }
    }
    return true
  }

  private recordAcceptedMutation(mutation: NoteCommentMutationRecord): void {
    for (const commentId of mutation.affectedCommentIds) {
      if (!this.acceptedMutations.has(commentId) && this.acceptedMutations.size >= MAX_COMMENT_MUTATION_RECORDS) {
        const oldestCommentId = this.acceptedMutations.keys().next().value as string | undefined
        if (oldestCommentId) {
          this.acceptedMutations.delete(oldestCommentId)
        }
      }
      this.acceptedMutations.set(commentId, {
        ...mutation,
      })
    }
  }

  private getDurableMutations():
    { mutations: NoteCommentMutationRecord[]; clocks: NoteCommentActorClock[] } | undefined {
    try {
      const note = this.application.items.findItem<SNNote>(this.room)
      if (!note || note.locked || !this.application.isAuthorizedToRenderItem(note) || !this.hasExpectedIdentity(note)) {
        return undefined
      }
      const state = readVerifiedCommentMutationState(this.application, this.room, note)
      if (!state) {
        return undefined
      }
      return { mutations: state.mutations, clocks: state.clocks }
    } catch {
      return undefined
    }
  }

  private hasExpectedIdentity(note = this.application.items.findItem<SNNote>(this.room)): boolean {
    try {
      return Boolean(
        note &&
        !note.locked &&
        this.application.isAuthorizedToRenderItem(note) &&
        matchesNoteEncryptionIdentity(this.application, this.expectedIdentity, note),
      )
    } catch {
      return false
    }
  }

  destroy(): void {
    if (this.destroyed) {
      return
    }
    this.destroyed = true
    this.lifecycleGeneration += 1
    this.joiningGeneration = undefined
    this.joined = false
    this.joinRequested = false
    try {
      this.channel.send({ t: 'room-leave', room: this.room, requestId: this.requestId })
    } catch {
      // Offline teardown is best-effort; capability expiry is the backstop.
    }
    try {
      this.unsubscribe?.()
    } catch {
      // A transport cleanup callback must not make component teardown throw.
    }
    this.unsubscribe = null
    try {
      this.unsubscribeStatus?.()
    } catch {
      // A transport cleanup callback must not make component teardown throw.
    }
    this.unsubscribeStatus = null
  }
}
