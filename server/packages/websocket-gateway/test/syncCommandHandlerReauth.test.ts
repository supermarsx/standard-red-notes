import { describe, expect, it, vi } from 'vitest'

import { InMemorySyncAuthTicketStore, type SyncAuthTicketStore, type SyncTicketIdentity } from '../src/auth.js'
import { InMemorySyncCommandLeaseRegistry, InMemorySyncSocketBudget } from '../src/registry.js'
import {
  SyncCommandHandler,
  type SyncCommandMetrics,
  type SyncLiveAuthorizationAdapter,
  type SyncCommandBackendAdapter,
  type SyncSessionRefreshDecision,
  type SyncSocket,
} from '../src/syncCommandHandler.js'
import {
  SyncProtocolError,
  digestSyncCommandBody,
  parseSyncClientFrame,
  syncPayloadLength,
  type JsonObject,
} from '../src/syncProtocol.js'

/**
 * Standard Red Notes: in-place session-credential refresh (REAUTH).
 *
 * The defect these cover: a sync socket froze the credential captured at ticket
 * mint and nothing ever refreshed it, so a token rotation stranded every lane
 * that revalidates while HTTP kept working.
 *
 * The property that matters most here is the DANGEROUS direction of the fix. A
 * refresh must never be the thing that keeps a signed-out or revoked session on
 * a live authenticated socket, so `SESSION_REVOKED` terminates the socket and
 * `SESSION_STALE` leaves it on the credential it already had. Both are asserted
 * by what the NEXT frame on the socket is allowed to present, not merely by the
 * error code that came back.
 */

const USER = 'user-1'
const SESSION = 'session-1'
const DEVICE = 'device-1'
const COOKIE_NAME = `access_token_${SESSION}`

const OLD_CREDENTIAL = {
  authorization: 'Bearer 2:private-identifier',
  sessionCookies: { [COOKIE_NAME]: ['cookie-value-old'] },
} as const

const NEW_CREDENTIAL = {
  authorization: 'Bearer 2:private-identifier',
  sessionCookies: { [COOKIE_NAME]: ['cookie-value-rotated'] },
} as const

class FakeSocket implements SyncSocket {
  bufferedAmount = 0
  readonly frames: JsonObject[] = []
  readonly closes: Array<{ code?: number; reason?: string }> = []

  send(data: string | Uint8Array): void {
    this.frames.push(JSON.parse(String(data)) as JsonObject)
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason })
  }
}

/**
 * A ticket store whose `ready()` and `consume()` are scriptable. Redis is behind
 * this interface in production, so a consume can answer anything; the in-memory
 * store alone can never produce a mismatched or malformed identity.
 */
class ScriptedTicketStore implements SyncAuthTicketStore {
  readonly distribution = 'shared' as const
  readyFlag = true
  consumed: string[] = []
  answers: Array<SyncTicketIdentity | undefined> = []

  constructor(private readonly inner = new InMemorySyncAuthTicketStore()) {}

  ready(): boolean {
    return this.readyFlag
  }

  async issue(identity: SyncTicketIdentity, ttlMs?: number): ReturnType<SyncAuthTicketStore['issue']> {
    return this.inner.issue(identity, ttlMs)
  }

  async consume(ticket: string): Promise<SyncTicketIdentity | undefined> {
    this.consumed.push(ticket)
    if (this.answers.length > 0) {
      return this.answers.shift()
    }
    return this.inner.consume(ticket)
  }
}

function reauthFrame(
  sequence: number,
  ticket: string,
  deviceId = DEVICE,
  requestId = `reauth-${sequence}`,
): JsonObject {
  const payload = { ticket, deviceId }
  return {
    version: 1,
    channel: 'sync',
    type: 'REAUTH',
    requestId,
    commandId: requestId,
    sequence,
    payloadLength: syncPayloadLength(payload),
    payload,
  }
}

function authFrame(ticket: string, deviceId = DEVICE): JsonObject {
  const payload = { ticket, deviceId }
  return {
    version: 1,
    channel: 'sync',
    type: 'AUTH',
    requestId: 'auth-request',
    commandId: 'auth-command',
    sequence: 0,
    payloadLength: syncPayloadLength(payload),
    payload,
  }
}

