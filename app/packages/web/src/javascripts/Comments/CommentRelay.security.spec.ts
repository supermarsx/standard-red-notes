import * as RoomCrypto from '@/Components/SuperEditor/Collaboration/RoomCrypto'
import { createGatewayCollabChannel } from '@/Components/SuperEditor/Collaboration/GatewayCollabChannel'
import { getSuperCollaborationAvailability } from '@/Components/SuperEditor/Collaboration/CollaborationAvailability'
import { CommentRelay } from './CommentRelay'

jest.mock('@/Components/SuperEditor/Collaboration/GatewayCollabChannel', () => ({
  createGatewayCollabChannel: jest.fn(),
}))

jest.mock('@/Components/SuperEditor/Collaboration/CollaborationAvailability', () => ({
  getSuperCollaborationAvailability: jest.fn(),
}))

const mockedAvailability = jest.mocked(getSuperCollaborationAvailability)
const mockedCreateChannel = jest.mocked(createGatewayCollabChannel)

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

    expect(() => new CommentRelay({} as never, 'note-uuid', structurallyValidRoomKey, jest.fn())).toThrow(
      'client-only room key unavailable',
    )
    expect(mockedCreateChannel).not.toHaveBeenCalled()
  })

  it('rejects a public vault systemIdentifier as key material before opening a channel', () => {
    mockedAvailability.mockReturnValue({ available: true })
    const systemIdentifier = 'public-key-system-identifier'

    expect(
      () => new CommentRelay({} as never, 'note-uuid', systemIdentifier as unknown as CryptoKey, jest.fn()),
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
