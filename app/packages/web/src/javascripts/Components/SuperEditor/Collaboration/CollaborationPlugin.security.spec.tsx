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
}))

jest.mock('./EncryptedYjsProvider', () => ({
  EncryptedYjsProvider: jest.fn(),
}))

import { EncryptedYjsProvider } from './EncryptedYjsProvider'
import { createGatewayCollabChannel } from './GatewayCollabChannel'
import { createRoomCipher } from './RoomCrypto'
import { getSuperCollaborationAvailability } from './CollaborationAvailability'
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
  it('depends on WebCrypto capability, never the legacy window flag', () => {
    expect(getSuperCollaborationAvailability().available).toBe(Boolean(globalThis.crypto?.subtle))
  })

  it('threads the prepared exact-note capability into the encrypted provider', async () => {
    const config: CollaborationConfig = {
      room: 'note-uuid',
      roomKey: {} as CryptoKey,
      capability: 'exact-note-capability',
      leaseRequestId: 'editor-lease',
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

    if (globalThis.crypto?.subtle) {
      expect(createGatewayCollabChannel).toHaveBeenCalled()
      expect(createRoomCipher).toHaveBeenCalledWith(config.roomKey)
      expect(EncryptedYjsProvider).toHaveBeenCalledWith(
        expect.anything(),
        'note-uuid',
        expect.anything(),
        expect.anything(),
        'exact-note-capability',
        'editor-lease',
      )
    } else {
      expect(EncryptedYjsProvider).not.toHaveBeenCalled()
    }
  })
})
