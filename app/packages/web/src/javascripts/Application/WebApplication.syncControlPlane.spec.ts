import { isSyncControlPlaneRefusal } from '@/Services/SyncTransport/WebSocketSyncTransport'
import { WebApplication } from './WebApplication'

type JsonAnswer = { status: number; ok: boolean; data: unknown }

// The control-plane methods are invoked off the prototype against a plain object
// carrying only the two JSON helpers they call, like the other focused specs.
const prototype = WebApplication.prototype as unknown as {
  syncControlPlaneCapabilities: (this: unknown) => Promise<unknown>
  syncControlPlaneTicket: (this: unknown, deviceId: string) => Promise<unknown>
  syncControlPlaneRefusal: unknown
}

function applicationAnswering(answer: JsonAnswer | Error) {
  const respond = async (): Promise<JsonAnswer> => {
    if (answer instanceof Error) {
      throw answer
    }
    return answer
  }
  const serverGetJsonRequest = jest.fn(respond)
  const serverJsonRequest = jest.fn(respond)
  return {
    // The private shaping helper the two methods delegate to has to ride along on the plain object.
    self: { serverGetJsonRequest, serverJsonRequest, syncControlPlaneRefusal: prototype.syncControlPlaneRefusal },
    serverGetJsonRequest,
    serverJsonRequest,
  }
}

const capabilities = (self: unknown) => prototype.syncControlPlaneCapabilities.call(self)
const ticket = (self: unknown, deviceId = 'device-1') => prototype.syncControlPlaneTicket.call(self, deviceId)

describe('WebApplication sync control plane answers', () => {
  it('passes the capability list on from a success answer and reads it from the capabilities endpoint', async () => {
    const { self, serverGetJsonRequest } = applicationAnswering({
      status: 200,
      ok: true,
      data: { capabilities: ['ws-sync', 'invites'] },
    })

    await expect(capabilities(self)).resolves.toEqual({ capabilities: ['ws-sync', 'invites'] })
    expect(serverGetJsonRequest).toHaveBeenCalledWith('/v1/sockets/sync/capabilities')
  })

  it('reports an unreadable success answer as undefined, not as a refusal', async () => {
    const { self } = applicationAnswering({ status: 200, ok: true, data: { unexpected: true } })

    await expect(capabilities(self)).resolves.toBeUndefined()
  })

  it('turns a 404 capability answer into a permanent-looking refusal with its status', async () => {
    const { self } = applicationAnswering({ status: 404, ok: false, data: {} })

    const refusal = await capabilities(self)
    expect(refusal).toEqual({ refused: true, status: 404, transient: false })
    expect(isSyncControlPlaneRefusal(refusal)).toBe(true)
  })

  it('carries the error code and transient flag of a 503 capability answer', async () => {
    const { self } = applicationAnswering({
      status: 503,
      ok: false,
      data: { error: { code: 'SYNC_DISABLED', transient: true } },
    })

    await expect(capabilities(self)).resolves.toEqual({
      refused: true,
      status: 503,
      code: 'SYNC_DISABLED',
      transient: true,
    })
  })

  it('passes a ticket on from a success answer and posts the device id to the ticket endpoint', async () => {
    const issued = { ticket: 'opaque', expiresAt: 1_700_000_030_000 }
    const { self, serverJsonRequest } = applicationAnswering({ status: 201, ok: true, data: issued })

    await expect(ticket(self, 'device-7')).resolves.toBe(issued)
    expect(serverJsonRequest).toHaveBeenCalledWith('/v1/sockets/sync/ticket', { deviceId: 'device-7' })
  })

  it('turns a non-success ticket answer into a refusal that keeps the status and error body', async () => {
    const disabled = applicationAnswering({
      status: 503,
      ok: false,
      data: { error: { code: 'SYNC_DISABLED' } },
    })
    await expect(ticket(disabled.self)).resolves.toEqual({
      refused: true,
      status: 503,
      code: 'SYNC_DISABLED',
      transient: false,
    })

    const missing = applicationAnswering({ status: 501, ok: false, data: 'Not Implemented' })
    const refusal = await ticket(missing.self)
    expect(refusal).toEqual({ refused: true, status: 501, transient: false })
    expect(isSyncControlPlaneRefusal(refusal)).toBe(true)
  })

  it('lets a thrown request propagate from both call sites so it stays retryable', async () => {
    const { self } = applicationAnswering(new Error('network down'))

    await expect(capabilities(self)).rejects.toThrow('network down')
    await expect(ticket(self)).rejects.toThrow('network down')
  })
})
