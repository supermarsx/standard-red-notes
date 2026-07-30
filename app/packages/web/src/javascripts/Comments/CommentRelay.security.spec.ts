import { webcrypto } from 'node:crypto'
import { TextDecoder, TextEncoder } from 'node:util'
import * as RoomCrypto from '@/Components/SuperEditor/Collaboration/RoomCrypto'
import { createGatewayCollabChannel } from '@/Components/SuperEditor/Collaboration/GatewayCollabChannel'
import { getSuperCollaborationAvailability } from '@/Components/SuperEditor/Collaboration/CollaborationAvailability'
import { CommentRelay } from './CommentRelay'
import type { CollabChannel, CollabFrame } from '@/Components/SuperEditor/Collaboration/CollabChannel'

jest.mock('@/Components/SuperEditor/Collaboration/GatewayCollabChannel', () => ({
  createGatewayCollabChannel: jest.fn(),
}))

jest.mock('@/Components/SuperEditor/Collaboration/CollaborationAvailability', () => ({
  getSuperCollaborationAvailability: jest.fn(),
}))

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

describe('CommentRelay security boundary', () => {
  it('shares the central fail-closed collaboration gate and never opens a channel', () => {
    mockedAvailability.mockReturnValue({
      available: false,
      reason: 'client-only room key unavailable',
    })

    expect(() => new CommentRelay({} as never, 'note-uuid', structurallyValidRoomKey, 'capability', jest.fn())).toThrow(
      'client-only room key unavailable',
    )
    expect(mockedCreateChannel).not.toHaveBeenCalled()
  })

  it('rejects a public vault systemIdentifier as key material before opening a channel', () => {
    mockedAvailability.mockReturnValue({ available: true })
    const systemIdentifier = 'public-key-system-identifier'

    expect(
      () =>
        new CommentRelay({} as never, 'note-uuid', systemIdentifier as unknown as CryptoKey, 'capability', jest.fn()),
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
})

const hasSubtle = Boolean(globalThis.crypto?.subtle)
const maybe = hasSubtle ? describe : describe.skip

maybe('CommentRelay accepted-join and ciphertext behavior', () => {
  const createChannel = () => {
    const sent: CollabFrame[] = []
    let handler: ((frame: CollabFrame) => void) | undefined
    const channel: CollabChannel = {
      isConnected: () => true,
      authorize: async () => 'unused',
      send: (frame) => sent.push(frame),
      subscribe: (value) => {
        handler = value
        return () => {
          handler = undefined
        }
      },
    }
    return { channel, sent, inbound: (frame: CollabFrame) => handler?.(frame) }
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
    const relay = new CommentRelay({} as never, 'note-uuid', key, 'exact-note-capability', onRemoteEvent)
    const join = transport.sent[0] as Extract<CollabFrame, { t: 'room-join' }>
    const comment = {
      id: 'comment-1',
      authorUuid: 'user-1',
      authorName: 'Alice',
      text: 'ciphertext only',
      createdAt: new Date().toISOString(),
    }

    await relay.broadcast(comment)
    transport.inbound({ t: 'room-joined', room: 'note-uuid', requestId: 'spoofed-request' })
    await relay.broadcast(comment)
    expect(transport.sent.filter((frame) => frame.t === 'comment')).toHaveLength(0)

    transport.inbound({ t: 'room-joined', room: 'note-uuid', requestId: join.requestId })
    await relay.broadcast(comment)
    const frame = transport.sent.find((value): value is Extract<CollabFrame, { t: 'comment' }> => value.t === 'comment')

    expect(frame).toBeDefined()
    expect(frame!.payload).not.toContain(comment.text)
    const plaintext = await RoomCrypto.createRoomCipher(key).decrypt(frame!.payload)
    expect(new TextDecoder().decode(plaintext)).toContain('"operation":"upsert"')
    transport.inbound(frame!)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(onRemoteEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'upsert',
        comment: expect.objectContaining({ id: 'comment-1', text: 'ciphertext only' }),
      }),
    )
    relay.destroy()
  })

  it('reauthorizes its stable logical lease after an accepted capability expires', async () => {
    mockedAvailability.mockReturnValue({ available: true })
    const transport = createChannel()
    transport.channel.authorize = jest.fn().mockResolvedValue('renewed-capability')
    mockedCreateChannel.mockReturnValue(transport.channel)
    const key = (await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ])) as CryptoKey
    const relay = new CommentRelay({} as never, 'note-uuid', key, 'initial-capability', jest.fn())
    const firstJoin = transport.sent[0] as Extract<CollabFrame, { t: 'room-join' }>
    transport.inbound({ t: 'room-joined', room: 'note-uuid', requestId: firstJoin.requestId })

    transport.inbound({ t: 'room-denied', room: 'note-uuid', requestId: firstJoin.requestId })
    await Promise.resolve()
    await Promise.resolve()
    const joins = transport.sent.filter(
      (frame): frame is Extract<CollabFrame, { t: 'room-join' }> => frame.t === 'room-join',
    )

    expect(transport.channel.authorize).toHaveBeenCalledWith('note-uuid')
    expect(joins).toHaveLength(2)
    expect(joins[1]).toMatchObject({
      cap: 'renewed-capability',
      requestId: firstJoin.requestId,
    })
    expect(relay.isRoomJoined()).toBe(false)
    relay.destroy()
  })

  it('disposes its subscription when the initial join send throws', async () => {
    mockedAvailability.mockReturnValue({ available: true })
    const unsubscribe = jest.fn()
    const channel: CollabChannel = {
      isConnected: () => false,
      authorize: async () => undefined,
      send: () => {
        throw new Error('socket closed')
      },
      subscribe: () => unsubscribe,
    }
    mockedCreateChannel.mockReturnValue(channel)
    const key = (await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ])) as CryptoKey

    expect(() => new CommentRelay({} as never, 'note-uuid', key, 'capability', jest.fn())).toThrow('socket closed')
    expect(unsubscribe).toHaveBeenCalledTimes(1)
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
    const relay = new CommentRelay({} as never, 'note-uuid', key, 'capability', jest.fn())

    teardown = true
    expect(() => relay.destroy()).not.toThrow()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(() => relay.destroy()).not.toThrow()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('clears reauthorization state and resolves cleanly when a renewed join send throws', async () => {
    mockedAvailability.mockReturnValue({ available: true })
    let initialJoin = true
    const authorize = jest.fn().mockResolvedValue('renewed-capability')
    const channel: CollabChannel = {
      isConnected: () => true,
      authorize,
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
    const relay = new CommentRelay({} as never, 'note-uuid', key, 'capability', jest.fn())
    const retry = relay as unknown as { reauthorizeAndJoin(): Promise<void> }

    await expect(retry.reauthorizeAndJoin()).resolves.toBeUndefined()
    await expect(retry.reauthorizeAndJoin()).resolves.toBeUndefined()
    expect(authorize).toHaveBeenCalledTimes(2)
    expect(relay.isRoomJoined()).toBe(false)
    relay.destroy()
  })
})