function commandFrame(sequence: number, commandId = `command-${sequence}`): JsonObject {
  const body = { api: '20240226', items: [] }
  const payload = { command: 'SYNC_ITEMS', body }
  return {
    version: 1,
    channel: 'sync',
    type: 'COMMAND',
    requestId: `request-${commandId}`,
    commandId,
    sequence,
    payloadLength: syncPayloadLength(payload),
    payload,
    digest: digestSyncCommandBody(body),
  }
}

function enqueue(handler: SyncCommandHandler, frame: JsonObject): void {
  const raw = JSON.stringify(frame)
  handler.enqueue(raw, Buffer.byteLength(raw, 'utf8'))
}

const committingBackend = (): SyncCommandBackendAdapter => ({
  ready: () => true,
  execute: vi.fn<SyncCommandBackendAdapter['execute']>(async (input) => ({
    digest: input.digest,
    payload: { saved: true },
  })),
  status: vi.fn<SyncCommandBackendAdapter['status']>(async (input) => ({
    status: 'COMMITTED',
    digest: input.digest,
    payload: { saved: true },
  })),
})

type Harness = {
  handler: SyncCommandHandler
  socket: FakeSocket
  tickets: ScriptedTicketStore
  authorization: SyncLiveAuthorizationAdapter
  authorizeCalls: () => SyncTicketIdentity[]
  refreshCalls: () => SyncTicketIdentity[]
  metrics: SyncCommandMetrics & { events: Array<{ event: string; code?: string }> }
  /** Mutable after admission: the session plane can go unready on a live socket. */
  sessionPlane: { ready: boolean }
  /** Mint a ticket the socket could legitimately present on a REAUTH. */
  mint: (overrides?: Partial<SyncTicketIdentity>) => Promise<string>
}

async function authenticated(
  options: {
    refresh?: (identity: SyncTicketIdentity) => Promise<SyncSessionRefreshDecision>
    withoutRefresh?: boolean
  } = {},
): Promise<Harness> {
  const sessionPlane = { ready: true }
  const tickets = new ScriptedTicketStore()
  const socket = new FakeSocket()
  const authorizeCalls: SyncTicketIdentity[] = []
  const refreshCalls: SyncTicketIdentity[] = []
  const events: Array<{ event: string; code?: string }> = []
  const metrics = {
    events,
    increment: (event: string, code?: string) => {
      events.push({ event, code })
    },
  }

  const refresh = options.refresh ?? (async (): Promise<SyncSessionRefreshDecision> => ({ refreshed: true }))
  const authorization: SyncLiveAuthorizationAdapter = {
    ready: () => true,
    sessionAuthorizationReady: () => sessionPlane.ready,
    authorize: vi.fn<SyncLiveAuthorizationAdapter['authorize']>(async (input) => {
      authorizeCalls.push(input.identity)
      return { authorized: true }
    }),
    ...(options.withoutRefresh
      ? {}
      : {
          refreshSession: vi.fn<NonNullable<SyncLiveAuthorizationAdapter['refreshSession']>>(async (input) => {
            refreshCalls.push(input.identity)
            return refresh(input.identity)
          }),
        }),
  }

  const admission = await tickets.issue({
    userUuid: USER,
    sessionUuid: SESSION,
    deviceId: DEVICE,
    ...OLD_CREDENTIAL,
  })
  const handler = new SyncCommandHandler({
    socket,
    ownerId: `owner-${Math.random()}`,
    tickets,
    leases: new InMemorySyncCommandLeaseRegistry(),
    socketBudget: new InMemorySyncSocketBudget(),
    authorization,
    backend: committingBackend(),
    metrics,
    isEnabled: () => true,
  })
  enqueue(handler, authFrame(admission.ticket))
  await vi.waitFor(() => expect(socket.frames.at(-1)?.type).toBe('AUTHENTICATED'))

  return {
    handler,
    socket,
    tickets,
    authorization,
    authorizeCalls: () => authorizeCalls,
    refreshCalls: () => refreshCalls,
    metrics,
    sessionPlane,
    mint: async (overrides = {}) => {
      const issued = await tickets.issue({
        userUuid: USER,
        sessionUuid: SESSION,
        deviceId: DEVICE,
        ...NEW_CREDENTIAL,
        ...overrides,
      })
      return issued.ticket
    },
  }
}

