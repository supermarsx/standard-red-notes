/**
 * @jest-environment jsdom
 */
import { webcrypto } from 'node:crypto'
import { act, createElement, startTransition, StrictMode, Suspense } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { ApplicationEvent, WebSocketsServiceEvent } from '@standardnotes/snjs'
import { prepareCollaborationAccess, resolveCollaborationKeySource } from './CollaborationKeyDerivation'
import { createGatewayCollabChannel } from './GatewayCollabChannel'
import type { CollabFrame } from './CollabChannel'
import {
  beginEditorLeaseReservation,
  prepareSynchronizedEditorAccess,
  useCollaborationRoomAccess,
} from './useCollaborationRoomAccess'

jest.mock('./CollaborationKeyDerivation', () => ({
  prepareCollaborationAccess: jest.fn(),
  resolveCollaborationKeySource: jest.fn(),
}))

jest.mock('./GatewayCollabChannel', () => ({
  createGatewayCollabChannel: jest.fn(),
}))

const mockedResolve = jest.mocked(resolveCollaborationKeySource)
const mockedPrepare = jest.mocked(prepareCollaborationAccess)
const mockedCreateChannel = jest.mocked(createGatewayCollabChannel)
const protocolVersion = 3 as const
const maxTransferBytes = 4 * 1024 * 1024
const roomEpoch = 'room_epoch_0000000000000001'
const sessionUser = { uuid: 'user-1', email: 'alice@example.test' }

const createAutoLeaseChannel = (sent: CollabFrame[], bootstrap = true) => {
  let inbound: ((frame: CollabFrame) => void) | undefined
  return {
    channel: {
      isConnected: () => true,
      authorize: jest.fn(),
      send: (frame: CollabFrame) => {
        sent.push(frame)
        if (frame.t === 'room-reserve') {
          inbound?.({
            t: 'room-reserved',
            room: frame.room,
            requestId: frame.requestId,
            bootstrap,
            ...(bootstrap ? { bootstrapChallenge: `challenge:${frame.requestId}` } : {}),
            protocolVersion,
            maxTransferBytes,
            roomEpoch: frame.expectedRoomEpoch,
          })
        } else if (frame.t === 'room-join') {
          inbound?.({
            t: 'room-joined',
            room: frame.room,
            requestId: frame.requestId,
            bootstrap,
            protocolVersion,
            maxTransferBytes,
            roomEpoch: frame.expectedRoomEpoch,
          })
        }
      },
      subscribe: (handler: (frame: CollabFrame) => void) => {
        inbound = handler
        return () => {
          inbound = undefined
        }
      },
    },
    receive: (frame: CollabFrame) => inbound?.(frame),
  }
}

const flushMicrotasks = async (count = 12): Promise<void> => {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve()
  }
}

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: webcrypto,
})

