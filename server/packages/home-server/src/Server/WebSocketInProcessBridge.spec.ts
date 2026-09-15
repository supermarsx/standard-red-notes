import { WebSocketInProcessBridge, type WebSocketPushTarget } from './WebSocketInProcessBridge'
import type { Logger } from 'winston'

const USER = '70000000-0000-4000-8000-000000000001'
const SESSION = '70000000-0000-4000-8000-000000000002'

function logger(): Logger {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as Logger
}

function pushEvent(payload: Record<string, unknown>) {
  return {
    type: 'WEB_SOCKET_MESSAGE_REQUESTED',
    createdAt: new Date(),
    meta: { correlation: { userIdentifier: USER, userIdentifierType: 'uuid' }, origin: 'auth' },
    payload,
  } as never
}

function gatewayDouble(reached = 1): WebSocketPushTarget & { dispatch: jest.Mock } {
  return { dispatch: jest.fn(() => reached) }
}

describe('WebSocketInProcessBridge', () => {
  it('hands a push straight to the attached gateway and counts what it reached', async () => {
    const gateway = gatewayDouble(2)
    const bridge = new WebSocketInProcessBridge(logger(), gateway)

    await bridge.handleMessage(
      pushEvent({ userUuid: USER, message: '{"type":"ITEMS_CHANGED_ON_SERVER"}', originatingSessionUuid: SESSION }),
    )

    expect(gateway.dispatch).toHaveBeenCalledWith({
      userUuid: USER,
      message: '{"type":"ITEMS_CHANGED_ON_SERVER"}',
      originatingSessionUuid: SESSION,
    })
    expect(bridge.health()).toEqual({
      dispatchedPushes: 1,
      socketsReached: 2,
      undeliveredPushes: 0,
      droppedPushes: 0,
    })
  })

  it('omits the echo-suppression key entirely when the event carries none', async () => {
    const gateway = gatewayDouble(1)
    const bridge = new WebSocketInProcessBridge(logger(), gateway)

    await bridge.handleMessage(pushEvent({ userUuid: USER, message: 'hello' }))

    expect(gateway.dispatch).toHaveBeenCalledWith({ userUuid: USER, message: 'hello' })
  })

  it('counts an account with no live socket as undelivered rather than dropped', async () => {
    const bridge = new WebSocketInProcessBridge(logger(), gatewayDouble(0))

    await bridge.handleMessage(pushEvent({ userUuid: USER, message: 'hello' }))

    expect(bridge.health()).toMatchObject({ dispatchedPushes: 1, socketsReached: 0, undeliveredPushes: 1 })
  })

  it('ignores raw strings and every other domain event', async () => {
    const gateway = gatewayDouble()
    const bridge = new WebSocketInProcessBridge(logger(), gateway)

    await bridge.handleMessage('a raw queue message')
    await bridge.handleMessage({
      type: 'ITEMS_SYNCED',
      createdAt: new Date(),
      meta: { correlation: { userIdentifier: USER, userIdentifierType: 'uuid' }, origin: 'auth' },
      payload: { userUuid: USER, message: 'hello' },
    } as never)

    expect(gateway.dispatch).not.toHaveBeenCalled()
    expect(bridge.health()).toMatchObject({ dispatchedPushes: 0, droppedPushes: 0 })
  })

  it('drops a malformed payload with one throttled warn line and no dispatch', async () => {
    const log = logger()
    const gateway = gatewayDouble()
    const bridge = new WebSocketInProcessBridge(log, gateway)

    await bridge.handleMessage(pushEvent({ userUuid: USER }))
    await bridge.handleMessage(pushEvent({ message: 'hello' }))
    await bridge.handleMessage(pushEvent({ userUuid: USER, message: 42 }))

    expect(gateway.dispatch).not.toHaveBeenCalled()
    expect(bridge.health()).toMatchObject({ droppedPushes: 3, dispatchedPushes: 0 })
    // Throttled: three refusals, one line, and the line says how many it covers.
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('malformed push payload'),
      expect.objectContaining({ cause: 'payload', droppedPushes: 1 }),
    )
  })

  it('drops a push while no gateway is attached, and delivers once one is', async () => {
    const log = logger()
    const bridge = new WebSocketInProcessBridge(log)

    await bridge.handleMessage(pushEvent({ userUuid: USER, message: 'hello' }))
    expect(bridge.health()).toMatchObject({ droppedPushes: 1, dispatchedPushes: 0 })
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('no attached gateway'),
      expect.objectContaining({ cause: 'gateway' }),
    )

    const gateway = gatewayDouble(1)
    bridge.setGateway(gateway)
    await bridge.handleMessage(pushEvent({ userUuid: USER, message: 'hello' }))

    expect(gateway.dispatch).toHaveBeenCalledTimes(1)
    expect(bridge.health()).toMatchObject({ droppedPushes: 1, dispatchedPushes: 1, socketsReached: 1 })
  })

  it('counts a throwing dispatch as a dropped push instead of failing the save', async () => {
    const log = logger()
    const bridge = new WebSocketInProcessBridge(log, {
      dispatch: () => {
        throw new Error('registry exploded')
      },
    })

    await expect(bridge.handleMessage(pushEvent({ userUuid: USER, message: 'hello' }))).resolves.toBeUndefined()
    expect(bridge.health()).toMatchObject({ droppedPushes: 1, dispatchedPushes: 0 })
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('dispatch failed'),
      // The redacted classification only: never the thrown message.
      expect.objectContaining({ cause: 'dispatch' }),
    )
    expect(JSON.stringify((log.warn as jest.Mock).mock.calls)).not.toContain('registry exploded')
  })

  it('stops delivering once closed, so a push during shutdown is a counted drop', async () => {
    const gateway = gatewayDouble(1)
    const bridge = new WebSocketInProcessBridge(logger(), gateway)

    await bridge.close()
    await bridge.handleMessage(pushEvent({ userUuid: USER, message: 'hello' }))

    expect(gateway.dispatch).not.toHaveBeenCalled()
    expect(bridge.health()).toMatchObject({ droppedPushes: 1 })
  })

  it('reports a subscriber error without leaking its message', async () => {
    const log = logger()
    const bridge = new WebSocketInProcessBridge(log, gatewayDouble())

    await bridge.handleError(new Error('secret detail'))

    expect(log.error).toHaveBeenCalledWith('WebSocketInProcessBridge domain subscriber error.')
  })
})