const lastFrame = (socket: FakeSocket): JsonObject => {
  const frame = socket.frames.at(-1)
  if (!frame) {
    throw new Error('expected at least one server frame')
  }
  return frame
}

const payloadOf = (frame: JsonObject): JsonObject => {
  const payload = frame.payload
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`expected an object payload, got ${JSON.stringify(frame)}`)
  }
  return payload as JsonObject
}

/** The credential the socket actually presents, read off its next authorization. */
async function credentialPresentedOnNextCommand(harness: Harness, sequence: number): Promise<SyncTicketIdentity> {
  const before = harness.authorizeCalls().length
  enqueue(harness.handler, commandFrame(sequence))
  await vi.waitFor(() => expect(harness.authorizeCalls().length).toBeGreaterThan(before))
  return harness.authorizeCalls()[before]
}

describe('REAUTH frame parsing', () => {
  it('accepts a well-formed mid-stream refresh and rejects sequence 0', () => {
    const ticket = 'a'.repeat(43)
    expect(parseSyncClientFrame(JSON.stringify(reauthFrame(1, ticket))).type).toBe('REAUTH')
    expect(() => parseSyncClientFrame(JSON.stringify(reauthFrame(0, ticket)))).toThrow(SyncProtocolError)
  })

  it('refuses a resumeSequence, an unknown payload key and a malformed ticket', () => {
    const ticket = 'a'.repeat(43)
    const withResume = reauthFrame(1, ticket)
    const resumePayload = { ticket, deviceId: DEVICE, resumeSequence: 0 }
    withResume.payload = resumePayload
    withResume.payloadLength = syncPayloadLength(resumePayload)
    expect(() => parseSyncClientFrame(JSON.stringify(withResume))).toThrow(/Invalid REAUTH frame fields/)

    const shortTicket = reauthFrame(1, 'too-short')
    expect(() => parseSyncClientFrame(JSON.stringify(shortTicket))).toThrow(/Invalid REAUTH payload/)

    const badDevice = reauthFrame(1, ticket, '-not-an-identifier')
    expect(() => parseSyncClientFrame(JSON.stringify(badDevice))).toThrow(/Invalid REAUTH payload/)
  })
})