describe('useCollaborationRoomAccess security transitions', () => {
  let container: HTMLElement
  let root: Root
  let socketObserver: ((event: WebSocketsServiceEvent) => Promise<void>) | undefined
  let itemObserver: (() => void) | undefined
  let latestAccess: ReturnType<typeof useCollaborationRoomAccess> | undefined

  beforeEach(() => {
    socketObserver = undefined
    itemObserver = undefined
    latestAccess = undefined
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    mockedResolve.mockImplementation(
      (_application, note) =>
        ({
          available: true,
          noteUuid: note.uuid,
          sourceId: 'root-same-uuid:version-1',
          userUuid: 'user-1',
          sessionUser,
        }) as never,
    )
    mockedPrepare.mockImplementation(async (_application, note) => ({
      available: true,
      noteUuid: note.uuid,
      sourceId: 'root-same-uuid:version-1',
      roomKey: {} as CryptoKey,
      capability: 'capability-1',
      roomEpoch,
      serverUpdatedAtTimestamp: 100,
      userUuid: 'user-1',
      sessionUser,
      username: 'Alice',
    }))
  })

  it('defers distributed reservation so StrictMode abandons its first setup before bootstrap election', async () => {
    const sent: CollabFrame[] = []
    mockedCreateChannel.mockImplementation(() => createAutoLeaseChannel(sent).channel)
    const note = { uuid: 'note-1', text: 'canonical', dirty: false, serverUpdatedAtTimestamp: 100 } as never
    const application = {
      items: { streamItems: () => jest.fn(), findItem: () => note },
      sync: { sync: jest.fn().mockResolvedValue(undefined) },
      vaultLocks: { addEventObserver: () => jest.fn() },
      sockets: { addEventObserver: () => jest.fn(), isWebSocketConnectionOpen: () => true },
      addEventObserver: () => jest.fn(),
    } as never
    const View = () => {
      latestAccess = useCollaborationRoomAccess(application, note, true)
      return createElement('div', null, latestAccess.status)
    }

    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(View)))
      await flushMicrotasks(40)
    })

    expect(latestAccess?.status).toBe('ready')
    expect(sent.filter((frame) => frame.t === 'room-reserve')).toHaveLength(1)
    expect(sent.filter((frame) => frame.t === 'room-join')).toHaveLength(1)
    expect(sent.filter((frame) => frame.t === 'room-leave')).toHaveLength(0)
  })

  it('remounts before reserving or joining when reconnect authorization rotates the room epoch', async () => {
    const sent: CollabFrame[] = []
    let authorizedEpoch = roomEpoch
    mockedCreateChannel.mockImplementation(() => createAutoLeaseChannel(sent).channel)
    mockedPrepare.mockImplementation(async (_application, note) => ({
      available: true,
      noteUuid: note.uuid,
      sourceId: 'root-same-uuid:version-1',
      roomKey: {} as CryptoKey,
      capability: `capability:${authorizedEpoch}`,
      roomEpoch: authorizedEpoch,
      serverUpdatedAtTimestamp: 100,
      userUuid: 'user-1',
      sessionUser,
      username: 'Alice',
    }))
    const note = { uuid: 'note-1', text: 'canonical', dirty: false, serverUpdatedAtTimestamp: 100 } as never
    const application = {
      items: { streamItems: () => jest.fn(), findItem: () => note },
      sync: { sync: jest.fn().mockResolvedValue(undefined) },
      vaultLocks: { addEventObserver: () => jest.fn() },
      sockets: { addEventObserver: () => jest.fn(), isWebSocketConnectionOpen: () => true },
      addEventObserver: () => jest.fn(),
    } as never
    const View = () => {
      latestAccess = useCollaborationRoomAccess(application, note, true)
      return createElement('div', null, latestAccess.status)
    }

    await act(async () => {
      root.render(createElement(View))
      await flushMicrotasks(30)
    })
    const lease = latestAccess?.status === 'ready' ? latestAccess.editorLease : undefined
    expect(lease).toBeDefined()
    expect(sent.filter((frame) => frame.t === 'room-reserve')).toHaveLength(1)
    expect(sent.filter((frame) => frame.t === 'room-join')).toHaveLength(1)

    authorizedEpoch = 'room_epoch_0000000000000002'
    let result: unknown
    let reservesAtOldLeaseReturn = 0
    let joinsAtOldLeaseReturn = 0
    await act(async () => {
      result = await lease!.reactivate()
      reservesAtOldLeaseReturn = sent.filter((frame) => frame.t === 'room-reserve').length
      joinsAtOldLeaseReturn = sent.filter((frame) => frame.t === 'room-join').length
      await flushMicrotasks()
    })

    expect(result).toEqual({
      reason: 'The collaboration room epoch changed while collaboration was reconnecting.',
      requiresRemount: true,
    })
    expect(reservesAtOldLeaseReturn).toBe(1)
    expect(joinsAtOldLeaseReturn).toBe(1)
    const remountedReserves = sent.filter(
      (frame): frame is Extract<CollabFrame, { t: 'room-reserve' }> => frame.t === 'room-reserve',
    )
    const remountedJoins = sent.filter(
      (frame): frame is Extract<CollabFrame, { t: 'room-join' }> => frame.t === 'room-join',
    )
    expect(remountedReserves.at(-1)).toMatchObject({
      expectedRoomEpoch: authorizedEpoch,
      cap: `capability:${authorizedEpoch}`,
    })
    expect(remountedJoins.at(-1)).toMatchObject({ expectedRoomEpoch: authorizedEpoch })
    expect(latestAccess).toMatchObject({ status: 'ready', roomEpoch: authorizedEpoch })
  })

  it('keeps committed preparation and observer readiness isolated from an abandoned note render', async () => {
    const committed = {
      uuid: 'committed-note',
      text: 'committed body',
      dirty: false,
      serverUpdatedAtTimestamp: 100,
    }
    const abandoned = {
      uuid: 'abandoned-note',
      text: 'uncommitted body',
      dirty: false,
      serverUpdatedAtTimestamp: 100,
    }
    mockedResolve.mockImplementation(
      (_application, candidate) =>
        ({
          available: true,
          noteUuid: candidate.uuid,
          sourceId: `source:${candidate.uuid}`,
          userUuid: 'user-1',
          sessionUser,
        }) as never,
    )
    let finishPreparation!: () => void
    mockedPrepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPreparation = () =>
            resolve({
              available: true,
              noteUuid: committed.uuid,
              sourceId: `source:${committed.uuid}`,
              roomKey: {} as CryptoKey,
              capability: 'committed-capability',
              roomEpoch,
              serverUpdatedAtTimestamp: 100,
              userUuid: 'user-1',
              sessionUser,
              username: 'Alice',
            })
        }),
    )
    const application = {
      items: { streamItems: () => jest.fn(), findItem: () => committed },
      vaultLocks: { addEventObserver: () => jest.fn() },
      sockets: {
        addEventObserver: (observer: (event: WebSocketsServiceEvent) => Promise<void>) => {
          socketObserver = observer
          return jest.fn()
        },
        isWebSocketConnectionOpen: () => true,
      },
      addEventObserver: () => jest.fn(),
    } as never
    const never = new Promise<void>(() => undefined)
    let abandonedRenderCount = 0
    const View = ({ activeNote, suspend }: { activeNote: typeof committed; suspend: boolean }) => {
      const access = useCollaborationRoomAccess(application, activeNote as never)
      if (suspend) {
        abandonedRenderCount += 1
        throw never
      }
      latestAccess = access
      return createElement('div', null, `${activeNote.uuid}:${access.status}`)
    }
    const tree = (activeNote: typeof committed, suspend = false) =>
      createElement(
        Suspense,
        { fallback: createElement('div', null, 'fallback') },
        createElement(View, { activeNote, suspend }),
      )

    await act(async () => {
      root.render(tree(committed))
      await flushMicrotasks()
    })
    expect(mockedPrepare).toHaveBeenCalledTimes(1)
    expect(mockedPrepare.mock.calls[0][1]).toBe(committed)

    await act(async () => {
      startTransition(() => root.render(tree(abandoned, true)))
      await flushMicrotasks()
    })
    expect(abandonedRenderCount).toBeGreaterThan(0)
    expect(container.textContent).toBe('committed-note:preparing')

    await act(async () => {
      finishPreparation()
      await flushMicrotasks()
    })
    expect(latestAccess?.status).toBe('ready')
    expect(mockedPrepare).toHaveBeenCalledTimes(1)

    await act(async () => {
      root.render(tree(committed))
      await flushMicrotasks()
      startTransition(() => root.render(tree(abandoned, true)))
      await flushMicrotasks()
    })
    expect(abandonedRenderCount).toBeGreaterThan(1)
    await act(async () => {
      await socketObserver?.(WebSocketsServiceEvent.WebSocketDidOpen)
      await flushMicrotasks()
    })
    expect(container.textContent).toBe('committed-note:ready')
    expect(mockedPrepare).toHaveBeenCalledTimes(1)
  })

  it('releases the live lease and disables collaboration when protected access expires', async () => {
    const sent: CollabFrame[] = []
    let applicationObserver: ((event: ApplicationEvent) => Promise<void>) | undefined
    mockedCreateChannel.mockImplementation(() => createAutoLeaseChannel(sent).channel)
    const note = {
      uuid: 'protected-note',
      text: 'canonical',
      dirty: false,
      protected: true,
      serverUpdatedAtTimestamp: 100,
    } as never
    const application = {
      items: { streamItems: () => jest.fn(), findItem: () => note },
      sync: { sync: jest.fn().mockResolvedValue(undefined) },
      vaultLocks: { addEventObserver: () => jest.fn() },
      sockets: { addEventObserver: () => jest.fn(), isWebSocketConnectionOpen: () => true },
      addEventObserver: (observer: (event: ApplicationEvent) => Promise<void>) => {
        applicationObserver = observer
        return jest.fn()
      },
    } as never
    const View = () => {
      latestAccess = useCollaborationRoomAccess(application, note, true)
      return createElement('div', null, latestAccess.status)
    }

    await act(async () => {
      root.render(createElement(View))
      await flushMicrotasks(30)
    })
    expect(latestAccess?.status).toBe('ready')

    mockedResolve.mockReturnValue({
      available: false,
      reason: 'Unlock protected note access to use live collaboration.',
    })
    await act(async () => {
      const expiration = applicationObserver?.(ApplicationEvent.UnprotectedSessionExpired)
      expect(sent.filter((frame) => frame.t === 'room-leave')).toHaveLength(1)
      await expiration
      await flushMicrotasks(10)
    })

    expect(latestAccess).toEqual({
      status: 'disabled',
      reason: 'Unlock protected note access to use live collaboration.',
    })
    expect(sent.filter((frame) => frame.t === 'room-leave')).toHaveLength(1)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    jest.clearAllMocks()
  })

  it('re-prepares on key rotation but preserves a ready Y.Doc across socket loss', async () => {
    const application = {
      items: {
        streamItems: (_types: unknown, observer: () => void) => {
          itemObserver = observer
          return jest.fn()
        },
      },
      vaultLocks: { addEventObserver: () => jest.fn() },
      sockets: {
        addEventObserver: (observer: (event: WebSocketsServiceEvent) => Promise<void>) => {
          socketObserver = observer
          return jest.fn()
        },
      },
      addEventObserver: () => jest.fn(),
    } as never
    const note = { uuid: 'note-1' } as never
    const View = () => {
      latestAccess = useCollaborationRoomAccess(application, note)
      return createElement('div', null, latestAccess.status)
    }

    await act(async () => {
      root.render(createElement(View))
      await Promise.resolve()
    })
    expect(container.textContent).toBe('ready')

    mockedResolve.mockReturnValue({
      available: true,
      noteUuid: 'note-1',
      sourceId: 'root-same-uuid:version-2',
      userUuid: 'user-1',
      sessionUser,
    } as never)
    mockedPrepare.mockResolvedValue({
      available: true,
      noteUuid: 'note-1',
      sourceId: 'root-same-uuid:version-2',
      roomKey: {} as CryptoKey,
      capability: 'capability-2',
      roomEpoch,
      serverUpdatedAtTimestamp: 100,
      userUuid: 'user-1',
      sessionUser,
      username: 'Alice',
    })
    await act(async () => {
      itemObserver?.()
      await Promise.resolve()
    })
    expect(container.textContent).toBe('ready')
    expect(mockedPrepare).toHaveBeenCalledTimes(2)

    mockedResolve.mockReturnValue({
      available: false,
      reason: 'Live collaboration is unavailable while the gateway is offline.',
    })
    await act(async () => {
      await socketObserver?.(WebSocketsServiceEvent.WebSocketDidClose)
    })
    expect(container.textContent).toBe('ready')
    expect(latestAccess).toMatchObject({ status: 'ready', capability: 'capability-2' })
    expect(mockedPrepare).toHaveBeenCalledTimes(2)
  })

  it('opens in an offline-safe state and prepares automatically when the socket connects', async () => {
    let connected = false
    const application = {
      items: { streamItems: () => jest.fn() },
      vaultLocks: { addEventObserver: () => jest.fn() },
      sockets: {
        isWebSocketConnectionOpen: () => connected,
        addEventObserver: (observer: (event: WebSocketsServiceEvent) => Promise<void>) => {
          socketObserver = observer
          return jest.fn()
        },
      },
      addEventObserver: () => jest.fn(),
    } as never
    const View = () => {
      latestAccess = useCollaborationRoomAccess(application, { uuid: 'note-1' } as never)
      return createElement('div', null, latestAccess.status)
    }

    await act(async () => {
      root.render(createElement(View))
      await Promise.resolve()
    })
    expect(latestAccess).toEqual({
      status: 'disabled',
      reason: 'Live collaboration is offline and will retry when the encrypted gateway reconnects.',
    })
    expect(mockedPrepare).not.toHaveBeenCalled()

    connected = true
    await act(async () => {
      await socketObserver?.(WebSocketsServiceEvent.WebSocketDidOpen)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(latestAccess).toMatchObject({ status: 'ready', capability: 'capability-1' })
    expect(mockedPrepare).toHaveBeenCalledTimes(1)
  })

  it('reserves an explicit editor lease and trusts only its request-bound bootstrap election', async () => {
    const sent: CollabFrame[] = []
    let inbound: ((frame: CollabFrame) => void) | undefined
    mockedCreateChannel.mockReturnValue({
      isConnected: () => true,
      authorize: jest.fn(),
      send: (frame) => sent.push(frame),
      subscribe: (handler) => {
        inbound = handler
        return () => {
          inbound = undefined
        }
      },
    })
    const note = { uuid: 'note-1', dirty: false, serverUpdatedAtTimestamp: 100, text: 'persisted' } as never
    const application = {
      items: { streamItems: () => jest.fn(), findItem: () => note },
      sync: { sync: jest.fn().mockResolvedValue(undefined) },
      vaultLocks: { addEventObserver: () => jest.fn() },
      sockets: { addEventObserver: () => jest.fn() },
      addEventObserver: () => jest.fn(),
    } as never
    const View = () => {
      latestAccess = useCollaborationRoomAccess(application, note, true)
      return createElement('div', null, latestAccess.status)
    }

    await act(async () => {
      root.render(createElement(View))
      await Promise.resolve()
      await Promise.resolve()
    })
    const reserve = sent.find(
      (frame): frame is Extract<CollabFrame, { t: 'room-reserve' }> => frame.t === 'room-reserve',
    )
    expect(reserve).toMatchObject({
      room: 'note-1',
      cap: 'capability-1',
      role: 'editor',
      requestId: expect.any(String),
      protocolVersion,
    })

    await act(async () => {
      inbound?.({
        t: 'room-reserved',
        room: 'note-1',
        requestId: 'spoofed',
        bootstrap: true,
        bootstrapChallenge: 'spoofed-challenge',
        protocolVersion,
        maxTransferBytes,
        roomEpoch,
      })
      await Promise.resolve()
    })
    expect(container.textContent).toBe('preparing')

    await act(async () => {
      inbound?.({
        t: 'room-reserved',
        room: 'note-1',
        requestId: reserve!.requestId,
        bootstrap: true,
        bootstrapChallenge: 'bootstrap-challenge',
        protocolVersion,
        maxTransferBytes,
        roomEpoch,
      })
      await flushMicrotasks()
    })
    const join = sent.find((frame): frame is Extract<CollabFrame, { t: 'room-join' }> => frame.t === 'room-join')
    expect(join).toMatchObject({ requestId: reserve!.requestId, protocolVersion })
    await act(async () => {
      inbound?.({
        t: 'room-joined',
        room: 'note-1',
        requestId: join!.requestId,
        bootstrap: true,
        protocolVersion,
        maxTransferBytes,
        roomEpoch,
      })
      await flushMicrotasks()
    })
    expect(container.textContent).toBe('ready')
    expect(latestAccess).toMatchObject({
      status: 'ready',
      editorLease: {
        requestId: reserve!.requestId,
        shouldBootstrap: true,
      },
    })
    const editorLease = latestAccess?.status === 'ready' ? latestAccess.editorLease : undefined
    expect(editorLease?.validateAttachment()).toBe(true)
    expect(editorLease?.isAttached()).toBe(false)
    editorLease?.setProviderCanonicalOwnership?.(true)
    expect(editorLease?.isAttached()).toBe(true)
    editorLease?.setProviderCanonicalOwnership?.(false)
    expect(editorLease?.isAttached()).toBe(false)
  })

  it('rejects activation when the gateway changes the negotiated room epoch', async () => {
    const sent: CollabFrame[] = []
    let inbound: ((frame: CollabFrame) => void) | undefined
    mockedCreateChannel.mockReturnValue({
      isConnected: () => true,
      authorize: jest.fn(),
      send: (frame) => sent.push(frame),
      subscribe: (handler) => {
        inbound = handler
        return jest.fn()
      },
    })
    const transaction = beginEditorLeaseReservation(
      {} as never,
      'epoch-note',
      'reservation-capability',
      roomEpoch,
      10_000,
      'epoch-request',
    )
    inbound?.({
      t: 'room-reserved',
      room: 'epoch-note',
      requestId: 'epoch-request',
      bootstrap: false,
      protocolVersion,
      maxTransferBytes,
      roomEpoch,
    })
    await expect(transaction.promise).resolves.toMatchObject({ roomEpoch })

    const activation = transaction.activate('activation-capability')
    inbound?.({
      t: 'room-joined',
      room: 'epoch-note',
      requestId: 'epoch-request',
      bootstrap: false,
      protocolVersion,
      maxTransferBytes,
      roomEpoch: 'room_epoch_0000000000000002',
    })

    await expect(activation).resolves.toEqual({
      reason: 'The collaboration gateway activation did not match its reservation.',
    })
    expect(sent).toContainEqual({ t: 'room-leave', room: 'epoch-note', requestId: 'epoch-request' })
  })

  it('syncs a stale first device before bootstrap so newer persisted text is the only seed', async () => {
    const stale = {
      uuid: 'note-stale',
      text: 'older local text',
      dirty: false,
      serverUpdatedAtTimestamp: 100,
    }
    let live = stale
    const newer = {
      ...stale,
      text: 'newer text already persisted by device B',
      serverUpdatedAtTimestamp: 200,
    }
    mockedResolve.mockReturnValue({
      available: true,
      noteUuid: 'note-stale',
      sourceId: 'stable-key-source',
      userUuid: 'user-1',
      sessionUser,
    } as never)
    mockedPrepare.mockResolvedValue({
      available: true,
      noteUuid: 'note-stale',
      sourceId: 'stable-key-source',
      roomKey: {} as CryptoKey,
      capability: 'canonical-capability',
      roomEpoch,
      serverUpdatedAtTimestamp: 200,
      userUuid: 'user-1',
      sessionUser,
      username: 'Alice',
    })
    const sync = jest.fn().mockImplementation(async () => {
      // No room/bootstrap operation has happened; ordinary encrypted sync wins.
      live = newer
    })
    const application = {
      sync: { sync },
      items: { findItem: () => live },
    } as never

    const result = await prepareSynchronizedEditorAccess(application, stale as never)

    expect(sync).toHaveBeenCalledWith(
      expect.objectContaining({
        awaitAll: true,
        sourceDescription: expect.stringContaining('canonical encrypted note revision'),
      }),
    )
    expect(result).toMatchObject({
      available: true,
      serverUpdatedAtTimestamp: 200,
      initialEditorState: 'newer text already persisted by device B',
    })
    expect(live.text).toBe('newer text already persisted by device B')
  })

  it('fails closed before authorization or sync when the elected note body is still lite', async () => {
    const sync = jest.fn()
    const lite = {
      uuid: 'lite-bootstrap-note',
      text: '',
      dirty: false,
      serverUpdatedAtTimestamp: 100,
      payload: { content: { __lazyLite: true } },
    }

    await expect(
      prepareSynchronizedEditorAccess(
        {
          sync: { sync },
          items: { findItem: jest.fn(() => lite) },
        } as never,
        lite as never,
      ),
    ).resolves.toEqual({
      available: false,
      reason: 'Live collaboration is waiting for the full encrypted note body to load.',
    })
    expect(mockedPrepare).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
    expect(mockedCreateChannel).not.toHaveBeenCalled()
  })

  it('rejects a synchronized access result after a same-UUID session swaps during full sync', async () => {
    const firstSession = sessionUser
    const secondSession = { uuid: sessionUser.uuid, email: sessionUser.email }
    let activeSession = firstSession
    const note = { uuid: 'session-race-note', text: 'canonical', dirty: false, serverUpdatedAtTimestamp: 100 }
    mockedResolve.mockImplementation(
      () =>
        ({
          available: true,
          noteUuid: 'session-race-note',
          sourceId: 'same-root-and-note',
          userUuid: 'user-1',
          sessionUser: activeSession,
        }) as never,
    )
    mockedPrepare.mockResolvedValue({
      available: true,
      noteUuid: 'session-race-note',
      sourceId: 'same-root-and-note',
      roomKey: {} as CryptoKey,
      capability: 'first-session-capability',
      roomEpoch,
      serverUpdatedAtTimestamp: 100,
      userUuid: 'user-1',
      sessionUser: firstSession,
      username: 'Alice',
    })
    let finishSync!: () => void
    const sync = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSync = resolve
        }),
    )

    const preparation = prepareSynchronizedEditorAccess(
      { sync: { sync }, items: { findItem: () => note } } as never,
      note as never,
    )
    await flushMicrotasks(2)
    expect(sync).toHaveBeenCalledTimes(1)
    activeSession = secondSession
    finishSync()

    await expect(preparation).resolves.toMatchObject({
      available: false,
      reason: 'The note encryption key changed while collaboration was synchronizing.',
    })
  })

  it('releases and re-elects when the durable revision advances after activation acknowledgement', async () => {
    const sent: CollabFrame[] = []
    mockedCreateChannel.mockImplementation(() => createAutoLeaseChannel(sent).channel)
    const initial = { uuid: 'post-ack-race', text: 'revision 100', dirty: false, serverUpdatedAtTimestamp: 100 }
    let live = initial
    mockedResolve.mockReturnValue({
      available: true,
      noteUuid: 'post-ack-race',
      sourceId: 'stable-post-ack-source',
      userUuid: 'user-1',
      sessionUser,
    } as never)
    mockedPrepare.mockImplementation(async () => {
      const call = mockedPrepare.mock.calls.length
      const revision = call >= 3 ? 200 : 100
      return {
        available: true,
        noteUuid: 'post-ack-race',
        sourceId: 'stable-post-ack-source',
        roomKey: {} as CryptoKey,
        capability: `capability-${call}`,
        roomEpoch,
        serverUpdatedAtTimestamp: revision,
        userUuid: 'user-1',
        sessionUser,
        username: 'Alice',
      }
    })
    const sync = jest.fn(async () => {
      if (sync.mock.calls.length === 3) {
        live = { ...initial, text: 'revision 200 from another device', serverUpdatedAtTimestamp: 200 }
      }
    })
    const application = {
      items: { streamItems: () => jest.fn(), findItem: () => live },
      sync: { sync },
      vaultLocks: { addEventObserver: () => jest.fn() },
      sockets: { addEventObserver: () => jest.fn() },
      addEventObserver: () => jest.fn(),
    } as never
    const View = () => {
      latestAccess = useCollaborationRoomAccess(application, initial as never, true)
      return createElement('div', null, latestAccess.status)
    }

    await act(async () => {
      root.render(createElement(View))
      await flushMicrotasks(30)
    })

    const reserves = sent.filter(
      (frame): frame is Extract<CollabFrame, { t: 'room-reserve' }> => frame.t === 'room-reserve',
    )
    expect(reserves).toHaveLength(2)
    expect(sent).toContainEqual({ t: 'room-leave', room: initial.uuid, requestId: reserves[0].requestId })
    expect(latestAccess).toMatchObject({
      status: 'ready',
      initialEditorState: 'revision 200 from another device',
      editorLease: { requestId: reserves[1].requestId },
    })
    expect(mockedPrepare.mock.calls[1][2]).toMatchObject({
      leaseRequestId: reserves[0].requestId,
      bootstrapChallenge: `challenge:${reserves[0].requestId}`,
    })
    expect(mockedPrepare.mock.calls[2][2]).toEqual(mockedPrepare.mock.calls[1][2])
  })

  it('reauthorizes after an awaited full-sync revision race before allowing bootstrap', async () => {
    const initial = { uuid: 'note-race', text: 'initial', dirty: false, serverUpdatedAtTimestamp: 100 }
    let live = initial
    mockedResolve.mockReturnValue({
      available: true,
      noteUuid: 'note-race',
      sourceId: 'stable-key-source',
      userUuid: 'user-1',
      sessionUser,
    } as never)
    mockedPrepare
      .mockResolvedValueOnce({
        available: true,
        noteUuid: 'note-race',
        sourceId: 'stable-key-source',
        roomKey: {} as CryptoKey,
        capability: 'capability-at-200',
        roomEpoch,
        serverUpdatedAtTimestamp: 200,
        userUuid: 'user-1',
        sessionUser,
        username: 'Alice',
      })
      .mockResolvedValueOnce({
        available: true,
        noteUuid: 'note-race',
        sourceId: 'stable-key-source',
        roomKey: {} as CryptoKey,
        capability: 'capability-at-201',
        roomEpoch,
        serverUpdatedAtTimestamp: 201,
        userUuid: 'user-1',
        sessionUser,
        username: 'Alice',
      })
    const sync = jest.fn().mockImplementation(async () => {
      live = { ...initial, text: 'latest concurrent body', serverUpdatedAtTimestamp: 201 }
    })

    const result = await prepareSynchronizedEditorAccess(
      { sync: { sync }, items: { findItem: () => live } } as never,
      initial as never,
    )

    expect(mockedPrepare).toHaveBeenCalledTimes(2)
    expect(sync).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({
      available: true,
      capability: 'capability-at-201',
      initialEditorState: 'latest concurrent body',
    })
  })

  it('does not restart preparation for the CompletedFullSync emitted by its own freshness sync', async () => {
    const sent: CollabFrame[] = []
    let applicationObserver: ((event: ApplicationEvent) => Promise<void>) | undefined
    mockedCreateChannel.mockReturnValue(createAutoLeaseChannel(sent).channel)
    const note = { uuid: 'note-self-sync', text: 'canonical', dirty: false, serverUpdatedAtTimestamp: 100 }
    const sync = jest.fn(async () => {
      await applicationObserver?.(ApplicationEvent.CompletedFullSync)
    })
    const application = {
      items: { streamItems: () => jest.fn(), findItem: () => note },
      sync: { sync },
      vaultLocks: { addEventObserver: () => jest.fn() },
      sockets: { addEventObserver: () => jest.fn() },
      addEventObserver: (observer: (event: ApplicationEvent) => Promise<void>) => {
        applicationObserver = observer
        return jest.fn()
      },
    } as never
    const View = () => {
      latestAccess = useCollaborationRoomAccess(application, note as never, true)
      return createElement('div', null, latestAccess.status)
    }

    await act(async () => {
      root.render(createElement(View))
      await flushMicrotasks()
    })

    expect(mockedPrepare).toHaveBeenCalledTimes(3)
    expect(sync).toHaveBeenCalledTimes(3)
    const joins = sent.filter((frame): frame is Extract<CollabFrame, { t: 'room-join' }> => frame.t === 'room-join')
    expect(joins).toHaveLength(1)
    expect(latestAccess?.status).toBe('ready')
  })

  it('retries a failed stale preparation on a later full sync without remounting a ready lease', async () => {
    const sent: CollabFrame[] = []
    let applicationObserver: ((event: ApplicationEvent) => Promise<void>) | undefined
    mockedCreateChannel.mockReturnValue(createAutoLeaseChannel(sent).channel)
    const stale = { uuid: 'note-later-sync', text: 'stale', dirty: false, serverUpdatedAtTimestamp: 100 }
    let live = stale
    mockedPrepare.mockResolvedValue({
      available: true,
      noteUuid: 'note-later-sync',
      sourceId: 'root-same-uuid:version-1',
      roomKey: {} as CryptoKey,
      capability: 'capability-at-200',
      roomEpoch,
      serverUpdatedAtTimestamp: 200,
      userUuid: 'user-1',
      sessionUser,
      username: 'Alice',
    })
    const sync = jest.fn().mockResolvedValue(undefined)
    const application = {
      items: { streamItems: () => jest.fn(), findItem: () => live },
      sync: { sync },
      vaultLocks: { addEventObserver: () => jest.fn() },
      sockets: { addEventObserver: () => jest.fn() },
      addEventObserver: (observer: (event: ApplicationEvent) => Promise<void>) => {
        applicationObserver = observer
        return jest.fn()
      },
    } as never
    const View = () => {
      latestAccess = useCollaborationRoomAccess(application, stale as never, true)
      return createElement('div', null, latestAccess.status)
    }

    await act(async () => {
      root.render(createElement(View))
      await flushMicrotasks()
    })
    expect(latestAccess).toMatchObject({ status: 'disabled' })
    expect(mockedPrepare).toHaveBeenCalledTimes(3)
    expect(sync).toHaveBeenCalledTimes(3)

    live = { ...stale, text: 'canonical after later sync', serverUpdatedAtTimestamp: 200 }
    await act(async () => {
      await applicationObserver?.(ApplicationEvent.CompletedFullSync)
      await flushMicrotasks()
    })
    const join = sent.find((frame): frame is Extract<CollabFrame, { t: 'room-join' }> => frame.t === 'room-join')
    expect(join).toBeDefined()
    expect(mockedPrepare).toHaveBeenCalledTimes(6)
    expect(sync).toHaveBeenCalledTimes(6)
    expect(latestAccess).toMatchObject({ status: 'ready', initialEditorState: 'canonical after later sync' })

    const sentAtReady = [...sent]
    await act(async () => {
      await applicationObserver?.(ApplicationEvent.CompletedFullSync)
      await Promise.resolve()
    })
    expect(mockedPrepare).toHaveBeenCalledTimes(6)
    expect(sync).toHaveBeenCalledTimes(6)
    expect(sent).toEqual(sentAtReady)
    expect(latestAccess?.status).toBe('ready')
  })

  it('ignores a pre-send callback and safely accepts a synchronous send acknowledgement', async () => {
    const requestId = '00000000-0000-4000-8000-000000000001'
    const randomUuid = jest.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(requestId)
    const unsubscribe = jest.fn()
    let inbound: ((frame: CollabFrame) => void) | undefined
    mockedCreateChannel.mockReturnValue({
      isConnected: () => true,
      authorize: jest.fn(),
      send: (frame) => {
        if (frame.t === 'room-reserve') {
          inbound?.({
            t: 'room-reserved',
            room: frame.room,
            requestId: frame.requestId,
            bootstrap: true,
            bootstrapChallenge: 'challenge-1',
            protocolVersion,
            maxTransferBytes,
            roomEpoch,
          })
        } else if (frame.t === 'room-join') {
          inbound?.({
            t: 'room-joined',
            room: frame.room,
            requestId: frame.requestId,
            bootstrap: true,
            protocolVersion,
            maxTransferBytes,
            roomEpoch,
          })
        }
      },
      subscribe: (handler) => {
        inbound = handler
        handler({
          t: 'room-reserved',
          room: 'note-1',
          requestId,
          bootstrap: false,
          protocolVersion,
          maxTransferBytes,
          roomEpoch,
        })
        return unsubscribe
      },
    })

    try {
      const reservation = beginEditorLeaseReservation({} as never, 'note-1', 'capability-1', roomEpoch)
      await expect(reservation.promise).resolves.toEqual({
        requestId,
        shouldBootstrap: true,
        bootstrapChallenge: 'challenge-1',
        protocolVersion,
        maxTransferBytes,
        roomEpoch,
      })
      await expect(reservation.activate('activation-capability')).resolves.toMatchObject({
        requestId,
        shouldBootstrap: true,
        protocolVersion,
        maxTransferBytes,
        roomEpoch,
      })
      expect(unsubscribe).toHaveBeenCalledTimes(1)
    } finally {
      randomUuid.mockRestore()
    }
  })

  it('fails closed and disposes its subscription when the join transport throws', async () => {
    const unsubscribe = jest.fn()
    const send = jest.fn((_frame: CollabFrame) => {
      throw new Error('socket closed')
    })
    mockedCreateChannel.mockReturnValue({
      isConnected: () => false,
      authorize: jest.fn(),
      send,
      subscribe: () => unsubscribe,
    })

    const reservation = beginEditorLeaseReservation({} as never, 'note-1', 'capability-1', roomEpoch)
    await expect(reservation.promise).resolves.toEqual({
      reason: 'The encrypted collaboration room could not reserve an editor lease.',
    })
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1][0]).toMatchObject({
      t: 'room-leave',
      room: 'note-1',
    })
  })

  it('still resolves and sends its request-bound leave when timeout cleanup throws', async () => {
    const sent: CollabFrame[] = []
    mockedCreateChannel.mockReturnValue({
      isConnected: () => true,
      authorize: jest.fn(),
      send: (frame) => sent.push(frame),
      subscribe: () => () => {
        throw new Error('unsubscribe failed')
      },
    })

    const reservation = beginEditorLeaseReservation({} as never, 'note-1', 'capability-1', roomEpoch, 1)
    const reserve = sent.find(
      (frame): frame is Extract<CollabFrame, { t: 'room-reserve' }> => frame.t === 'room-reserve',
    )
    await expect(reservation.promise).resolves.toEqual({
      reason: 'The encrypted collaboration room did not acknowledge the editor reservation.',
    })
    expect(sent).toContainEqual({
      t: 'room-leave',
      room: 'note-1',
      requestId: reserve!.requestId,
    })
  })

  it('falls back to disabled when editor reservation subscription setup throws', async () => {
    mockedCreateChannel.mockReturnValue({
      isConnected: () => true,
      authorize: jest.fn(),
      send: jest.fn(),
      subscribe: () => {
        throw new Error('subscription setup failed')
      },
    })
    const note = { uuid: 'note-1', dirty: false, serverUpdatedAtTimestamp: 100, text: 'persisted' } as never
    const application = {
      items: { streamItems: () => jest.fn(), findItem: () => note },
      sync: { sync: jest.fn().mockResolvedValue(undefined) },
      vaultLocks: { addEventObserver: () => jest.fn() },
      sockets: { addEventObserver: () => jest.fn() },
      addEventObserver: () => jest.fn(),
    } as never
    const View = () => {
      latestAccess = useCollaborationRoomAccess(application, note, true)
      return createElement('div', null, latestAccess.status)
    }

    await act(async () => {
      root.render(createElement(View))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(latestAccess).toEqual({
      status: 'disabled',
      reason: 'Live collaboration could not establish a secure room.',
    })
  })

  it('invalidates synchronously on a same-vault note switch and releases the previous editor lease', async () => {
    const sent: CollabFrame[] = []
    mockedCreateChannel.mockImplementation(() => createAutoLeaseChannel(sent).channel)
    mockedResolve.mockImplementation((_application, note) => {
      return {
        available: true,
        noteUuid: note.uuid,
        sourceId: `same-vault:root-version:${note.uuid}`,
        userUuid: 'user-1',
        sessionUser,
      } as never
    })
    mockedPrepare.mockImplementation(async (_application, note) => {
      return {
        available: true,
        noteUuid: note.uuid,
        sourceId: `same-vault:root-version:${note.uuid}`,
        roomKey: {} as CryptoKey,
        capability: `capability:${note.uuid}`,
        roomEpoch,
        serverUpdatedAtTimestamp: 100,
        userUuid: 'user-1',
        sessionUser,
        username: 'Alice',
      }
    })
    const noteOne = {
      uuid: 'note-1',
      dirty: false,
      serverUpdatedAtTimestamp: 100,
      text: 'note one',
    } as never
    const noteTwo = {
      uuid: 'note-2',
      dirty: false,
      serverUpdatedAtTimestamp: 100,
      text: 'note two',
    } as never
    const notes = new Map([
      ['note-1', noteOne],
      ['note-2', noteTwo],
    ])
    const application = {
      items: { streamItems: () => jest.fn(), findItem: (uuid: string) => notes.get(uuid) },
      sync: { sync: jest.fn().mockResolvedValue(undefined) },
      vaultLocks: { addEventObserver: () => jest.fn() },
      sockets: { addEventObserver: () => jest.fn() },
      addEventObserver: () => jest.fn(),
    } as never
    const renders: Array<{ noteUuid: string; status: string; capability?: string }> = []
    const View = ({ note }: { note: { uuid: string } }) => {
      latestAccess = useCollaborationRoomAccess(application, note as never, true)
      renders.push({
        noteUuid: note.uuid,
        status: latestAccess.status,
        ...(latestAccess.status === 'ready' ? { capability: latestAccess.capability } : {}),
      })
      return createElement('div', null, latestAccess.status)
    }

    await act(async () => {
      root.render(createElement(View, { note: noteOne }))
      await flushMicrotasks()
    })
    const firstJoin = sent.find(
      (frame): frame is Extract<CollabFrame, { t: 'room-join' }> => frame.t === 'room-join' && frame.room === 'note-1',
    )
    expect(firstJoin).toBeDefined()
    expect(latestAccess).toMatchObject({ status: 'ready', capability: 'capability:note-1' })

    const firstSwitchedRender = renders.length
    await act(async () => {
      root.render(createElement(View, { note: noteTwo }))
      await flushMicrotasks()
    })

    expect(renders[firstSwitchedRender]).toEqual({ noteUuid: 'note-2', status: 'preparing' })
    expect(
      renders
        .slice(firstSwitchedRender)
        .some((render) => render.noteUuid === 'note-2' && render.capability === 'capability:note-1'),
    ).toBe(false)
    expect(latestAccess).toMatchObject({ status: 'ready', capability: 'capability:note-2' })
    expect(sent).toContainEqual({
      t: 'room-leave',
      room: 'note-1',
      requestId: firstJoin!.requestId,
    })
  })

  it('keeps a ready lease when immutable note content is replaced without changing collaboration identity', async () => {
    const sent: CollabFrame[] = []
    mockedCreateChannel.mockImplementation(() => createAutoLeaseChannel(sent).channel)
    mockedResolve.mockReturnValue({
      available: true,
      noteUuid: 'note-1',
      sourceId: 'same-vault:note-1:root-version',
      userUuid: 'user-1',
      sessionUser,
    } as never)
    mockedPrepare.mockResolvedValue({
      available: true,
      noteUuid: 'note-1',
      sourceId: 'same-vault:note-1:root-version',
      roomKey: {} as CryptoKey,
      capability: 'capability:note-1',
      roomEpoch,
      serverUpdatedAtTimestamp: 100,
      userUuid: 'user-1',
      sessionUser,
      username: 'Alice',
    })
    let liveNote = {
      uuid: 'note-1',
      text: 'before',
      dirty: false,
      serverUpdatedAtTimestamp: 100,
    }
    const application = {
      items: { streamItems: () => jest.fn(), findItem: () => liveNote },
      sync: { sync: jest.fn().mockResolvedValue(undefined) },
      vaultLocks: { addEventObserver: () => jest.fn() },
      sockets: { addEventObserver: () => jest.fn() },
      addEventObserver: () => jest.fn(),
    } as never
    const View = ({ note }: { note: { uuid: string; text: string } }) => {
      liveNote = { ...note, dirty: false, serverUpdatedAtTimestamp: 100 }
      latestAccess = useCollaborationRoomAccess(application, liveNote as never, true)
      return createElement('div', null, latestAccess.status)
    }

    await act(async () => {
      root.render(createElement(View, { note: { uuid: 'note-1', text: 'before' } }))
      await flushMicrotasks()
    })
    const join = sent.find((frame): frame is Extract<CollabFrame, { t: 'room-join' }> => frame.t === 'room-join')
    expect(join).toBeDefined()
    expect(latestAccess).toMatchObject({ status: 'ready', capability: 'capability:note-1' })

    const sentBeforeReplacement = [...sent]
    await act(async () => {
      root.render(createElement(View, { note: { uuid: 'note-1', text: 'after' } }))
      await flushMicrotasks()
    })

    expect(latestAccess).toMatchObject({
      status: 'ready',
      capability: 'capability:note-1',
      editorLease: { requestId: join!.requestId },
    })
    expect(sent).toEqual(sentBeforeReplacement)
    expect(mockedPrepare).toHaveBeenCalledTimes(3)
  })

  it('releases and re-prepares when the canonical note advances between the final barrier and provider attach', async () => {
    const sent: CollabFrame[] = []
    mockedCreateChannel.mockImplementation(() => createAutoLeaseChannel(sent).channel)
    let liveNote = { uuid: 'note-1', text: 'revision 100', dirty: false, serverUpdatedAtTimestamp: 100 }
    mockedPrepare.mockImplementation(async () => ({
      available: true,
      noteUuid: liveNote.uuid,
      sourceId: 'root-same-uuid:version-1',
      roomKey: {} as CryptoKey,
      capability: `capability-${liveNote.serverUpdatedAtTimestamp}`,
      roomEpoch,
      serverUpdatedAtTimestamp: liveNote.serverUpdatedAtTimestamp,
      userUuid: 'user-1',
      sessionUser,
      username: 'Alice',
    }))
    const application = {
      items: { streamItems: () => jest.fn(), findItem: () => liveNote },
      sync: { sync: jest.fn().mockResolvedValue(undefined) },
      vaultLocks: { addEventObserver: () => jest.fn() },
      sockets: { addEventObserver: () => jest.fn() },
      addEventObserver: () => jest.fn(),
    } as never
    const View = () => {
      latestAccess = useCollaborationRoomAccess(application, liveNote as never, true)
      return createElement('div', null, latestAccess.status)
    }

    await act(async () => {
      root.render(createElement(View))
      await flushMicrotasks()
    })
    const firstLease = latestAccess?.status === 'ready' ? latestAccess.editorLease : undefined
    expect(firstLease).toBeDefined()

    liveNote = { uuid: 'note-1', text: 'revision 101', dirty: false, serverUpdatedAtTimestamp: 101 }
    await act(async () => {
      expect(firstLease?.validateAttachment()).toBe(false)
      await flushMicrotasks()
    })

    expect(sent).toContainEqual({
      t: 'room-leave',
      room: 'note-1',
      requestId: firstLease!.requestId,
    })
    expect(latestAccess).toMatchObject({
      status: 'ready',
      initialEditorState: 'revision 101',
      capability: 'capability-101',
    })
    expect(latestAccess?.status === 'ready' ? latestAccess.editorLease?.requestId : undefined).not.toBe(
      firstLease?.requestId,
    )
  })

  it('re-elects bootstrap from the latest exact canonical body after provider recovery is exhausted', async () => {
    const sent: CollabFrame[] = []
    mockedCreateChannel.mockImplementation(() => createAutoLeaseChannel(sent).channel)
    let liveNote = { uuid: 'note-1', text: 'revision 100 body', dirty: false, serverUpdatedAtTimestamp: 100 }
    mockedPrepare.mockImplementation(async () => ({
      available: true,
      noteUuid: liveNote.uuid,
      sourceId: 'root-same-uuid:version-1',
      roomKey: {} as CryptoKey,
      capability: `capability-${liveNote.serverUpdatedAtTimestamp}`,
      roomEpoch,
      serverUpdatedAtTimestamp: liveNote.serverUpdatedAtTimestamp,
      userUuid: 'user-1',
      sessionUser,
      username: 'Alice',
    }))
    const application = {
      items: { streamItems: () => jest.fn(), findItem: () => liveNote },
      sync: { sync: jest.fn().mockResolvedValue(undefined) },
      vaultLocks: { addEventObserver: () => jest.fn() },
      sockets: { addEventObserver: () => jest.fn(), isWebSocketConnectionOpen: () => true },
      addEventObserver: () => jest.fn(),
    } as never
    const View = () => {
      latestAccess = useCollaborationRoomAccess(application, liveNote as never, true)
      return createElement('div', null, latestAccess.status)
    }

    await act(async () => {
      root.render(createElement(View))
      await flushMicrotasks(30)
    })
    const firstLease = latestAccess?.status === 'ready' ? latestAccess.editorLease : undefined
    expect(firstLease).toBeDefined()
    expect(latestAccess).toMatchObject({ status: 'ready', initialEditorState: 'revision 100 body' })

    liveNote = { uuid: 'note-1', text: 'revision 101 exact body', dirty: false, serverUpdatedAtTimestamp: 101 }
    await act(async () => {
      firstLease?.retryBootstrap()
      await flushMicrotasks(30)
    })

    expect(sent).toContainEqual({ t: 'room-leave', room: 'note-1', requestId: firstLease!.requestId })
    expect(latestAccess).toMatchObject({
      status: 'ready',
      initialEditorState: 'revision 101 exact body',
      capability: 'capability-101',
    })
    expect(latestAccess?.status === 'ready' ? latestAccess.editorLease?.requestId : undefined).not.toBe(
      firstLease?.requestId,
    )
  })

  it('keeps one attached lease across sustained durable revisions while the key source stays valid', async () => {
    const sent: CollabFrame[] = []
    mockedCreateChannel.mockImplementation(() => createAutoLeaseChannel(sent).channel)
    let liveNote = { uuid: 'note-1', text: 'revision 100', dirty: false, serverUpdatedAtTimestamp: 100 }
    mockedPrepare.mockImplementation(async () => ({
      available: true,
      noteUuid: liveNote.uuid,
      sourceId: 'root-same-uuid:version-1',
      roomKey: {} as CryptoKey,
      capability: `capability-${liveNote.serverUpdatedAtTimestamp}`,
      roomEpoch,
      serverUpdatedAtTimestamp: liveNote.serverUpdatedAtTimestamp,
      userUuid: 'user-1',
      sessionUser,
      username: 'Alice',
    }))
    const application = {
      items: { streamItems: () => jest.fn(), findItem: () => liveNote },
      sync: { sync: jest.fn().mockResolvedValue(undefined) },
      vaultLocks: { addEventObserver: () => jest.fn() },
      sockets: { addEventObserver: () => jest.fn() },
      addEventObserver: () => jest.fn(),
    } as never
    const View = () => {
      latestAccess = useCollaborationRoomAccess(application, liveNote as never, true)
      return createElement('div', null, latestAccess.status)
    }

    await act(async () => {
      root.render(createElement(View))
      await flushMicrotasks()
    })
    const firstLease = latestAccess?.status === 'ready' ? latestAccess.editorLease : undefined
    expect(firstLease?.validateAttachment()).toBe(true)
    const joinsAfterAttach = sent.filter((frame) => frame.t === 'room-join').length

    liveNote = { uuid: 'note-1', text: 'revision 101', dirty: false, serverUpdatedAtTimestamp: 101 }
    expect(firstLease?.validateAttachment()).toBe(true)
    liveNote = { uuid: 'note-1', text: 'revision 102', dirty: false, serverUpdatedAtTimestamp: 102 }
    expect(firstLease?.validateAttachment()).toBe(true)

    expect(latestAccess?.status === 'ready' ? latestAccess.editorLease?.requestId : undefined).toBe(
      firstLease?.requestId,
    )
    expect(sent.filter((frame) => frame.t === 'room-join')).toHaveLength(joinsAfterAttach)
    expect(sent.filter((frame) => frame.t === 'room-leave')).toHaveLength(0)
  })

  it('invalidates synchronously and releases the old lease when the vault or root-key identity changes', async () => {
    const sent: CollabFrame[] = []
    let activeSourceId = 'vault-1:note-1:root-version-1'
    mockedCreateChannel.mockImplementation(() => createAutoLeaseChannel(sent).channel)
    mockedResolve.mockImplementation(() => {
      return {
        available: true,
        noteUuid: 'note-1',
        sourceId: activeSourceId,
        userUuid: 'user-1',
        sessionUser,
      } as never
    })
    mockedPrepare.mockImplementation(async () => {
      return {
        available: true,
        noteUuid: 'note-1',
        sourceId: activeSourceId,
        roomKey: {} as CryptoKey,
        capability: `capability:${activeSourceId}`,
        roomEpoch,
        serverUpdatedAtTimestamp: 100,
        userUuid: 'user-1',
        sessionUser,
        username: 'Alice',
      }
    })
    const note = { uuid: 'note-1', dirty: false, serverUpdatedAtTimestamp: 100, text: 'persisted' } as never
    const application = {
      items: {
        streamItems: (_types: unknown, observer: () => void) => {
          itemObserver = observer
          return jest.fn()
        },
        findItem: () => note,
      },
      sync: { sync: jest.fn().mockResolvedValue(undefined) },
      vaultLocks: { addEventObserver: () => jest.fn() },
      sockets: { addEventObserver: () => jest.fn() },
      addEventObserver: () => jest.fn(),
    } as never
    const renders: Array<{ status: string; capability?: string }> = []
    const View = () => {
      latestAccess = useCollaborationRoomAccess(application, note, true)
      renders.push({
        status: latestAccess.status,
        ...(latestAccess.status === 'ready' ? { capability: latestAccess.capability } : {}),
      })
      return createElement('div', null, latestAccess.status)
    }

    await act(async () => {
      root.render(createElement(View))
      await flushMicrotasks()
    })
    const firstJoin = sent.find((frame): frame is Extract<CollabFrame, { t: 'room-join' }> => frame.t === 'room-join')
    expect(firstJoin).toBeDefined()
    expect(latestAccess).toMatchObject({
      status: 'ready',
      capability: 'capability:vault-1:note-1:root-version-1',
    })

    const firstChangedIdentityRender = renders.length
    activeSourceId = 'vault-2:note-1:root-version-2'
    await act(async () => {
      itemObserver?.()
      await flushMicrotasks()
    })

    expect(renders[firstChangedIdentityRender]).toEqual({ status: 'preparing' })
    expect(
      renders
        .slice(firstChangedIdentityRender)
        .some((render) => render.capability === 'capability:vault-1:note-1:root-version-1'),
    ).toBe(false)
    expect(sent).toContainEqual({
      t: 'room-leave',
      room: 'note-1',
      requestId: firstJoin!.requestId,
    })
  })

  it('orders a request-bound leave when unmounted before a delayed join acknowledgement', async () => {
    const sent: CollabFrame[] = []
    mockedCreateChannel.mockReturnValue({
      isConnected: () => true,
      authorize: jest.fn(),
      send: (frame) => sent.push(frame),
      subscribe: () => jest.fn(),
    })
    const reservation = beginEditorLeaseReservation({} as never, 'note-1', 'capability-1', roomEpoch)
    const reserve = sent.find(
      (frame): frame is Extract<CollabFrame, { t: 'room-reserve' }> => frame.t === 'room-reserve',
    )
    expect(reserve).toBeDefined()

    reservation.cancel()
    await expect(reservation.promise).resolves.toEqual({
      reason: 'The editor lease was cancelled.',
    })

    expect(sent).toContainEqual({
      t: 'room-leave',
      room: 'note-1',
      requestId: reserve!.requestId,
    })
  })

  it('releases a transmitted editor lease when its acknowledgement times out', async () => {
    const sent: CollabFrame[] = []
    mockedCreateChannel.mockReturnValue({
      isConnected: () => true,
      authorize: jest.fn(),
      send: (frame) => sent.push(frame),
      subscribe: () => jest.fn(),
    })
    const reservation = beginEditorLeaseReservation({} as never, 'note-1', 'capability-1', roomEpoch, 1)
    const result = await reservation.promise
    const reserve = sent.find(
      (frame): frame is Extract<CollabFrame, { t: 'room-reserve' }> => frame.t === 'room-reserve',
    )

    expect(result).toEqual({
      reason: 'The encrypted collaboration room did not acknowledge the editor reservation.',
    })
    expect(sent).toContainEqual({
      t: 'room-leave',
      room: 'note-1',
      requestId: reserve!.requestId,
    })
  })
})
