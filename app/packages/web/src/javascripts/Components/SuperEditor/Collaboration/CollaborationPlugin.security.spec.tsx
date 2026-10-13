/**
 * @jest-environment jsdom
 */
import { webcrypto } from 'node:crypto'
import { act, createElement, StrictMode } from 'react'
import { createRoot, Root } from 'react-dom/client'

jest.mock('@lexical/react/LexicalComposerContext', () => {
  const editor = {
    getRootElement: () => null,
    registerRootListener: () => () => undefined,
    registerUpdateListener: () => () => undefined,
    registerEditableListener: () => () => undefined,
    isEditable: () => true,
  }
  return { useLexicalComposerContext: () => [editor] }
})
jest.mock('./CollaborationSaverElection', () => ({ installCollaborationSaver: jest.fn() }))

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
  createCollaborationRoomCipher: jest.fn(),
  /**
   * `CollaborationPlugin` imports this too, and the factory used to omit it. With WebCrypto
   * absent the plugin bailed out before reaching it, so the missing export never surfaced; with
   * WebCrypto installed, mounting the plugin threw
   * `getCollaborationReplayLedger is not a function` instead of running any assertion.
   */
  getCollaborationReplayLedger: jest.fn(),
}))

jest.mock('./EncryptedYjsProvider', () => ({
  EncryptedYjsProvider: jest.fn(),
}))

import { EncryptedYjsProvider } from './EncryptedYjsProvider'
import { createGatewayCollabChannel } from './GatewayCollabChannel'
import { createCollaborationRoomCipher, getCollaborationReplayLedger } from './RoomCrypto'
import {
  getSuperCollaborationAvailability,
  SUPER_COLLABORATION_CRYPTO_UNAVAILABLE_REASON,
} from './CollaborationAvailability'
import { CollaborationConfig, SuperCollaborationPlugin } from './CollaborationPlugin'
import { PEER_TYPING_LINGER_MS } from './PeerActivity'
import { PresenceRegistry } from './PresenceRegistry'
import { CollaborativeDocumentRegistry } from './CollaborativeDocumentRegistry'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root
let providerDestroy: jest.Mock
let providerCanonicalReadyListener: ((ready: boolean) => void) | undefined
let providerPeerEditListener: ((clientId: number) => void) | undefined
let awarenessStates: Map<number, Record<string, unknown>>
let awarenessChangeListeners: Set<() => void>
let providerCanonicalReady: boolean
let providerDocument:
  | {
      getText(name: string): { insert(index: number, text: string): void; delete(index: number, length: number): void }
    }
  | undefined
let replayLedger: { scope: string }
let collabChannel: { id: string }
let roomCipher: { id: string }