describe('SyncCommandHandler credential refresh', () => {
  it('adopts the refreshed credential, so the next command presents the rotated one', async () => {
    const harness = await authenticated()
    const presentedBefore = await credentialPresentedOnNextCommand(harness, 1)
    expect(presentedBefore.sessionCookies?.[COOKIE_NAME]).toEqual(['cookie-value-old'])

    enqueue(harness.handler, reauthFrame(2, await harness.mint()))
    await vi.waitFor(() => expect(lastFrame(harness.socket).type).toBe('REAUTHENTICATED'))
    expect(harness.socket.closes).toHaveLength(0)

    // The credential handed to the session plane is the NEW one, assembled from
    // the ticket -- never a mixture of the new bearer and the old cookie.
    expect(harness.refreshCalls()).toHaveLength(1)
    expect(harness.refreshCalls()[0].sessionCookies?.[COOKIE_NAME]).toEqual(['cookie-value-rotated'])
    expect(harness.refreshCalls()[0].userUuid).toBe(USER)
    expect(harness.refreshCalls()[0].sessionUuid).toBe(SESSION)
    expect(harness.refreshCalls()[0].deviceId).toBe(DEVICE)

    const presentedAfter = await credentialPresentedOnNextCommand(harness, 3)
    expect(presentedAfter.sessionCookies?.[COOKIE_NAME]).toEqual(['cookie-value-rotated'])
    expect(harness.metrics.events).toContainEqual({ event: 'reauth', code: 'accepted' })
  })

  it('adopts the credential as ONE unit, never reviving the cookie it replaced', async () => {
    const harness = await authenticated()
    const cookieless = await harness.mint({ sessionCookies: undefined })

    enqueue(harness.handler, reauthFrame(1, cookieless))
    await vi.waitFor(() => expect(lastFrame(harness.socket).type).toBe('REAUTHENTICATED'))

    // The previously captured cookie must NOT survive alongside the new bearer:
    // validating one credential and then replaying a different combination of
    // halves is a state no real request ever presented.
    expect(harness.refreshCalls()[0].sessionCookies).toBeUndefined()
    const presented = await credentialPresentedOnNextCommand(harness, 2)
    expect(presented.sessionCookies).toBeUndefined()
  })

  it('TERMINATES the socket on SESSION_REVOKED and serves nothing more on it', async () => {
    const harness = await authenticated({
      refresh: async () => ({ refreshed: false, code: 'SESSION_REVOKED' }),
    })
    const authorizationsBefore = harness.authorizeCalls().length

    enqueue(harness.handler, reauthFrame(1, await harness.mint()))
    await vi.waitFor(() => expect(harness.socket.closes).toHaveLength(1))

    const error = lastFrame(harness.socket)
    expect(error.type).toBe('ERROR')
    // The collapsed public code, and NOT retryable: the client must not treat a
    // revoked session as a condition another ticket can fix.
    expect(payloadOf(error)).toMatchObject({ code: 'NOT_AUTHORIZED', retryable: false })
    expect(harness.socket.closes[0].code).toBe(1008)
    expect(harness.metrics.events).toContainEqual({ event: 'reauth', code: 'revoked' })

    // The lane is over: a command that follows is never authorized, so neither
    // the refused credential NOR the one the socket arrived with is presented
    // to the session plane again.
    enqueue(harness.handler, commandFrame(2))
    await harness.handler.drain()
    expect(harness.authorizeCalls()).toHaveLength(authorizationsBefore)
  })

  it('keeps the socket on its EXISTING credential when the refresh is SESSION_STALE', async () => {
    const harness = await authenticated({
      refresh: async () => ({ refreshed: false, code: 'SESSION_STALE' }),
    })

    enqueue(harness.handler, reauthFrame(1, await harness.mint()))
    await vi.waitFor(() => expect(lastFrame(harness.socket).type).toBe('ERROR'))
    expect(payloadOf(lastFrame(harness.socket))).toMatchObject({ code: 'SESSION_STALE', retryable: true })
    expect(harness.socket.closes).toHaveLength(0)

    const presented = await credentialPresentedOnNextCommand(harness, 2)
    expect(presented.sessionCookies?.[COOKIE_NAME]).toEqual(['cookie-value-old'])
    expect(harness.metrics.events).toContainEqual({ event: 'reauth', code: 'stale' })
  })

  it('adopts nothing and terminates nothing when the verdict is unknown', async () => {
    const harness = await authenticated({
      refresh: async () => {
        throw new Error('auth unreachable')
      },
    })

    enqueue(harness.handler, reauthFrame(1, await harness.mint()))
    await vi.waitFor(() => expect(lastFrame(harness.socket).type).toBe('ERROR'))
    expect(payloadOf(lastFrame(harness.socket))).toMatchObject({ code: 'SESSION_STALE', retryable: true })
    expect(harness.socket.closes).toHaveLength(0)

    const presented = await credentialPresentedOnNextCommand(harness, 2)
    expect(presented.sessionCookies?.[COOKIE_NAME]).toEqual(['cookie-value-old'])
    expect(harness.metrics.events).toContainEqual({ event: 'reauth', code: 'error' })
  })

  it('refuses a ticket minted for another session or user without consulting the session plane', async () => {
    const harness = await authenticated()
    const foreign = await harness.mint({ userUuid: 'user-2', sessionUuid: 'session-2' })

    enqueue(harness.handler, reauthFrame(1, foreign))
    await vi.waitFor(() => expect(harness.socket.closes).toHaveLength(1))

    expect(payloadOf(lastFrame(harness.socket))).toMatchObject({ code: 'REAUTH_REJECTED', retryable: false })
    // Never revalidated, so the foreign credential was never even a candidate.
    expect(harness.refreshCalls()).toHaveLength(0)
    expect(harness.metrics.events).toContainEqual({ event: 'reauth', code: 'rejected' })
  })

  it('refuses a ticket minted for another device', async () => {
    const harness = await authenticated()
    const otherDevice = await harness.mint({ deviceId: 'device-2' })

    // The frame has to claim the device its ticket was minted for, or the frame
    // check alone would hide the identity check behind it.
    enqueue(harness.handler, reauthFrame(1, otherDevice, 'device-2'))
    await vi.waitFor(() => expect(harness.socket.closes).toHaveLength(1))
    expect(payloadOf(lastFrame(harness.socket))).toMatchObject({ code: 'REAUTH_REJECTED' })
    expect(harness.refreshCalls()).toHaveLength(0)
  })

  it('refuses a device the frame claims but the ticket does not carry', async () => {
    const harness = await authenticated()
    enqueue(harness.handler, reauthFrame(1, await harness.mint(), 'device-2'))
    await vi.waitFor(() => expect(harness.socket.closes).toHaveLength(1))
    expect(payloadOf(lastFrame(harness.socket))).toMatchObject({ code: 'REAUTH_REJECTED' })
    expect(harness.refreshCalls()).toHaveLength(0)
  })

  it('refuses an unknown ticket, and the same ticket a second time', async () => {
    const harness = await authenticated()
    enqueue(harness.handler, reauthFrame(1, 'z'.repeat(43)))
    await vi.waitFor(() => expect(harness.socket.closes).toHaveLength(1))
    expect(payloadOf(lastFrame(harness.socket))).toMatchObject({ code: 'REAUTH_REJECTED' })

    const replay = await authenticated()
    const ticket = await replay.mint()
    enqueue(replay.handler, reauthFrame(1, ticket))
    await vi.waitFor(() => expect(lastFrame(replay.socket).type).toBe('REAUTHENTICATED'))
    enqueue(replay.handler, reauthFrame(2, ticket))
    await vi.waitFor(() => expect(replay.socket.closes).toHaveLength(1))
    expect(payloadOf(lastFrame(replay.socket))).toMatchObject({ code: 'REAUTH_REJECTED' })
  })

  it('refuses a stored identity the ticket store itself should never have produced', async () => {
    const harness = await authenticated()
    // Matching routing fields, but a credential outside the store's own bounds.
    harness.tickets.answers.push({
      userUuid: USER,
      sessionUuid: SESSION,
      deviceId: DEVICE,
      authorization: `Bearer ${'x'.repeat(16_400)}`,
    })

    enqueue(harness.handler, reauthFrame(1, await harness.mint()))
    await vi.waitFor(() => expect(harness.socket.closes).toHaveLength(1))
    expect(payloadOf(lastFrame(harness.socket))).toMatchObject({ code: 'REAUTH_REJECTED' })
    expect(harness.refreshCalls()).toHaveLength(0)
  })

  it('refuses the frame outright when the adapter cannot revalidate a credential', async () => {
    const harness = await authenticated({ withoutRefresh: true })

    enqueue(harness.handler, reauthFrame(1, await harness.mint()))
    await vi.waitFor(() => expect(lastFrame(harness.socket).type).toBe('ERROR'))
    expect(payloadOf(lastFrame(harness.socket))).toMatchObject({ code: 'OPERATION_UNAVAILABLE' })
    expect(harness.socket.closes).toHaveLength(0)
    // No ticket was spent on a capability that does not exist.
    expect(harness.tickets.consumed).toHaveLength(1)

    const presented = await credentialPresentedOnNextCommand(harness, 2)
    expect(presented.sessionCookies?.[COOKIE_NAME]).toEqual(['cookie-value-old'])
  })

  it('refuses the frame when the session plane itself is not ready', async () => {
    const harness = await authenticated()
    // Readiness is checked at the moment of use, not inherited from admission:
    // a plane that went away after the socket was admitted cannot be the thing
    // that lets an unverified credential through.
    harness.sessionPlane.ready = false

    enqueue(harness.handler, reauthFrame(1, await harness.mint()))
    await vi.waitFor(() => expect(lastFrame(harness.socket).type).toBe('ERROR'))
    expect(payloadOf(lastFrame(harness.socket))).toMatchObject({ code: 'OPERATION_UNAVAILABLE' })
    expect(harness.socket.closes).toHaveLength(0)
    expect(harness.refreshCalls()).toHaveLength(0)
  })

  it('refuses retryably while the ticket store is unready, without spending the attempt budget', async () => {
    const harness = await authenticated()
    harness.tickets.readyFlag = false

    // A whole budget's worth of refusals, because a flap can last. If any of
    // them were counted, the socket would be closed before the store returned.
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      enqueue(harness.handler, reauthFrame(attempt, await harness.mint()))
      await vi.waitFor(() =>
        expect(harness.socket.frames.filter((frame) => frame.type === 'ERROR')).toHaveLength(attempt),
      )
      expect(payloadOf(lastFrame(harness.socket))).toMatchObject({ code: 'SESSION_STALE', retryable: true })
    }
    expect(harness.socket.closes).toHaveLength(0)
    expect(harness.metrics.events).toContainEqual({ event: 'reauth', code: 'store_unavailable' })

    // A store flap must not close an established socket, so the budget it would
    // have spent is still there once the store comes back.
    harness.tickets.readyFlag = true
    enqueue(harness.handler, reauthFrame(9, await harness.mint()))
    await vi.waitFor(() => expect(lastFrame(harness.socket).type).toBe('REAUTHENTICATED'))
    expect(harness.socket.closes).toHaveLength(0)
  })

  it('serves a bounded number of refreshes and ends the socket past it', async () => {
    const harness = await authenticated()
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      enqueue(harness.handler, reauthFrame(attempt, await harness.mint()))
      await vi.waitFor(() =>
        expect(harness.socket.frames.filter((f) => f.type === 'REAUTHENTICATED')).toHaveLength(attempt),
      )
    }
    expect(harness.socket.closes).toHaveLength(0)

    enqueue(harness.handler, reauthFrame(9, await harness.mint()))
    await vi.waitFor(() => expect(harness.socket.closes).toHaveLength(1))
    expect(payloadOf(lastFrame(harness.socket))).toMatchObject({ code: 'REAUTH_REJECTED' })
    expect(harness.metrics.events).toContainEqual({ event: 'reauth', code: 'exhausted' })
  })

  it('cannot stand in for admission: a REAUTH before AUTH closes the socket', async () => {
    const tickets = new ScriptedTicketStore()
    const socket = new FakeSocket()
    const issued = await tickets.issue({
      userUuid: USER,
      sessionUuid: SESSION,
      deviceId: DEVICE,
      ...OLD_CREDENTIAL,
    })
    const handler = new SyncCommandHandler({
      socket,
      ownerId: 'owner-admission',
      tickets,
      leases: new InMemorySyncCommandLeaseRegistry(),
      socketBudget: new InMemorySyncSocketBudget(),
      authorization: {
        ready: () => true,
        authorize: vi.fn<SyncLiveAuthorizationAdapter['authorize']>(async () => ({ authorized: true })),
        refreshSession: vi.fn<NonNullable<SyncLiveAuthorizationAdapter['refreshSession']>>(async () => ({
          refreshed: true,
        })),
      },
      backend: committingBackend(),
      isEnabled: () => true,
    })

    enqueue(handler, reauthFrame(1, issued.ticket))
    await vi.waitFor(() => expect(socket.closes).toHaveLength(1))
    expect(payloadOf(lastFrame(socket))).toMatchObject({ code: 'AUTH_REQUIRED' })
    // The ticket was never consumed, so admission can still use it.
    expect(tickets.consumed).toHaveLength(0)
  })
})
