/**
 * @jest-environment jsdom
 */
import { webcrypto } from 'node:crypto'
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { WebSocketsServiceEvent } from '@standardnotes/snjs'
import { prepareCollaborationAccess, resolveCollaborationKeySource } from './CollaborationKeyDerivation'
import { createGatewayCollabChannel } from './GatewayCollabChannel'
import type { CollabFrame } from './CollabChannel'
import { beginEditorLeaseReservation, useCollaborationRoomAccess } from './useCollaborationRoomAccess'

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
    mockedResolve.mockReturnValue({
      available: true,
      sourceId: 'root-same-uuid:version-1',
    } as never)
    mockedPrepare.mockResolvedValue({
      available: true,
      sourceId: 'root-same-uuid:version-1',
      roomKey: {} as CryptoKey,
      capability: 'capability-1',
      userUuid: 'user-1',
      username: 'Alice',
    })
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
      sourceId: 'root-same-uuid:version-2',
    } as never)
    mockedPrepare.mockResolvedValue({
      available: true,
      sourceId: 'root-same-uuid:version-2',
      roomKey: {} as CryptoKey,
      capability: 'capability-2',
      userUuid: 'user-1',
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
    const application = {
      items: { streamItems: () => jest.fn() },
      vaultLocks: { addEventObserver: () => jest.fn() },
      sockets: { addEventObserver: () => jest.fn() },
      addEventObserver: () => jest.fn(),
    } as never
    const note = { uuid: 'note-1' } as never
    const View = () => {
      latestAccess = useCollaborationRoomAccess(application, note, true)
      return createElement('div', null, latestAccess.status)
    }

    await act(async () => {
      root.render(createElement(View))
      await Promise.resolve()
      await Promise.resolve()
    })
    const join = sent.find((frame): frame is Extract<CollabFrame, { t: 'room-join' }> => frame.t === 'room-join')
    expect(join).toMatchObject({
      room: 'note-1',
      cap: 'capability-1',
      role: 'editor',
      requestId: expect.any(String),
    })

    await act(async () => {
      inbound?.({ t: 'room-joined', room: 'note-1', requestId: 'spoofed', bootstrap: true })
      await Promise.resolve()
    })
    expect(container.textContent).toBe('preparing')

    await act(async () => {
      inbound?.({ t: 'room-joined', room: 'note-1', requestId: join!.requestId, bootstrap: true })
      await Promise.resolve()
    })
    expect(container.textContent).toBe('ready')
    expect(latestAccess).toMatchObject({
      status: 'ready',
      editorLease: {
        requestId: join!.requestId,
        shouldBootstrap: true,
      },
    })
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
        if (frame.t === 'room-join') {
          inbound?.({
            t: 'room-joined',
            room: frame.room,
            requestId: frame.requestId,
            bootstrap: true,
          })
        }
      },
      subscribe: (handler) => {
        inbound = handler
        handler({
          t: 'room-joined',
          room: 'note-1',
          requestId,
          bootstrap: false,
        })
        return unsubscribe
      },
    })

    try {
      const reservation = beginEditorLeaseReservation({} as never, 'note-1', 'capability-1')
      await expect(reservation.promise).resolves.toEqual({
        requestId,
        shouldBootstrap: true,
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

    const reservation = beginEditorLeaseReservation({} as never, 'note-1', 'capability-1')
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

    const reservation = beginEditorLeaseReservation({} as never, 'note-1', 'capability-1', 1)
    const join = sent.find((frame): frame is Extract<CollabFrame, { t: 'room-join' }> => frame.t === 'room-join')
    await expect(reservation.promise).resolves.toEqual({
      reason: 'The encrypted collaboration room did not acknowledge the editor lease.',
    })
    expect(sent).toContainEqual({
      t: 'room-leave',
      room: 'note-1',
      requestId: join!.requestId,
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
    const application = {
      items: { streamItems: () => jest.fn() },
      vaultLocks: { addEventObserver: () => jest.fn() },
      sockets: { addEventObserver: () => jest.fn() },
      addEventObserver: () => jest.fn(),
    } as never
    const note = { uuid: 'note-1' } as never
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
    const inbound = new Set<(frame: CollabFrame) => void>()
    mockedCreateChannel.mockReturnValue({
      isConnected: () => true,
      authorize: jest.fn(),
      send: (frame) => sent.push(frame),
      subscribe: (handler) => {
        inbound.add(handler)
        return () => inbound.delete(handler)
      },
    })
    mockedResolve.mockImplementation((_application, note) => {
      return {
        available: true,
        sourceId: `same-vault:root-version:${note.uuid}`,
      } as never
    })
    mockedPrepare.mockImplementation(async (_application, note) => {
      return {
        available: true,
        sourceId: `same-vault:root-version:${note.uuid}`,
        roomKey: {} as CryptoKey,
        capability: `capability:${note.uuid}`,
        userUuid: 'user-1',
        username: 'Alice',
      }
    })
    const application = {
      items: { streamItems: () => jest.fn() },
      vaultLocks: { addEventObserver: () => jest.fn() },
      sockets: { addEventObserver: () => jest.fn() },
      addEventObserver: () => jest.fn(),
    } as never
    const noteOne = { uuid: 'note-1' } as never
    const noteTwo = { uuid: 'note-2' } as never
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
      await Promise.resolve()
      await Promise.resolve()
    })
    const firstJoin = sent.find(
      (frame): frame is Extract<CollabFrame, { t: 'room-join' }> => frame.t === 'room-join' && frame.room === 'note-1',
    )
    expect(firstJoin).toBeDefined()
    await act(async () => {
      for (const handler of inbound) {
        handler({
          t: 'room-joined',
          room: 'note-1',
          requestId: firstJoin!.requestId,
          bootstrap: true,
        })
      }
      await Promise.resolve()
    })
    expect(latestAccess).toMatchObject({ status: 'ready', capability: 'capability:note-1' })

    const firstSwitchedRender = renders.length
    await act(async () => {
      root.render(createElement(View, { note: noteTwo }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(renders[firstSwitchedRender]).toEqual({ noteUuid: 'note-2', status: 'preparing' })
    expect(
      renders
        .slice(firstSwitchedRender)
        .some((render) => render.noteUuid === 'note-2' && render.capability === 'capability:note-1'),
    ).toBe(false)
    expect(latestAccess).toEqual({ status: 'preparing' })
    expect(sent).toContainEqual({
      t: 'room-leave',
      room: 'note-1',
      requestId: firstJoin!.requestId,
    })
  })

  it('keeps a ready lease when immutable note content is replaced without changing collaboration identity', async () => {
    const sent: CollabFrame[] = []
    const inbound = new Set<(frame: CollabFrame) => void>()
    mockedCreateChannel.mockReturnValue({
      isConnected: () => true,
      authorize: jest.fn(),
      send: (frame) => sent.push(frame),
      subscribe: (handler) => {
        inbound.add(handler)
        return () => inbound.delete(handler)
      },
    })
    mockedResolve.mockReturnValue({
      available: true,
      sourceId: 'same-vault:note-1:root-version',
    } as never)
    mockedPrepare.mockResolvedValue({
      available: true,
      sourceId: 'same-vault:note-1:root-version',
      roomKey: {} as CryptoKey,
      capability: 'capability:note-1',
      userUuid: 'user-1',
      username: 'Alice',
    })
    const application = {
      items: { streamItems: () => jest.fn() },
      vaultLocks: { addEventObserver: () => jest.fn() },
      sockets: { addEventObserver: () => jest.fn() },
      addEventObserver: () => jest.fn(),
    } as never
    const View = ({ note }: { note: { uuid: string; text: string } }) => {
      latestAccess = useCollaborationRoomAccess(application, note as never, true)
      return createElement('div', null, latestAccess.status)
    }

    await act(async () => {
      root.render(createElement(View, { note: { uuid: 'note-1', text: 'before' } }))
      await Promise.resolve()
      await Promise.resolve()
    })
    const join = sent.find((frame): frame is Extract<CollabFrame, { t: 'room-join' }> => frame.t === 'room-join')
    expect(join).toBeDefined()
    await act(async () => {
      for (const handler of inbound) {
        handler({
          t: 'room-joined',
          room: 'note-1',
          requestId: join!.requestId,
          bootstrap: true,
        })
      }
      await Promise.resolve()
    })
    expect(latestAccess).toMatchObject({ status: 'ready', capability: 'capability:note-1' })

    const sentBeforeReplacement = [...sent]
    await act(async () => {
      root.render(createElement(View, { note: { uuid: 'note-1', text: 'after' } }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(latestAccess).toMatchObject({
      status: 'ready',
      capability: 'capability:note-1',
      editorLease: { requestId: join!.requestId },
    })
    expect(sent).toEqual(sentBeforeReplacement)
    expect(mockedPrepare).toHaveBeenCalledTimes(1)
  })

  it('invalidates synchronously and releases the old lease when the vault or root-key identity changes', async () => {
    const sent: CollabFrame[] = []
    const inbound = new Set<(frame: CollabFrame) => void>()
    let activeSourceId = 'vault-1:note-1:root-version-1'
    mockedCreateChannel.mockReturnValue({
      isConnected: () => true,
      authorize: jest.fn(),
      send: (frame) => sent.push(frame),
      subscribe: (handler) => {
        inbound.add(handler)
        return () => inbound.delete(handler)
      },
    })
    mockedResolve.mockImplementation(() => {
      return {
        available: true,
        sourceId: activeSourceId,
      } as never
    })
    mockedPrepare.mockImplementation(async () => {
      return {
        available: true,
        sourceId: activeSourceId,
        roomKey: {} as CryptoKey,
        capability: `capability:${activeSourceId}`,
        userUuid: 'user-1',
        username: 'Alice',
      }
    })
    const application = {
      items: {
        streamItems: (_types: unknown, observer: () => void) => {
          itemObserver = observer
          return jest.fn()
        },
      },
      vaultLocks: { addEventObserver: () => jest.fn() },
      sockets: { addEventObserver: () => jest.fn() },
      addEventObserver: () => jest.fn(),
    } as never
    const note = { uuid: 'note-1' } as never
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
      await Promise.resolve()
      await Promise.resolve()
    })
    const firstJoin = sent.find((frame): frame is Extract<CollabFrame, { t: 'room-join' }> => frame.t === 'room-join')
    expect(firstJoin).toBeDefined()
    await act(async () => {
      for (const handler of inbound) {
        handler({
          t: 'room-joined',
          room: 'note-1',
          requestId: firstJoin!.requestId,
          bootstrap: true,
        })
      }
      await Promise.resolve()
    })
    expect(latestAccess).toMatchObject({
      status: 'ready',
      capability: 'capability:vault-1:note-1:root-version-1',
    })

    const firstChangedIdentityRender = renders.length
    activeSourceId = 'vault-2:note-1:root-version-2'
    await act(async () => {
      itemObserver?.()
      await Promise.resolve()
      await Promise.resolve()
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
    const reservation = beginEditorLeaseReservation({} as never, 'note-1', 'capability-1')
    const join = sent.find((frame): frame is Extract<CollabFrame, { t: 'room-join' }> => frame.t === 'room-join')
    expect(join).toBeDefined()

    reservation.cancel()
    await expect(reservation.promise).resolves.toEqual({
      reason: 'The editor lease was cancelled.',
    })

    expect(sent).toContainEqual({
      t: 'room-leave',
      room: 'note-1',
      requestId: join!.requestId,
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
    const reservation = beginEditorLeaseReservation({} as never, 'note-1', 'capability-1', 1)
    const result = await reservation.promise
    const join = sent.find((frame): frame is Extract<CollabFrame, { t: 'room-join' }> => frame.t === 'room-join')

    expect(result).toEqual({
      reason: 'The encrypted collaboration room did not acknowledge the editor lease.',
    })
    expect(sent).toContainEqual({
      t: 'room-leave',
      room: 'note-1',
      requestId: join!.requestId,
    })
  })
})