beforeEach(() => {
  /**
   * Fail closed on WebCrypto instead of opting out of the assertions.
   *
   * Every test below used to begin `if (!globalThis.crypto?.subtle) { return }`, so in any
   * environment without WebCrypto this file — the collaboration security gate — passed having
   * asserted nothing at all. jsdom supplies `crypto.subtle` today, which is exactly why nobody
   * noticed. Installing Node's implementation when it is missing, the pattern already used in
   * `javascripts/Assistant/*.spec.ts`, means the assertions always run and a genuinely broken
   * environment makes this suite red rather than empty.
   */
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  }

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  providerDestroy = jest.fn()
  providerCanonicalReadyListener = undefined
  providerPeerEditListener = undefined
  awarenessStates = new Map()
  awarenessChangeListeners = new Set()
  providerCanonicalReady = false
  providerDocument = undefined
  /**
   * `resetMocks: true` clears factory-level implementations, so set them per test.
   *
   * These three return identifiable objects rather than `undefined` on purpose: the provider
   * assertion below checks that the channel, the cipher and the replay ledger are the ones the
   * plugin was given. With bare `jest.fn()`s they were all `undefined`, and the assertion's
   * `expect.anything()` could never have matched.
   */
  replayLedger = { scope: 'test-ledger' }
  collabChannel = { id: 'test-channel' }
  roomCipher = { id: 'test-cipher' }
  jest.mocked(getCollaborationReplayLedger).mockReturnValue(replayLedger as never)
  jest.mocked(createGatewayCollabChannel).mockReturnValue(collabChannel as never)
  jest.mocked(createCollaborationRoomCipher).mockReturnValue(roomCipher as never)
  jest.mocked(EncryptedYjsProvider).mockImplementation((document) => {
    providerDocument = document as never
    return {
      isCanonicalReady: () => providerCanonicalReady,
      awareness: {
        clientID: 1,
        getStates: () => awarenessStates,
        getLocalState: () => null,
        setLocalStateField: jest.fn(),
        on: jest.fn((_event: string, listener: () => void) => awarenessChangeListeners.add(listener)),
        off: jest.fn((_event: string, listener: () => void) => awarenessChangeListeners.delete(listener)),
      },
      destroy: providerDestroy,
      onPeerEdit: jest.fn((listener: (clientId: number) => void) => {
        providerPeerEditListener = listener
        return () => {
          if (providerPeerEditListener === listener) {
            providerPeerEditListener = undefined
          }
        }
      }),
      onCanonicalReadyChange: jest.fn((listener: (ready: boolean) => void) => {
        providerCanonicalReadyListener = listener
        return () => {
          if (providerCanonicalReadyListener === listener) {
            providerCanonicalReadyListener = undefined
          }
        }
      }),
    } as never
  })
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
  it('ignores the legacy window flag entirely, in both of its settings', () => {
    /**
     * This replaces `expect(availability.available).toBe(Boolean(globalThis.crypto?.subtle))`,
     * which restated the implementation's own condition and so could not fail. It also did not
     * test the half its name claimed: `beforeEach` sets `enableSuperCollaboration = true` and
     * nothing ever set it false, so re-introducing a read of that flag would have kept it green.
     */
    const windowWithFlag = window as { enableSuperCollaboration?: boolean }

    windowWithFlag.enableSuperCollaboration = false
    expect(getSuperCollaborationAvailability()).toEqual({ available: true })

    delete windowWithFlag.enableSuperCollaboration
    expect(getSuperCollaborationAvailability()).toEqual({ available: true })

    windowWithFlag.enableSuperCollaboration = true
    expect(getSuperCollaborationAvailability()).toEqual({ available: true })
  })

  it('refuses collaboration when WebCrypto is absent, naming that as the reason', () => {
    const realCrypto = globalThis.crypto
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined })
    try {
      expect(getSuperCollaborationAvailability()).toEqual({
        available: false,
        reason: SUPER_COLLABORATION_CRYPTO_UNAVAILABLE_REASON,
      })
    } finally {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: realCrypto })
    }
  })

  it('refuses collaboration for a signed-out session or a missing note key, even with WebCrypto present', () => {
    expect(getSuperCollaborationAvailability({ authenticated: false, encryptionKeyAvailable: true })).toMatchObject({
      available: false,
    })
    expect(getSuperCollaborationAvailability({ authenticated: true, encryptionKeyAvailable: false })).toMatchObject({
      available: false,
    })
    expect(getSuperCollaborationAvailability({ authenticated: true, encryptionKeyAvailable: true })).toEqual({
      available: true,
    })
  })

  it('attaches the already-active request lease without replaying activation', async () => {
    const lease = {
      requestId: 'editor-lease',
      shouldBootstrap: true,
      protocolVersion: 3 as const,
      maxTransferBytes: 4 * 1024 * 1024,
      roomEpoch: 'room_epoch_0000000000000001',
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
      roomEpoch: 'room_epoch_0000000000000001',
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

    expect(createGatewayCollabChannel).toHaveBeenCalled()
    /**
     * The room cipher is built from the room key, the epoch, no prior state, and the
     * app-lifetime replay ledger for this room and epoch. The expectation used to name only the
     * first two arguments, which cannot match the four-argument call the plugin makes — it never
     * failed because the assertion was never reached.
     */
    expect(getCollaborationReplayLedger).toHaveBeenCalledWith({}, 'note-uuid', config.roomEpoch)
    expect(createCollaborationRoomCipher).toHaveBeenCalledWith(
      config.roomKey,
      config.roomEpoch,
      undefined,
      replayLedger,
    )
    expect(EncryptedYjsProvider).toHaveBeenCalledWith(
      expect.anything(),
      'note-uuid',
      collabChannel,
      roomCipher,
      undefined,
      'editor-lease',
      {
        activeLease: lease,
        shouldBootstrap: true,
        /** The provider is handed the epoch it must stay pinned to; omitting it would let a stale room bind. */
        expectedRoomEpoch: config.roomEpoch,
        validateAttachment: lease.validateAttachment,
        reactivate: lease.reactivate,
        onFatal: lease.fail,
        onBootstrapRetry: lease.retryBootstrap,
        onPresenceActivity: expect.any(Function),
      },
    )
  })

  it('forwards only the live provider canonical-ready transition and clears it on teardown', async () => {
    const onCanonicalReadyChange = jest.fn()
    const lease = {
      requestId: 'readiness-lease',
      shouldBootstrap: true,
      protocolVersion: 3 as const,
      maxTransferBytes: 4 * 1024 * 1024,
      roomEpoch: 'room_epoch_0000000000000001',
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
            roomEpoch: 'room_epoch_0000000000000001',
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

  it('shows a peer as typing from the edits applied here, and takes it down when they stop', async () => {
    jest.useFakeTimers()
    const room = 'typing-note'
    const lease = {
      requestId: 'typing-lease',
      shouldBootstrap: true,
      protocolVersion: 3 as const,
      maxTransferBytes: 4 * 1024 * 1024,
      roomEpoch: 'room_epoch_0000000000000001',
      release: jest.fn(),
      validateAttachment: jest.fn(() => true),
      isAttached: jest.fn(() => true),
      reactivate: jest.fn(),
      fail: jest.fn(),
      retryBootstrap: jest.fn(),
    }
    const caret = (clock: number) => ({ type: null, tname: 'root', item: { client: 7, clock }, assoc: 0 })
    const announce = () => act(() => awarenessChangeListeners.forEach((listener) => listener()))
    try {
      await act(async () => {
        root.render(
          createElement(SuperCollaborationPlugin, {
            application: {} as never,
            config: {
              room,
              roomKey: {} as CryptoKey,
              roomEpoch: 'room_epoch_0000000000000001',
              editorLease: lease,
              username: 'Alice',
              cursorColor: '#ff0000',
              shouldBootstrap: true,
            },
          }),
        )
      })
      // Precondition: the plugin is listening for applied edits at all.
      expect(providerPeerEditListener).toEqual(expect.any(Function))

      awarenessStates.set(7, {
        name: 'Bob',
        color: '#2563eb',
        focusing: true,
        anchorPos: caret(1),
        focusPos: caret(1),
        awarenessData: { userUuid: 'bob-uuid' },
      })
      announce()
      expect(PresenceRegistry.getPeers(room)).toEqual([
        { clientId: 7, name: 'Bob', color: '#2563eb', userUuid: 'bob-uuid', focusing: true, typing: false },
      ])

      // An edit authored by Bob's Yjs client is applied: he is typing, as of now.
      const startedAt = Date.now()
      act(() => providerPeerEditListener?.(7))
      expect(PresenceRegistry.getPeers(room)).toEqual([
        {
          clientId: 7,
          name: 'Bob',
          color: '#2563eb',
          userUuid: 'bob-uuid',
          focusing: true,
          typing: true,
          lastActiveAt: startedAt,
        },
      ])

      // Nothing arrives to say he stopped. The registry must say so by itself.
      act(() => {
        jest.advanceTimersByTime(PEER_TYPING_LINGER_MS)
      })
      expect(PresenceRegistry.getPeers(room)[0]).toMatchObject({ typing: false, lastActiveAt: startedAt })

      // Moving the caret is activity, and is not typing; leaving the editor clears `focusing`.
      act(() => {
        jest.advanceTimersByTime(5_000)
      })
      awarenessStates.set(7, { ...awarenessStates.get(7), anchorPos: caret(9), focusPos: caret(9), focusing: false })
      announce()
      expect(PresenceRegistry.getPeers(room)[0]).toMatchObject({
        typing: false,
        focusing: false,
        lastActiveAt: startedAt + PEER_TYPING_LINGER_MS + 5_000,
      })

      act(() => root.unmount())
      expect(PresenceRegistry.getPeers(room)).toEqual([])
      expect(providerPeerEditListener).toBeUndefined()
    } finally {
      jest.useRealTimers()
    }
  })

  it('registers its live document so a stored revision can be told from the document, and withdraws it', async () => {
    const room = 'registered-note'
    const lease = {
      requestId: 'registry-lease',
      shouldBootstrap: true,
      protocolVersion: 3 as const,
      maxTransferBytes: 4 * 1024 * 1024,
      roomEpoch: 'room_epoch_0000000000000007',
      release: jest.fn(),
      validateAttachment: jest.fn(() => true),
      isAttached: jest.fn(() => true),
      reactivate: jest.fn(),
      fail: jest.fn(),
      retryBootstrap: jest.fn(),
    }
    expect(CollaborativeDocumentRegistry.get(room)).toBeUndefined()

    await act(async () => {
      root.render(
        createElement(SuperCollaborationPlugin, {
          application: {} as never,
          config: {
            room,
            roomKey: {} as CryptoKey,
            roomEpoch: lease.roomEpoch,
            editorLease: lease,
            username: 'Alice',
            cursorColor: '#ff0000',
            shouldBootstrap: true,
          },
        }),
      )
    })

    const registered = CollaborativeDocumentRegistry.get(room)
    expect(registered?.epoch).toBe(lease.roomEpoch)
    // A document that has not established its state says nothing about what it contains.
    expect(registered?.state()).toBeUndefined()
    expect(registered?.retainedState?.()).toBeUndefined()

    providerCanonicalReady = true
    const updates = jest.fn()
    const stopListening = registered?.subscribe(updates)
    act(() => providerDocument?.getText('probe').insert(0, 'four'))
    // It is the provider's own document: an edit shows up in its state and reaches a subscriber.
    expect([...(registered?.state()?.stateVector ?? new Map()).values()]).toEqual([4])
    expect(registered?.state()?.deleted.size).toBe(0)
    providerCanonicalReady = false
    expect(registered?.state()).toBeUndefined()
    expect([...(registered?.retainedState?.()?.stateVector ?? new Map()).values()]).toEqual([4])
    providerCanonicalReady = true
    expect(updates).toHaveBeenCalledTimes(1)
    stopListening?.()
    act(() => providerDocument?.getText('probe').insert(0, 'more'))
    expect(updates).toHaveBeenCalledTimes(1)
    // ...and so does a deletion, which the vector alone would not show.
    act(() => providerDocument?.getText('probe').delete(0, 3))
    expect([...(registered?.state()?.stateVector ?? new Map()).values()]).toEqual([8])
    expect([...(registered?.state()?.deleted ?? new Map()).values()]).toEqual([[[4, 3]]])

    act(() => root.unmount())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(CollaborativeDocumentRegistry.get(room)).toBeUndefined()
  })

  it('cancels terminal destroy during StrictMode replay and destroys exactly once on genuine unmount', async () => {
    const lease = {
      requestId: 'strict-lifetime-lease',
      shouldBootstrap: true,
      protocolVersion: 3 as const,
      maxTransferBytes: 4 * 1024 * 1024,
      roomEpoch: 'room_epoch_0000000000000001',
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
      roomEpoch: 'room_epoch_0000000000000001',
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
