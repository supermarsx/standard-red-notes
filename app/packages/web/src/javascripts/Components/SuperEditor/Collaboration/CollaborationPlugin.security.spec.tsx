/**
 * @jest-environment jsdom
 */
import { act, createElement, StrictMode } from 'react'
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
let providerDestroy: jest.Mock
let providerCanonicalReadyListener: ((ready: boolean) => void) | undefined

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  providerDestroy = jest.fn()
  providerCanonicalReadyListener = undefined
  jest.mocked(EncryptedYjsProvider).mockImplementation(
    () =>
      ({
        awareness: {
          clientID: 1,
          getStates: () => new Map(),
          on: jest.fn(),
          off: jest.fn(),
        },
        destroy: providerDestroy,
        onCanonicalReadyChange: jest.fn((listener: (ready: boolean) => void) => {
          providerCanonicalReadyListener = listener
          return () => {
            if (providerCanonicalReadyListener === listener) {
              providerCanonicalReadyListener = undefined
            }
          }
        }),
      }) as never,
  )
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

  it('attaches the already-active request lease without replaying activation', async () => {
    const lease = {
      requestId: 'editor-lease',
      shouldBootstrap: true,
      protocolVersion: 2 as const,
      maxTransferBytes: 4 * 1024 * 1024,
      release: jest.fn(),
      validateAttachment: jest.fn(() => true),
      isAttached: jest.fn(() => true),
      reactivate: jest.fn(),
      fail: jest.fn(),
      retryBootstrap: jest.fn(),
    }
    const config: CollaborationConfig = {
      room: 'note-uuid',
      roomKey: {} as CryptoKey,
      editorLease: lease,
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
        undefined,
        'editor-lease',
        {
          activeLease: lease,
          shouldBootstrap: true,
          validateAttachment: lease.validateAttachment,
          reactivate: lease.reactivate,
          onFatal: lease.fail,
          onBootstrapRetry: lease.retryBootstrap,
        },
      )
    } else {
      expect(EncryptedYjsProvider).not.toHaveBeenCalled()
    }
  })

  it('forwards only the live provider canonical-ready transition and clears it on teardown', async () => {
    if (!globalThis.crypto?.subtle) {
      return
    }
    const onCanonicalReadyChange = jest.fn()
    const lease = {
      requestId: 'readiness-lease',
      shouldBootstrap: true,
      protocolVersion: 2 as const,
      maxTransferBytes: 4 * 1024 * 1024,
      release: jest.fn(),
      validateAttachment: jest.fn(() => true),
      isAttached: jest.fn(() => true),
      reactivate: jest.fn(),
      fail: jest.fn(),
      retryBootstrap: jest.fn(),
    }

    await act(async () => {
      root.render(
        createElement(SuperCollaborationPlugin, {
          application: {} as never,
          config: {
            room: 'readiness-note',
            roomKey: {} as CryptoKey,
            editorLease: lease,
            username: 'Collaborator',
            cursorColor: '#ff0000',
            shouldBootstrap: true,
          },
          onCanonicalReadyChange,
        }),
      )
    })

    act(() => providerCanonicalReadyListener?.(true))
    expect(onCanonicalReadyChange).toHaveBeenCalledWith(true)

    act(() => root.unmount())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(onCanonicalReadyChange).toHaveBeenLastCalledWith(false)
  })

  it('cancels terminal destroy during StrictMode replay and destroys exactly once on genuine unmount', async () => {
    if (!globalThis.crypto?.subtle) {
      return
    }
    const lease = {
      requestId: 'strict-lifetime-lease',
      shouldBootstrap: true,
      protocolVersion: 2 as const,
      maxTransferBytes: 4 * 1024 * 1024,
      release: jest.fn(),
      validateAttachment: jest.fn(() => true),
      isAttached: jest.fn(() => true),
      reactivate: jest.fn(),
      fail: jest.fn(),
      retryBootstrap: jest.fn(),
    }
    const config: CollaborationConfig = {
      room: 'strict-note',
      roomKey: {} as CryptoKey,
      editorLease: lease,
      username: 'Collaborator',
      cursorColor: '#ff0000',
      shouldBootstrap: true,
    }

    await act(async () => {
      root.render(
        createElement(StrictMode, null, createElement(SuperCollaborationPlugin, { application: {} as never, config })),
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(providerDestroy).not.toHaveBeenCalled()

    act(() => root.unmount())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(providerDestroy).toHaveBeenCalledTimes(1)
  })
})
