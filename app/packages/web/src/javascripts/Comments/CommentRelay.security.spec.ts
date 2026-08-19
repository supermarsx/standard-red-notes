import { webcrypto } from 'node:crypto'
import { TextDecoder, TextEncoder } from 'node:util'
import * as RoomCrypto from '@/Components/SuperEditor/Collaboration/RoomCrypto'
import { createGatewayCollabChannel } from '@/Components/SuperEditor/Collaboration/GatewayCollabChannel'
import { getSuperCollaborationAvailability } from '@/Components/SuperEditor/Collaboration/CollaborationAvailability'
import { CommentRelay, MAX_COMMENT_EVENT_PLAINTEXT_BYTES } from './CommentRelay'
import {
  COMMENT_AUTHORSHIP_VERSION,
  COMMENT_MUTATION_AUTHORSHIP_VERSION,
  MAX_COMMENT_MUTATION_AFFECTED_IDS,
  MAX_COMMENT_MUTATION_RECORDS,
  NoteComment,
  NoteCommentActorClocksKey,
  NoteCommentMutationRecord,
  NoteCommentMutationsKey,
  clockProofFromMutation,
} from './comments'
import type { CollabChannel, CollabFrame } from '@/Components/SuperEditor/Collaboration/CollabChannel'
import { resolveNoteEncryptionIdentity } from '@/Components/SuperEditor/Collaboration/CollaborationKeyDerivation'
import { WebCrypto } from '@/Application/Crypto'
import {
  canonicalCommentAuthorshipMessage,
  canonicalCommentMutationAuthorshipMessage,
  canonicalCommentMutationClockMessage,
} from './CommentAuthorship'

jest.mock('@/Components/SuperEditor/Collaboration/GatewayCollabChannel', () => ({
  createGatewayCollabChannel: jest.fn(),
}))

jest.mock('@/Components/SuperEditor/Collaboration/CollaborationAvailability', () => ({
  getSuperCollaborationAvailability: jest.fn(),
}))

jest.mock('@/Application/Crypto', () => {
  const crypto = jest.requireActual<typeof import('node:crypto')>('node:crypto')
  return {
    WebCrypto: {
      sodiumCryptoSignSeedKeypair: () => {
        const pair = crypto.generateKeyPairSync('ed25519')
        return {
          publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
          privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
        }
      },
      sodiumCryptoSign: (message: string, privateKey: string) =>
        crypto
          .sign(
            null,
            Buffer.from(message, 'utf8'),
            crypto.createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' }),
          )
          .toString('base64'),
      sodiumCryptoSignVerify: (message: string, signature: string, publicKey: string) =>
        crypto.verify(
          null,
          Buffer.from(message, 'utf8'),
          crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }),
          Buffer.from(signature, 'base64'),
        ),
    },
  }
})

const mockedAvailability = jest.mocked(getSuperCollaborationAvailability)
const mockedCreateChannel = jest.mocked(createGatewayCollabChannel)

Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: webcrypto,
})
Object.defineProperty(globalThis, 'TextEncoder', {
  configurable: true,
  value: TextEncoder,
})
Object.defineProperty(globalThis, 'TextDecoder', {
  configurable: true,
  value: TextDecoder,
})

const structurallyValidRoomKey = {
  type: 'secret',
  extractable: false,
  algorithm: { name: 'AES-GCM', length: 256 },
  usages: ['encrypt', 'decrypt'],
} as CryptoKey
const protocolVersion = 3 as const
const maxTransferBytes = 4 * 1024 * 1024
const roomEpoch = 'room_epoch_0000000000000001'
const epochAuthorization = (capability: string, epoch = roomEpoch) => ({
  capability,
  roomEpoch: epoch,
  collaborationProtocolVersion: protocolVersion,
})
const defaultSessionUser = { uuid: 'user-1', email: 'alice@example.com' }
const commentSigningPair = WebCrypto.sodiumCryptoSignSeedKeypair('77'.repeat(32))
const defaultCommentId = 'user-1:comment-1'

const signedComment = (
  overrides: Partial<NoteComment> = {},
  pair: typeof commentSigningPair = commentSigningPair,
): NoteComment => {
  const comment: NoteComment = {
    id: defaultCommentId,
    authorUuid: 'user-1',
    authorName: 'Alice',
    text: 'ciphertext only',
    createdAt: new Date().toISOString(),
    ...overrides,
  }
  const message = canonicalCommentAuthorshipMessage('note-uuid', comment)!
  return {
    ...comment,
    authorship: {
      version: COMMENT_AUTHORSHIP_VERSION,
      signingPublicKey: pair.publicKey,
      signature: WebCrypto.sodiumCryptoSign(message, pair.privateKey),
    },
  }
}

