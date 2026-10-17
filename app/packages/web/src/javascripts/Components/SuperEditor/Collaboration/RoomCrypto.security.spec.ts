import { webcrypto } from 'node:crypto'
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'node:util'
import {
  CollaborationCipherError,
  MAX_COLLABORATION_SENDER_EPOCHS,
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

  it('delivers one authenticated broadcast to every live cipher while rejecting replays and later remounts', async () => {
    const key = await roomKey()
    const sender = collaborationCipher(key, SENDER_A)
    const ledger = createCollaborationReplayLedger()
    const first = createCollaborationRoomCipher(key, ROOM_EPOCH, RECEIVER, ledger)
    const second = createCollaborationRoomCipher(key, ROOM_EPOCH, SENDER_B, ledger)
    const text = encoder.encode('one broadcast, two editors')
    const payload = await sender.encrypt(text)
    await expect(Promise.all([first.decrypt(payload), second.decrypt(payload)])).resolves.toEqual([text, text])
    await expect(first.decrypt(payload)).rejects.toMatchObject({ code: 'REPLAYED' })
    await expect(second.decrypt(payload)).rejects.toMatchObject({ code: 'REPLAYED' })
    const remounted = createCollaborationRoomCipher(key, ROOM_EPOCH, RECEIVER, ledger)
    await expect(remounted.decrypt(payload)).rejects.toMatchObject({ code: 'REPLAYED' })
  })

  it('distinguishes a same-epoch sender echo from a foreign room epoch without decrypting either', async () => {
    const key = await roomKey()
    const sender = collaborationCipher(key, SENDER_A)
    const payload = await sender.encrypt(encoder.encode('own update'))
    await expect(sender.decrypt(payload)).rejects.toMatchObject({ code: 'SELF_FRAME' })
    const foreignRoom = collaborationCipher(key, SENDER_A, OTHER_ROOM_EPOCH)
    await expect(foreignRoom.decrypt(payload)).rejects.toMatchObject({ code: 'EPOCH_MISMATCH' })
  })

  it('fences a remount against a decrypt already pending in the old cipher', async () => {
    const key = await roomKey()
    const sender = collaborationCipher(key, SENDER_A)
    const ledger = createCollaborationReplayLedger()
    const first = createCollaborationRoomCipher(key, ROOM_EPOCH, RECEIVER, ledger)
    const text = encoder.encode('pending authenticated state')
    const payload = await sender.encrypt(text)
    const pending = first.decrypt(payload)
    const remounted = createCollaborationRoomCipher(key, ROOM_EPOCH, SENDER_B, ledger)
    await expect(remounted.decrypt(payload)).rejects.toMatchObject({ code: 'REPLAYED' })
    await expect(pending).resolves.toEqual(text)
    await expect(remounted.decrypt(payload)).rejects.toMatchObject({ code: 'REPLAYED' })
  })

  it('does not poison a remounted cipher when the inherited pending decrypt fails authentication', async () => {
    const key = await roomKey()
    const sender = collaborationCipher(key, SENDER_A)
    const ledger = createCollaborationReplayLedger()
    const first = createCollaborationRoomCipher(key, ROOM_EPOCH, RECEIVER, ledger)
    const text = encoder.encode('authenticated state')
    const metadata = encoder.encode('correct metadata')
    const payload = await sender.encrypt(text, metadata)
    const pending = first.decrypt(payload, encoder.encode('incorrect metadata'))
    const remounted = createCollaborationRoomCipher(key, ROOM_EPOCH, SENDER_B, ledger)
    await expect(pending).rejects.toBeDefined()
    await expect(remounted.decrypt(payload, metadata)).resolves.toEqual(text)
  })

  it('keeps each live receiver window independent of a faster sibling', () => {
    const ledger = createCollaborationReplayLedger()
    const first = ledger.createReceiver()
    const slow = ledger.createReceiver()
    const pending = slow.reserve(SENDER_A, 1)
    first.commit(SENDER_A, 5000)
    expect(() => slow.commit(SENDER_A, 1)).not.toThrow()
    slow.release(pending)
    expect(() => slow.reserve(SENDER_A, 1)).toThrow()
    expect(() => ledger.createReceiver().reserve(SENDER_A, 1)).toThrow()
  })

  it('enforces the sender limit across all live receivers together', () => {
    const ledger = createCollaborationReplayLedger()
    const first = ledger.createReceiver()
    const second = ledger.createReceiver()
    for (let index = 0; index < MAX_COLLABORATION_SENDER_EPOCHS; index += 1) {
      const receiver = index % 2 === 0 ? first : second
      receiver.commit(`sender_epoch_${index}`, 1)
    }
    expect(() => first.commit('one_sender_too_many', 1)).toThrow(new CollaborationCipherError('SENDER_LIMIT'))
    expect(() => second.commit('one_sender_too_many', 1)).toThrow(new CollaborationCipherError('SENDER_LIMIT'))
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
