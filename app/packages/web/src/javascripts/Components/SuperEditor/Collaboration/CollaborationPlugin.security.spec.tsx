/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'

jest.mock('@lexical/react/LexicalCollaborationPlugin', () => ({
  CollaborationPlugin: (props: {
    id: string
    providerFactory: (id: string, docs: Map<string, unknown>) => unknown
  }) => {
    props.providerFactory(props.id, new Map())
    return null
  },
}))

jest.mock('./GatewayCollabChannel', () => ({
  createGatewayCollabChannel: jest.fn(),
}))

jest.mock('./RoomCrypto', () => ({
  createRoomCipher: jest.fn(),
  deriveRoomKey: jest.fn(),
}))

jest.mock('./EncryptedYjsProvider', () => ({
  EncryptedYjsProvider: jest.fn(),
}))

import { EncryptedYjsProvider } from './EncryptedYjsProvider'
import { createGatewayCollabChannel } from './GatewayCollabChannel'
import { createRoomCipher, deriveRoomKey } from './RoomCrypto'
import { getSuperCollaborationAvailability, SUPER_COLLABORATION_UNAVAILABLE_REASON } from './CollaborationAvailability'
import { CollaborationConfig, SuperCollaborationPlugin } from './CollaborationPlugin'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  ;(window as { enableSuperCollaboration?: boolean }).enableSuperCollaboration = true
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  delete (window as { enableSuperCollaboration?: boolean }).enableSuperCollaboration
})

describe('Super collaboration security gate', () => {
  it('stays unavailable when the legacy window flag is forcibly enabled', () => {
    expect(getSuperCollaborationAvailability()).toEqual({
      available: false,
      reason: SUPER_COLLABORATION_UNAVAILABLE_REASON,
    })
  })

  it('does not construct a relay, derive or use a room key, or create a provider', async () => {
    const config: CollaborationConfig = {
      room: 'note-uuid',
      roomKey: {} as CryptoKey,
      username: 'Collaborator',
      cursorColor: '#ff0000',
      shouldBootstrap: true,
    }

    await act(async () => {
      root.render(
        createElement(SuperCollaborationPlugin, {
          application: {} as never,
          config,
        }),
      )
    })

    expect(container.innerHTML).toBe('')
    expect(createGatewayCollabChannel).not.toHaveBeenCalled()
    expect(deriveRoomKey).not.toHaveBeenCalled()
    expect(createRoomCipher).not.toHaveBeenCalled()
    expect(EncryptedYjsProvider).not.toHaveBeenCalled()
  })
})