const mutation = (
  counter: number,
  operation: NoteCommentMutationRecord['operation'],
  commentId = defaultCommentId,
  affectedCommentIds = [commentId],
  resolved?: boolean,
): NoteCommentMutationRecord => {
  const unsigned: NoteCommentMutationRecord = {
    commentId,
    operation,
    affectedCommentIds,
    stamp: { counter, actorUuid: 'user-1', eventId: `event-${counter}` },
    ...(operation === 'resolve' ? { resolved: resolved ?? false } : {}),
  }
  const message = canonicalCommentMutationAuthorshipMessage('note-uuid', unsigned)!
  const clockMessage = canonicalCommentMutationClockMessage('note-uuid', unsigned)!
  return {
    ...unsigned,
    authorship: {
      version: COMMENT_MUTATION_AUTHORSHIP_VERSION,
      signingPublicKey: commentSigningPair.publicKey,
      signature: WebCrypto.sodiumCryptoSign(message, commentSigningPair.privateKey),
      clockSignature: WebCrypto.sodiumCryptoSign(clockMessage, commentSigningPair.privateKey),
    },
  }
}

const applicationWithDurableMutations = (
  records: NoteCommentMutationRecord[] = [],
  options: {
    authorized?: () => boolean
    present?: () => boolean
    onRead?: () => void
    clocks?: unknown
    sessionUser?: () => typeof defaultSessionUser
  } = {},
) =>
  ({
    items: {
      findItem: () =>
        options.present?.() === false
          ? undefined
          : {
              uuid: 'note-uuid',
              locked: false,
              payload: { content_type: 'Note', content: {} },
              user_uuid: 'user-1',
              key_system_identifier: undefined,
              shared_vault_uuid: undefined,
              getAppDomainValue: (key: unknown) => {
                options.onRead?.()
                return key === NoteCommentMutationsKey
                  ? records
                  : key === NoteCommentActorClocksKey
                    ? options.clocks
                    : undefined
              },
            },
    },
    isAuthorizedToRenderItem: () => options.authorized?.() !== false,
    sessions: {
      getUser: () => options.sessionUser?.() ?? defaultSessionUser,
      isSignedIn: () => true,
      isCurrentSessionReadOnly: () => false,
      getSigningPublicKey: () => commentSigningPair.publicKey,
    },
    vaults: { getItemVault: () => undefined },
    vaultLocks: { getUnlockedVaultRootKey: () => undefined },
    vaultUsers: { isCurrentUserReadonlyVaultMember: () => false },
    encryption: {
      getRootKey: () => ({
        masterKey: 'test-root-key',
        keyVersion: '004',
        keyParams: { getPortableValue: () => ({ version: '004' }) },
        signingKeyPair: commentSigningPair,
      }),
    },
    contacts: { getSelfContact: () => undefined, findContact: () => undefined },
  }) as never

const identityFor = (application: ReturnType<typeof applicationWithDurableMutations>) => {
  const note = (application as never as { items: { findItem(uuid: string): never } }).items.findItem('note-uuid')
  return resolveNoteEncryptionIdentity(application, note)!
}

describe('CommentRelay security boundary', () => {
  it('shares the central fail-closed collaboration gate and never opens a channel', () => {
    mockedAvailability.mockReturnValue({
      available: false,
      reason: 'client-only room key unavailable',
    })

    expect(
      () => new CommentRelay({} as never, 'note-uuid', structurallyValidRoomKey, roomEpoch, 'capability', jest.fn()),
    ).toThrow('client-only room key unavailable')
    expect(mockedCreateChannel).not.toHaveBeenCalled()
  })

  it('rejects a public vault systemIdentifier as key material before opening a channel', () => {
    mockedAvailability.mockReturnValue({ available: true })
    const systemIdentifier = 'public-key-system-identifier'

    expect(
      () =>
        new CommentRelay(
          {} as never,
          'note-uuid',
          systemIdentifier as unknown as CryptoKey,
          roomEpoch,
          'capability',
          jest.fn(),
        ),
    ).toThrow(/non-extractable AES-256-GCM CryptoKey/)
    expect(() => RoomCrypto.createRoomCipher(systemIdentifier as unknown as CryptoKey)).toThrow(
      /non-extractable AES-256-GCM CryptoKey/,
    )
    expect(mockedCreateChannel).not.toHaveBeenCalled()
  })

  it('has no production string-derivation or plaintext cipher fallback', () => {
    expect(RoomCrypto).not.toHaveProperty('deriveRoomKey')
    expect(RoomCrypto).not.toHaveProperty('createPlaintextCipher')
  })

  it('ignores a malformed actor clock without trusting it for replay ordering', () => {
    const relay = Object.create(CommentRelay.prototype) as CommentRelay
    const invalidProof = {
      ...clockProofFromMutation(mutation(1, 'remove', defaultCommentId))!,
      signature: 'invalid-but-bounded-proof',
    }
    const application = applicationWithDurableMutations([], {
      clocks: [{ actorUuid: 'user-1', highWater: invalidProof }],
    })
    Object.assign(relay as object, {
      application,
      room: 'note-uuid',
      expectedIdentity: identityFor(application),
      acceptedMutations: new Map<string, NoteCommentMutationRecord>(),
    })
    const acceptMutation = (
      relay as unknown as { acceptMutation(value: NoteCommentMutationRecord): boolean }
    ).acceptMutation.bind(relay)

    expect(acceptMutation(mutation(2, 'upsert'))).toBe(true)
  })

  it('rejects a replay at or below the compacted signed actor floor after relay recreation', () => {
    const relay = Object.create(CommentRelay.prototype) as CommentRelay
    const floorMutation = mutation(100, 'remove', defaultCommentId)
    const floorProof = clockProofFromMutation(floorMutation)!
    const application = applicationWithDurableMutations([], {
      clocks: [{ actorUuid: 'user-1', highWater: floorProof, replayFloor: floorProof }],
    })
    Object.assign(relay as object, {
      application,
      room: 'note-uuid',
      expectedIdentity: identityFor(application),
      acceptedMutations: new Map<string, NoteCommentMutationRecord>(),
    })
    const acceptMutation = (
      relay as unknown as { acceptMutation(value: NoteCommentMutationRecord): boolean }
    ).acceptMutation.bind(relay)

    expect(acceptMutation(mutation(99, 'upsert', 'user-1:compacted-comment'))).toBe(false)
    expect(acceptMutation(mutation(101, 'upsert', 'user-1:new-comment'))).toBe(true)
  })
})

