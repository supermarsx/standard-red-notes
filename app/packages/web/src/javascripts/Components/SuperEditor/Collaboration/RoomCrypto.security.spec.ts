import { webcrypto } from 'node:crypto'
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'node:util'
import {
  CollaborationCipherError,
  createCollaborationReplayLedger,
  createCollaborationRoomCipher,
  createRoomCipher,
  type RoomCipher,
} from './RoomCrypto'

Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: NodeTextEncoder })
Object.defineProperty(globalThis, 'TextDecoder', { configurable: true, value: NodeTextDecoder })

const ROOM_EPOCH = 'room_epoch_0000000000000001'
const OTHER_ROOM_EPOCH = 'room_epoch_0000000000000002'
const SENDER_A = 'sender_epoch_A_000000000001'
const SENDER_B = 'sender_epoch_B_000000000001'
const RECEIVER = 'receiver_epoch_000000000001'
const encoder = new TextEncoder()

async function roomKey(): Promise<CryptoKey> {
  return globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]) as Promise<CryptoKey>
}

function collaborationCipher(key: CryptoKey, senderEpoch: string, roomEpoch = ROOM_EPOCH): RoomCipher {
  return createCollaborationRoomCipher(key, roomEpoch, senderEpoch)
}

const hasSubtle = Boolean(globalThis.crypto?.subtle)
const maybeDescribe = hasSubtle ? describe : describe.skip

maybeDescribe('collaboration room cipher security envelope', () => {
  it('binds ciphertext to the negotiated room epoch and caller room metadata', async () => {
    const key = await roomKey()
    const sender = collaborationCipher(key, SENDER_A)
    const receiver = collaborationCipher(key, RECEIVER)
    const wrongEpochReceiver = collaborationCipher(key, RECEIVER, OTHER_ROOM_EPOCH)
    const plaintext = encoder.encode('room-bound secret')
    const roomA = encoder.encode('srn-collab|v3|room-a|yjs')
    const roomB = encoder.encode('srn-collab|v3|room-b|yjs')
    const payload = await sender.encrypt(plaintext, roomA)

    await expect(wrongEpochReceiver.decrypt(payload, roomA)).rejects.toMatchObject({ code: 'EPOCH_MISMATCH' })
    await expect(receiver.decrypt(payload, roomB)).rejects.toBeDefined()
    await expect(receiver.decrypt(payload, roomA)).resolves.toEqual(plaintext)
  })

  it('accepts a sender restart only under a fresh authenticated sender epoch', async () => {
    const key = await roomKey()
    const firstSender = collaborationCipher(key, SENDER_A)
    const restartedSender = collaborationCipher(key, SENDER_B)
    const receiver = collaborationCipher(key, RECEIVER)
    const metadata = encoder.encode('room|awareness')
    const beforeRestart = await firstSender.encrypt(encoder.encode('before restart'), metadata)
    const afterRestart = await restartedSender.encrypt(encoder.encode('after restart'), metadata)

    await expect(receiver.decrypt(beforeRestart, metadata)).resolves.toEqual(encoder.encode('before restart'))
    await expect(receiver.decrypt(afterRestart, metadata)).resolves.toEqual(encoder.encode('after restart'))
    await expect(receiver.decrypt(beforeRestart, metadata)).rejects.toMatchObject({ code: 'REPLAYED' })
  })

  it('accepts authenticated frames that finish out of order inside the replay window', async () => {
    const key = await roomKey()
    const sender = collaborationCipher(key, SENDER_A)
    const receiver = collaborationCipher(key, RECEIVER)
    const metadata = encoder.encode('room|chunk')
    const payloads = await Promise.all(
      ['one', 'two', 'three'].map((value) => sender.encrypt(encoder.encode(value), metadata)),
    )

    await expect(receiver.decrypt(payloads[2], metadata)).resolves.toEqual(encoder.encode('three'))
    await expect(receiver.decrypt(payloads[0], metadata)).resolves.toEqual(encoder.encode('one'))
    await expect(receiver.decrypt(payloads[1], metadata)).resolves.toEqual(encoder.encode('two'))
  })

  it('rejects sequential and concurrent duplicate delivery before a second apply', async () => {
    const key = await roomKey()
    const sender = collaborationCipher(key, SENDER_A)
    const receiver = collaborationCipher(key, RECEIVER)
    const metadata = encoder.encode('room|yjs')
    const first = await sender.encrypt(encoder.encode('first'), metadata)

    await receiver.decrypt(first, metadata)
    await expect(receiver.decrypt(first, metadata)).rejects.toMatchObject({ code: 'REPLAYED' })

    const second = await sender.encrypt(encoder.encode('second'), metadata)
    const concurrent = await Promise.allSettled([
      receiver.decrypt(second, metadata),
      receiver.decrypt(second, metadata),
    ])
    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(concurrent.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect((concurrent.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({
      code: 'REPLAYED',
    })
  })

  it('retains replay rejection when a cipher is recreated in the same room-key epoch', async () => {
    const key = await roomKey()
    const sender = collaborationCipher(key, SENDER_A)
    const replayLedger = createCollaborationReplayLedger()
    const firstReceiver = createCollaborationRoomCipher(key, ROOM_EPOCH, RECEIVER, replayLedger)
    const payload = await sender.encrypt(encoder.encode('apply exactly once'))

    await expect(firstReceiver.decrypt(payload)).resolves.toEqual(encoder.encode('apply exactly once'))

    const recreatedReceiver = createCollaborationRoomCipher(key, ROOM_EPOCH, RECEIVER, replayLedger)
    await expect(recreatedReceiver.decrypt(payload)).rejects.toMatchObject({ code: 'REPLAYED' })
  })

  it('rejects legacy raw AES-GCM payloads without compatibility fallback', async () => {
    const key = await roomKey()
    const legacy = await createRoomCipher(key).encrypt(encoder.encode('legacy plaintext'))
    const receiver = collaborationCipher(key, RECEIVER)

    await expect(receiver.decrypt(legacy)).rejects.toEqual(new CollaborationCipherError('INVALID_ENVELOPE'))
  })

  it('never exposes plaintext in the opaque payload or rejection error', async () => {
    const key = await roomKey()
    const sender = collaborationCipher(key, SENDER_A)
    const receiver = collaborationCipher(key, RECEIVER)
    const secret = 'plain-text-secret-that-must-never-leak'
    const payload = await sender.encrypt(encoder.encode(secret), encoder.encode('room|yjs'))

    expect(payload).toMatch(/^srn-collab-e1\./u)
    expect(payload).not.toContain(secret)
    let rejection: unknown
    try {
      await receiver.decrypt(payload, encoder.encode('wrong-room|yjs'))
    } catch (error) {
      rejection = error
    }
    expect(String(rejection)).not.toContain(secret)
  })
})