const hasSubtle = Boolean(globalThis.crypto?.subtle)
const maybe = hasSubtle ? describe : describe.skip

maybe('CommentRelay accepted-join and ciphertext behavior', () => {
  const createChannel = () => {
    const sent: CollabFrame[] = []
    let handler: ((frame: CollabFrame) => void) | undefined
    let statusHandler: ((connected: boolean) => void) | undefined
    let connected = true
    const unsubscribeStatus = jest.fn(() => {
      statusHandler = undefined
    })
    const channel: CollabChannel = {
      isConnected: () => connected,
      authorize: async () => 'unused',
      authorizeEpochBound: async () => undefined,
      send: (frame) => sent.push(frame),
      subscribe: (value) => {
        handler = value
        return () => {
          handler = undefined
        }
      },
      subscribeStatus: (value) => {
        statusHandler = value
        return unsubscribeStatus
      },
    }
    return {
      channel,
      sent,
      inbound: (frame: CollabFrame) => handler?.(frame),
      setConnected: (value: boolean) => {
        connected = value
        statusHandler?.(value)
      },
      unsubscribeStatus,
    }
  }

  it('never emits a comment before its exact authorized join acknowledgement', async () => {
    mockedAvailability.mockReturnValue({ available: true })
    const transport = createChannel()
    mockedCreateChannel.mockReturnValue(transport.channel)
    const key = (await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ])) as CryptoKey
    const onRemoteEvent = jest.fn()
    const relay = new CommentRelay(
      applicationWithDurableMutations(),
      'note-uuid',
      key,
      roomEpoch,
      'exact-note-capability',
      onRemoteEvent,
    )
    const join = transport.sent[0] as Extract<CollabFrame, { t: 'room-join' }>
    expect(join.protocolVersion).toBe(protocolVersion)
    const comment = signedComment()

    await relay.broadcast(comment, mutation(1, 'upsert'))
    transport.inbound({ t: 'room-joined', room: 'note-uuid', requestId: 'spoofed-request' })
    await relay.broadcast(comment, mutation(1, 'upsert'))
    expect(transport.sent.filter((frame) => frame.t === 'comment')).toHaveLength(0)

    transport.inbound({
      t: 'room-joined',
      room: 'note-uuid',
      requestId: join.requestId,
      protocolVersion,
      maxTransferBytes,
      roomEpoch,
    })
    await relay.broadcast(comment, mutation(1, 'upsert'))
    const frame = transport.sent.find((value): value is Extract<CollabFrame, { t: 'comment' }> => value.t === 'comment')

    expect(frame).toBeDefined()
    expect(frame!.payload).not.toContain(comment.text)
    const plaintext = await RoomCrypto.createCollaborationRoomCipher(
      key,
      roomEpoch,
      'receiver_epoch_000000000001',
    ).decrypt(
      frame!.payload,
      new TextEncoder().encode(
        JSON.stringify(['standard-red-notes:collaboration-frame:v3', protocolVersion, 'note-uuid', 'comment-event-v3']),
      ),
    )
    expect(new TextDecoder().decode(plaintext)).toContain('"operation":"upsert"')
    expect(onRemoteEvent).not.toHaveBeenCalled()
    relay.destroy()
  })

  it('never relays an unsigned legacy upsert as authenticated realtime authorship', async () => {
    mockedAvailability.mockReturnValue({ available: true })
    const transport = createChannel()
    mockedCreateChannel.mockReturnValue(transport.channel)
    const key = (await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ])) as CryptoKey
    const relay = new CommentRelay(
      applicationWithDurableMutations(),
      'note-uuid',
      key,
      roomEpoch,
      'capability',
      jest.fn(),
    )
    const join = transport.sent[0] as Extract<CollabFrame, { t: 'room-join' }>
    transport.inbound({
      t: 'room-joined',
      room: 'note-uuid',
      requestId: join.requestId,
      protocolVersion,
      maxTransferBytes,
      roomEpoch,
    })

    const unsigned = { ...signedComment() }
    delete unsigned.authorship
    await relay.broadcastUpsert(unsigned, mutation(1, 'upsert'))

    expect(transport.sent.filter((frame) => frame.t === 'comment')).toHaveLength(0)
    relay.destroy()
  })

  it('rejects v2 and unknown-key v3 upserts before replay-ledger or durable-state reads', async () => {
    mockedAvailability.mockReturnValue({ available: true })
    const transport = createChannel()
    mockedCreateChannel.mockReturnValue(transport.channel)
    const key = (await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ])) as CryptoKey
    const durableRead = jest.fn()
    const delivered = jest.fn()
    const relay = new CommentRelay(
      applicationWithDurableMutations([], { onRead: durableRead }),
      'note-uuid',
      key,
      roomEpoch,
      'capability',
      delivered,
    )
    const join = transport.sent[0] as Extract<CollabFrame, { t: 'room-join' }>
    transport.inbound({
      t: 'room-joined',
      room: 'note-uuid',
      requestId: join.requestId,
      protocolVersion,
      maxTransferBytes,
      roomEpoch,
    })
    const additionalData = new TextEncoder().encode(
      JSON.stringify(['standard-red-notes:collaboration-frame:v3', protocolVersion, 'note-uuid', 'comment-event-v3']),
    )
    const remoteCipher = RoomCrypto.createCollaborationRoomCipher(key, roomEpoch, 'remote_sender_epoch_00000001')
    const valid = signedComment()
    const v2Payload = await remoteCipher.encrypt(
      new TextEncoder().encode(
        JSON.stringify({ version: 2, operation: 'upsert', comment: valid, mutation: mutation(1, 'upsert') }),
      ),
      additionalData,
    )
    transport.inbound({ t: 'comment', room: 'note-uuid', payload: v2Payload })

    const unknownPair = WebCrypto.sodiumCryptoSignSeedKeypair('88'.repeat(32))
    const unknown = signedComment({}, unknownPair)
    const unknownPayload = await remoteCipher.encrypt(
      new TextEncoder().encode(
        JSON.stringify({ version: 3, operation: 'upsert', comment: unknown, mutation: mutation(2, 'upsert') }),
      ),
      additionalData,
    )
    transport.inbound({ t: 'comment', room: 'note-uuid', payload: unknownPayload })
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(durableRead).not.toHaveBeenCalled()
    expect(delivered).not.toHaveBeenCalled()
    relay.destroy()
  })

  it('rejects an oversized plaintext event before encrypting or relaying it', async () => {
    mockedAvailability.mockReturnValue({ available: true })
    const transport = createChannel()
    mockedCreateChannel.mockReturnValue(transport.channel)
    const key = (await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ])) as CryptoKey
    const relay = new CommentRelay(
      applicationWithDurableMutations(),
      'note-uuid',
      key,
      roomEpoch,
      'capability',
      jest.fn(),
    )
    const join = transport.sent[0] as Extract<CollabFrame, { t: 'room-join' }>
    transport.inbound({
      t: 'room-joined',
      room: 'note-uuid',
      requestId: join.requestId,
      protocolVersion,
      maxTransferBytes,
      roomEpoch,
    })

    await relay.broadcastUpsert(
      {
        id: 'comment-1',
        authorUuid: 'user-1',
        authorName: 'Alice',
        text: 'x'.repeat(MAX_COMMENT_EVENT_PLAINTEXT_BYTES),
        createdAt: new Date().toISOString(),
      },
      mutation(1, 'upsert'),
    )

    expect(transport.sent.filter((frame) => frame.t === 'comment')).toHaveLength(0)
    relay.destroy()
  })

  it('rejects an older upsert replay after a remove, including after relay recreation from durable tombstones', async () => {
    mockedAvailability.mockReturnValue({ available: true })
    const senderTransport = createChannel()
    const receiverTransport = createChannel()
    mockedCreateChannel.mockReturnValueOnce(senderTransport.channel).mockReturnValueOnce(receiverTransport.channel)
    const key = (await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ])) as CryptoKey
    const sender = new CommentRelay(
      applicationWithDurableMutations(),
      'note-uuid',
      key,
      roomEpoch,
      'sender-capability',
      jest.fn(),
    )
    const delivered: unknown[] = []
    const receiver = new CommentRelay(
      applicationWithDurableMutations(),
      'note-uuid',
      key,
      roomEpoch,
      'receiver-capability',
      async (event) => {
        delivered.push(event)
        return true
      },
    )
    const senderJoin = senderTransport.sent[0] as Extract<CollabFrame, { t: 'room-join' }>
    const receiverJoin = receiverTransport.sent[0] as Extract<CollabFrame, { t: 'room-join' }>
    senderTransport.inbound({
      t: 'room-joined',
      room: 'note-uuid',
      requestId: senderJoin.requestId,
      protocolVersion,
      maxTransferBytes,
      roomEpoch,
    })
    receiverTransport.inbound({
      t: 'room-joined',
      room: 'note-uuid',
      requestId: receiverJoin.requestId,
      protocolVersion,
      maxTransferBytes,
      roomEpoch,
    })
    const comment = signedComment({ text: 'must stay deleted' })

    await sender.broadcastUpsert(comment, mutation(1, 'upsert'))
    const upsertFrame = senderTransport.sent.find(
      (frame): frame is Extract<CollabFrame, { t: 'comment' }> => frame.t === 'comment',
    )!
    receiverTransport.inbound(upsertFrame)
    await new Promise((resolve) => setTimeout(resolve, 10))

    await sender.broadcastRemove(defaultCommentId, mutation(2, 'remove'))
    const commentFrames = senderTransport.sent.filter(
      (frame): frame is Extract<CollabFrame, { t: 'comment' }> => frame.t === 'comment',
    )
    const removeFrame = commentFrames[1]
    receiverTransport.inbound(removeFrame)
    await new Promise((resolve) => setTimeout(resolve, 10))
    receiverTransport.inbound(upsertFrame)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(delivered).toEqual([
      expect.objectContaining({ version: 3, operation: 'upsert' }),
      expect.objectContaining({ version: 3, operation: 'remove' }),
    ])
    receiver.destroy()

    const recreatedTransport = createChannel()
    mockedCreateChannel.mockReturnValueOnce(recreatedTransport.channel)
    const recreatedDelivery = jest.fn()
    const recreated = new CommentRelay(
      applicationWithDurableMutations([mutation(2, 'remove')]),
      'note-uuid',
      key,
      roomEpoch,
      'recreated-capability',
      recreatedDelivery,
    )
    const recreatedJoin = recreatedTransport.sent[0] as Extract<CollabFrame, { t: 'room-join' }>
    recreatedTransport.inbound({
      t: 'room-joined',
      room: 'note-uuid',
      requestId: recreatedJoin.requestId,
      protocolVersion,
      maxTransferBytes,
      roomEpoch,
    })
    recreatedTransport.inbound(upsertFrame)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(recreatedDelivery).not.toHaveBeenCalled()
    recreated.destroy()
    sender.destroy()
  })

  it('fails closed before reading durable plaintext after authorization loss or authoritative item removal', async () => {
    mockedAvailability.mockReturnValue({ available: true })
    const senderTransport = createChannel()
    const receiverTransport = createChannel()
    mockedCreateChannel.mockReturnValueOnce(senderTransport.channel).mockReturnValueOnce(receiverTransport.channel)
    const key = (await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ])) as CryptoKey
    const sender = new CommentRelay(
      applicationWithDurableMutations(),
      'note-uuid',
      key,
      roomEpoch,
      'sender-capability',
      jest.fn(),
    )
    let authorized = true
    let present = true
    const durableRead = jest.fn()
    const delivered = jest.fn()
    const receiver = new CommentRelay(
      applicationWithDurableMutations([], {
        authorized: () => authorized,
        present: () => present,
        onRead: durableRead,
      }),
      'note-uuid',
      key,
      roomEpoch,
      'receiver-capability',
      delivered,
    )
    const senderJoin = senderTransport.sent[0] as Extract<CollabFrame, { t: 'room-join' }>
    const receiverJoin = receiverTransport.sent[0] as Extract<CollabFrame, { t: 'room-join' }>
    senderTransport.inbound({
      t: 'room-joined',
      room: 'note-uuid',
      requestId: senderJoin.requestId,
      protocolVersion,
      maxTransferBytes,
      roomEpoch,
    })
    receiverTransport.inbound({
      t: 'room-joined',
      room: 'note-uuid',
      requestId: receiverJoin.requestId,
      protocolVersion,
      maxTransferBytes,
      roomEpoch,
    })
    const comment = signedComment({ text: 'protected plaintext' })
    await sender.broadcastUpsert(comment, mutation(1, 'upsert'))
    const frame = senderTransport.sent.find(
      (candidate): candidate is Extract<CollabFrame, { t: 'comment' }> => candidate.t === 'comment',
    )!

    authorized = false
    receiverTransport.inbound(frame)
    await new Promise((resolve) => setTimeout(resolve, 10))
    present = false
    receiverTransport.inbound(frame)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(durableRead).not.toHaveBeenCalled()
    expect(delivered).not.toHaveBeenCalled()
    receiver.destroy()
    sender.destroy()
  })

  it('rejects an authenticated oversized affected-id array without truncation or durable-state work', async () => {
    mockedAvailability.mockReturnValue({ available: true })
    const transport = createChannel()
    mockedCreateChannel.mockReturnValue(transport.channel)
    const key = (await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ])) as CryptoKey
    const durableRead = jest.fn()
    const delivered = jest.fn()
    const relay = new CommentRelay(
      applicationWithDurableMutations([], { onRead: durableRead }),
      'note-uuid',
      key,
      roomEpoch,
      'capability',
      delivered,
    )
    const join = transport.sent[0] as Extract<CollabFrame, { t: 'room-join' }>
    transport.inbound({
      t: 'room-joined',
      room: 'note-uuid',
      requestId: join.requestId,
      protocolVersion,
      maxTransferBytes,
      roomEpoch,
    })
    const oversizedMutation: NoteCommentMutationRecord = {
      commentId: 'comment-0',
      operation: 'remove',
      stamp: { counter: 1, actorUuid: 'user-1', eventId: 'oversized-event' },
      affectedCommentIds: Array.from(
        { length: MAX_COMMENT_MUTATION_AFFECTED_IDS + 1 },
        (_, index) => `comment-${index}`,
      ),
    }
    const payload = await RoomCrypto.createCollaborationRoomCipher(
      key,
      roomEpoch,
      'oversized_sender_epoch_000001',
    ).encrypt(
      new TextEncoder().encode(
        JSON.stringify({ version: 3, operation: 'remove', commentId: 'comment-0', mutation: oversizedMutation }),
      ),
      new TextEncoder().encode(
        JSON.stringify(['standard-red-notes:collaboration-frame:v3', protocolVersion, 'note-uuid', 'comment-event-v3']),
      ),
    )

    transport.inbound({ t: 'comment', room: 'note-uuid', payload })
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(durableRead).not.toHaveBeenCalled()
    expect(delivered).not.toHaveBeenCalled()
    relay.destroy()
  })

  it('keeps the accepted high-water cache strictly bounded during long-lived relay churn', () => {
    const relay = Object.create(CommentRelay.prototype) as CommentRelay
    const acceptedMutations = new Map<string, NoteCommentMutationRecord>()
    Object.assign(relay as object, { acceptedMutations })
    const recordAcceptedMutation = (
      relay as unknown as { recordAcceptedMutation(value: NoteCommentMutationRecord): void }
    ).recordAcceptedMutation.bind(relay)

    for (let index = 0; index < MAX_COMMENT_MUTATION_RECORDS + 100; index += 1) {
      recordAcceptedMutation(mutation(index + 1, 'remove', `comment-${index}`))
    }

    expect(acceptedMutations.size).toBe(MAX_COMMENT_MUTATION_RECORDS)
    expect(acceptedMutations.has('comment-0')).toBe(false)
    expect(acceptedMutations.has(`comment-${MAX_COMMENT_MUTATION_RECORDS + 99}`)).toBe(true)
  })

  it('reauthorizes its stable logical lease after an accepted capability expires', async () => {
    mockedAvailability.mockReturnValue({ available: true })
    const transport = createChannel()
    transport.channel.authorizeEpochBound = jest.fn().mockResolvedValue(epochAuthorization('renewed-capability'))
    mockedCreateChannel.mockReturnValue(transport.channel)
    const key = (await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ])) as CryptoKey
    const relay = new CommentRelay(
      applicationWithDurableMutations(),
      'note-uuid',
      key,
      roomEpoch,
      'initial-capability',
      jest.fn(),
    )
    const firstJoin = transport.sent[0] as Extract<CollabFrame, { t: 'room-join' }>
    transport.inbound({
      t: 'room-joined',
      room: 'note-uuid',
      requestId: firstJoin.requestId,
      protocolVersion,
      maxTransferBytes,
      roomEpoch,
    })

    transport.inbound({ t: 'room-denied', room: 'note-uuid', requestId: firstJoin.requestId })
    await Promise.resolve()
    await Promise.resolve()
    const joins = transport.sent.filter(
      (frame): frame is Extract<CollabFrame, { t: 'room-join' }> => frame.t === 'room-join',
    )

    expect(transport.channel.authorizeEpochBound).toHaveBeenCalledWith('note-uuid', roomEpoch, firstJoin.requestId)
    expect(joins).toHaveLength(2)
    expect(joins[1]).toMatchObject({
      cap: 'renewed-capability',
      requestId: firstJoin.requestId,
    })
    expect(relay.isRoomJoined()).toBe(false)
    relay.destroy()
  })

  it('fails closed across disconnects and performs one fresh request-bound join per reconnect', async () => {
    mockedAvailability.mockReturnValue({ available: true })
    const transport = createChannel()
    transport.channel.authorizeEpochBound = jest
      .fn()
      .mockResolvedValueOnce(epochAuthorization('reconnect-capability-1'))
      .mockResolvedValueOnce(epochAuthorization('reconnect-capability-2'))
    mockedCreateChannel.mockReturnValue(transport.channel)
    const key = (await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ])) as CryptoKey
    const relay = new CommentRelay(
      applicationWithDurableMutations(),
      'note-uuid',
      key,
      roomEpoch,
      'initial-capability',
      jest.fn(),
    )
    const firstJoin = transport.sent[0] as Extract<CollabFrame, { t: 'room-join' }>
    transport.inbound({
      t: 'room-joined',
      room: 'note-uuid',
      requestId: firstJoin.requestId,
      protocolVersion,
      maxTransferBytes,
      roomEpoch,
    })
    expect(relay.isRoomJoined()).toBe(true)

    transport.setConnected(false)
    expect(relay.isRoomJoined()).toBe(false)
    transport.setConnected(true)
    transport.setConnected(true)
    await Promise.resolve()
    await Promise.resolve()

    let joins = transport.sent.filter(
      (frame): frame is Extract<CollabFrame, { t: 'room-join' }> => frame.t === 'room-join',
    )
    expect(transport.channel.authorizeEpochBound).toHaveBeenCalledTimes(1)
    expect(transport.channel.authorizeEpochBound).toHaveBeenLastCalledWith('note-uuid', roomEpoch, firstJoin.requestId)
    expect(joins).toHaveLength(2)
    expect(joins[1]).toMatchObject({ cap: 'reconnect-capability-1', requestId: firstJoin.requestId })

    transport.inbound({
      t: 'room-joined',
      room: 'note-uuid',
      requestId: firstJoin.requestId,
      protocolVersion,
      maxTransferBytes,
      roomEpoch,
    })
    transport.setConnected(false)
    transport.setConnected(false)
    transport.setConnected(true)
    await Promise.resolve()
    await Promise.resolve()

    joins = transport.sent.filter((frame): frame is Extract<CollabFrame, { t: 'room-join' }> => frame.t === 'room-join')
    expect(transport.channel.authorizeEpochBound).toHaveBeenCalledTimes(2)
    expect(joins).toHaveLength(3)
    expect(joins[2]).toMatchObject({ cap: 'reconnect-capability-2', requestId: firstJoin.requestId })
    relay.destroy()
    expect(transport.unsubscribeStatus).toHaveBeenCalledTimes(1)
  })

  it('does not rejoin with an immutable cipher after reconnect authorization rotates the room epoch', async () => {
    mockedAvailability.mockReturnValue({ available: true })
    const transport = createChannel()
    transport.channel.authorizeEpochBound = jest
      .fn()
      .mockResolvedValue(epochAuthorization('rotated-capability', 'room_epoch_0000000000000002'))
    mockedCreateChannel.mockReturnValue(transport.channel)
    const key = (await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ])) as CryptoKey
    const relay = new CommentRelay(
      applicationWithDurableMutations(),
      'note-uuid',
      key,
      roomEpoch,
      'initial-capability',
      jest.fn(),
    )
    const initialJoin = transport.sent[0] as Extract<CollabFrame, { t: 'room-join' }>
    transport.inbound({
      t: 'room-joined',
      room: 'note-uuid',
      requestId: initialJoin.requestId,
      protocolVersion,
      maxTransferBytes,
      roomEpoch,
    })
    expect(relay.isRoomJoined()).toBe(true)

    transport.setConnected(false)
    transport.setConnected(true)
    await Promise.resolve()
    await Promise.resolve()

    expect(transport.channel.authorizeEpochBound).toHaveBeenCalledWith('note-uuid', roomEpoch, initialJoin.requestId)
    expect(transport.sent.filter((frame) => frame.t === 'room-join')).toHaveLength(1)
    expect(relay.isRoomJoined()).toBe(false)
    relay.destroy()
  })

  it('cannot send or rejoin when destroyed during reconnect authorization', async () => {
    mockedAvailability.mockReturnValue({ available: true })
    const transport = createChannel()
    let resolveAuthorization: ((authorization: ReturnType<typeof epochAuthorization>) => void) | undefined
    transport.channel.authorizeEpochBound = jest.fn(
      () =>
        new Promise<ReturnType<typeof epochAuthorization>>((resolve) => {
          resolveAuthorization = resolve
        }),
    )
    mockedCreateChannel.mockReturnValue(transport.channel)
    const key = (await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ])) as CryptoKey
    const relay = new CommentRelay(
      applicationWithDurableMutations(),
      'note-uuid',
      key,
      roomEpoch,
      'initial-capability',
      jest.fn(),
    )
    const initialJoinCount = transport.sent.filter((frame) => frame.t === 'room-join').length

    transport.setConnected(false)
    transport.setConnected(true)
    expect(transport.channel.authorizeEpochBound).toHaveBeenCalledTimes(1)
    relay.destroy()
    resolveAuthorization?.(epochAuthorization('too-late-capability'))
    await Promise.resolve()
    await Promise.resolve()

    expect(transport.sent.filter((frame) => frame.t === 'room-join')).toHaveLength(initialJoinCount)
    expect(relay.isRoomJoined()).toBe(false)
    expect(transport.unsubscribeStatus).toHaveBeenCalledTimes(1)
  })

  it('does not attempt an initial join while offline and disposes its subscription on destroy', async () => {
    mockedAvailability.mockReturnValue({ available: true })
    const unsubscribe = jest.fn()
    const send = jest.fn(() => {
      throw new Error('socket closed')
    })
    const channel: CollabChannel = {
      isConnected: () => false,
      authorize: async () => undefined,
      send,
      subscribe: () => unsubscribe,
    }
    mockedCreateChannel.mockReturnValue(channel)
    const key = (await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ])) as CryptoKey

    const relay = new CommentRelay(
      applicationWithDurableMutations(),
      'note-uuid',
      key,
      roomEpoch,
      'capability',
      jest.fn(),
    )
    expect(send).not.toHaveBeenCalled()
    expect(relay.isRoomJoined()).toBe(false)
    expect(unsubscribe).not.toHaveBeenCalled()
    relay.destroy()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('survives an initial socket send race when status events can drive a fresh authorization', async () => {
    mockedAvailability.mockReturnValue({ available: true })
    const sent: CollabFrame[] = []
    let inbound: ((frame: CollabFrame) => void) | undefined
    let initialSend = true
    const unsubscribeStatus = jest.fn()
    const authorizeEpochBound = jest.fn().mockResolvedValue(epochAuthorization('fresh-capability'))
    const channel: CollabChannel = {
      isConnected: () => true,
      authorize: jest.fn(),
      authorizeEpochBound,
      send: (frame) => {
        if (initialSend) {
          initialSend = false
          throw new Error('socket changed during send')
        }
        sent.push(frame)
      },
      subscribe: (handler) => {
        inbound = handler
        return jest.fn()
      },
      subscribeStatus: () => unsubscribeStatus,
    }
    mockedCreateChannel.mockReturnValue(channel)
    const key = (await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ])) as CryptoKey

    const relay = new CommentRelay(
      applicationWithDurableMutations(),
      'note-uuid',
      key,
      roomEpoch,
      'stale-capability',
      jest.fn(),
    )
    await Promise.resolve()
    await Promise.resolve()
    const rejoin = sent.find((frame): frame is Extract<CollabFrame, { t: 'room-join' }> => frame.t === 'room-join')
    expect(authorizeEpochBound).toHaveBeenCalledWith('note-uuid', roomEpoch, rejoin?.requestId)
    expect(rejoin).toMatchObject({ cap: 'fresh-capability', role: 'comment' })

    inbound?.({
      t: 'room-joined',
      room: 'note-uuid',
      requestId: rejoin!.requestId,
      protocolVersion,
      maxTransferBytes,
      roomEpoch,
    })
    expect(relay.isRoomJoined()).toBe(true)
    relay.destroy()
    expect(unsubscribeStatus).toHaveBeenCalledTimes(1)
  })

  it('subscribes to status before initial send and recovers a close at that exact boundary', async () => {
    mockedAvailability.mockReturnValue({ available: true })
    const order: string[] = []
    const sent: CollabFrame[] = []
    let connected = false
    let status: ((connected: boolean) => void) | undefined
    const channel: CollabChannel = {
      isConnected: () => connected,
      authorize: jest.fn(),
      authorizeEpochBound: jest.fn(async () => {
        order.push('authorize')
        return epochAuthorization('fresh-capability')
      }),
      subscribe: () => jest.fn(),
      subscribeStatus: (handler) => {
        order.push('subscribe-status')
        status = handler
        handler(false)
        return jest.fn()
      },
      send: (frame) => {
        order.push('send')
        sent.push(frame)
      },
    }
    mockedCreateChannel.mockReturnValue(channel)
    const key = (await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ])) as CryptoKey
    const relay = new CommentRelay(
      applicationWithDurableMutations(),
      'note-uuid',
      key,
      roomEpoch,
      'capability-from-closed-generation',
      jest.fn(),
    )

    expect(order).toEqual(['subscribe-status'])
    connected = true
    status?.(true)
    await Promise.resolve()
    await Promise.resolve()

    expect(order).toEqual(['subscribe-status', 'authorize', 'send'])
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ t: 'room-join', cap: 'fresh-capability' })
    relay.destroy()
  })

  it('does not throw from offline leave or subscription cleanup during destroy', async () => {
    mockedAvailability.mockReturnValue({ available: true })
    let teardown = false
    const unsubscribe = jest.fn(() => {
      if (teardown) {
        throw new Error('unsubscribe failed')
      }
    })
    const channel: CollabChannel = {
      isConnected: () => !teardown,
      authorize: async () => undefined,
      send: () => {
        if (teardown) {
          throw new Error('socket closed')
        }
      },
      subscribe: () => unsubscribe,
    }
    mockedCreateChannel.mockReturnValue(channel)
    const key = (await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ])) as CryptoKey
    const relay = new CommentRelay(
      applicationWithDurableMutations(),
      'note-uuid',
      key,
      roomEpoch,
      'capability',
      jest.fn(),
    )

    teardown = true
    expect(() => relay.destroy()).not.toThrow()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(() => relay.destroy()).not.toThrow()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('clears reauthorization state and resolves cleanly when a renewed join send throws', async () => {
    mockedAvailability.mockReturnValue({ available: true })
    let initialJoin = true
    const authorizeEpochBound = jest.fn().mockResolvedValue(epochAuthorization('renewed-capability'))
    const channel: CollabChannel = {
      isConnected: () => true,
      authorize: jest.fn(),
      authorizeEpochBound,
      send: (frame) => {
        if (frame.t === 'room-join') {
          if (!initialJoin) {
            throw new Error('reconnect race')
          }
          initialJoin = false
        }
      },
      subscribe: () => jest.fn(),
    }
    mockedCreateChannel.mockReturnValue(channel)
    const key = (await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ])) as CryptoKey
    const relay = new CommentRelay(
      applicationWithDurableMutations(),
      'note-uuid',
      key,
      roomEpoch,
      'capability',
      jest.fn(),
    )
    const retry = relay as unknown as { reauthorizeAndJoin(): Promise<void> }

    await expect(retry.reauthorizeAndJoin()).resolves.toBeUndefined()
    await expect(retry.reauthorizeAndJoin()).resolves.toBeUndefined()
    expect(authorizeEpochBound).toHaveBeenCalledTimes(2)
    expect(relay.isRoomJoined()).toBe(false)
    relay.destroy()
  })
})
