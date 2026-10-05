import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import WebSocket from 'ws'

vi.mock('ioredis', () => ({
  Redis: class {
    get status(): string {
      return 'ready'
    }
    on(): this {
      return this
    }
    subscribe(_channel: string, callback: (error: null, count: number) => void): void {
      callback(null, 1)
    }
    async quit(): Promise<void> {}
    disconnect(): void {}
  },
}))

import {
  attachWebSocketGateway,
  MAX_REPORTED_ADMISSION_EVENTS,
  MAX_REPORTED_LIVE_SOCKETS,
  MAX_REPORTED_ORIGIN_RULES,
  SOCKET_REJECTION_COUNTERS,
  type AdmissionProbe,
  type GatewayAdmission,
  type GatewayConfig,
  type SyncGatewayOptions,
} from '../src/gateway.js'

/**
 * Standard Red Notes: the admission and traffic counters.
 *
 * The panel's whole "Gateway admission and traffic" block is all-or-nothing —
 * one defined member renders all ten rows — so these tests are written to the
 * question "does each counter MOVE in response to the thing it names", not to
 * "is the field present". A counter that only ever reads zero is the exact
 * failure the block existed to avoid.
 */

const CONNECTION_SECRET = 'connection-secret'
const APP_ORIGIN = 'https://app.example.test'

function baseConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    connectionTokenSecret: CONNECTION_SECRET,
    connectionTokenTtl: '60s',
    internalSecret: 'internal-secret',
    authJwtSecret: 'auth-jwt-secret',
    redisHost: '',
    redisPort: 6379,
    ...overrides,
  }
}

const makeLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })

const syncOptions = (overrides: Partial<SyncGatewayOptions> = {}): SyncGatewayOptions =>
  ({
    isEnabled: () => true,
    allowedOrigins: [APP_ORIGIN],
    authorization: { ready: () => true, authorize: vi.fn(async () => ({ authorized: true as const })) },
    backend: {
      ready: () => true,
      execute: vi.fn(async (input: { digest: string }) => ({ digest: input.digest, payload: { ok: true } })),
      status: vi.fn(async (input: { digest: string }) => ({ status: 'UNKNOWN' as const, digest: input.digest })),
    },
    ...overrides,
  }) as unknown as SyncGatewayOptions

let httpServer: Server
let port: number
let attached: ReturnType<typeof attachWebSocketGateway> | undefined

async function listen(): Promise<number> {
  httpServer = createServer()
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))

  return (httpServer.address() as AddressInfo).port
}

async function attach(overrides: Partial<SyncGatewayOptions> = {}): Promise<void> {
  port = await listen()
  attached = attachWebSocketGateway({
    httpServer,
    config: baseConfig(),
    logger: makeLogger(),
    sharedState: 'in-process',
    sync: syncOptions(overrides),
  })
}

const closed = (socket: WebSocket): Promise<number> =>
  new Promise((resolve) => socket.once('close', (code) => resolve(code)))

const opened = (socket: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })

const nextJson = (socket: WebSocket): Promise<Record<string, unknown>> =>
  new Promise((resolve) => socket.once('message', (data) => resolve(JSON.parse(data.toString()))))

const authFrame = (ticket: string, deviceId: string): string => {
  const payload = { ticket, deviceId }

  return JSON.stringify({
    version: 1,
    channel: 'sync',
    type: 'AUTH',
    requestId: 'auth-request',
    commandId: 'auth-command',
    sequence: 0,
    payloadLength: Buffer.byteLength(JSON.stringify(payload)),
    payload,
  })
}

const admission = (probe: AdmissionProbe = {}): GatewayAdmission => attached!.admission(probe)

afterEach(async () => {
  await attached?.stop()
  attached = undefined
  if (httpServer?.listening) {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()))
  }
  vi.clearAllMocks()
})

describe('admission(): the three refusal counters', () => {
  it('counts each refusal against its own closed cause, and only that one', async () => {
    await attach()
    expect(admission().rejections).toEqual({ originNotAllowed: 0, queryStringNotPermitted: 0, unavailable: 0 })

    expect(await closed(new WebSocket(`ws://127.0.0.1:${port}/sockets/sync`, { origin: 'https://evil.example' }))).toBe(
      1008,
    )
    expect(admission().rejections).toEqual({ originNotAllowed: 1, queryStringNotPermitted: 0, unavailable: 0 })

    // An origin header that is absent entirely is the same refusal: a browser
    // always sends one, so the count must not quietly ignore the caller who
    // did not.
    expect(await closed(new WebSocket(`ws://127.0.0.1:${port}/sockets/sync`))).toBe(1008)
    expect(admission().rejections.originNotAllowed).toBe(2)

    // A query string is refused BEFORE the origin is considered, so an allowed
    // origin carrying one lands in the query counter and nowhere else.
    expect(await closed(new WebSocket(`ws://127.0.0.1:${port}/sockets/sync?ticket=x`, { origin: APP_ORIGIN }))).toBe(
      1008,
    )
    expect(admission().rejections).toEqual({ originNotAllowed: 2, queryStringNotPermitted: 1, unavailable: 0 })
  })

  it('counts a lane that is not serving separately from a client that is not allowed', async () => {
    let enabled = false
    await attach({ isEnabled: () => enabled })

    expect(await closed(new WebSocket(`ws://127.0.0.1:${port}/sockets/sync`, { origin: APP_ORIGIN }))).toBe(1013)
    expect(admission().rejections).toEqual({ originNotAllowed: 0, queryStringNotPermitted: 0, unavailable: 1 })

    // The same client, once the lane serves: nothing further is counted, which
    // is what makes a non-zero `unavailable` readable as a window rather than
    // as a property of the client.
    enabled = true
    const admitted = new WebSocket(`ws://127.0.0.1:${port}/sockets/sync`, { origin: APP_ORIGIN })
    await opened(admitted)
    expect(admission().rejections.unavailable).toBe(1)
    admitted.close()
  })

  it('keeps counting across reconnects: the counters belong to the attach, not to a socket', async () => {
    await attach()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(
        await closed(new WebSocket(`ws://127.0.0.1:${port}/sockets/sync`, { origin: 'https://evil.example' })),
      ).toBe(1008)
    }

    // Three separate sockets, each closed before the next opened. A per-socket
    // counter would read 1 here, which is the defect this block exists to not
    // have.
    expect(admission().rejections.originNotAllowed).toBe(3)
  })

  it('maps every close reason to a counter, with no cause counted twice', () => {
    expect(Object.keys(SOCKET_REJECTION_COUNTERS).sort()).toEqual([
      'origin-not-allowed',
      'query-string-not-permitted',
      'unavailable',
    ])
    expect(new Set(Object.values(SOCKET_REJECTION_COUNTERS)).size).toBe(3)
  })
})

describe('admission(): tickets', () => {
  it('counts a minted ticket and a refused mint in separate counters', async () => {
    let enabled = true
    await attach({ isEnabled: () => enabled })
    expect(admission()).toMatchObject({ ticketsIssued: 0, ticketsRefused: 0 })

    await attached!.sync.issueTicket({ userUuid: 'user-1', sessionUuid: 'session-1', deviceId: 'device-1' })
    await attached!.sync.issueTicket({ userUuid: 'user-1', sessionUuid: 'session-1', deviceId: 'device-2' })
    expect(admission()).toMatchObject({ ticketsIssued: 2, ticketsRefused: 0 })

    enabled = false
    await expect(
      attached!.sync.issueTicket({ userUuid: 'user-1', sessionUuid: 'session-1', deviceId: 'device-1' }),
    ).rejects.toThrow(/unavailable/i)
    expect(admission()).toMatchObject({ ticketsIssued: 2, ticketsRefused: 1 })
  })

  it('counts a mint the ticket store failed as refused rather than as nothing', async () => {
    port = await listen()
    attached = attachWebSocketGateway({
      httpServer,
      config: baseConfig(),
      logger: makeLogger(),
      sharedState: 'in-process',
      sync: syncOptions({
        tickets: {
          distribution: 'process',
          ready: () => true,
          issue: async () => {
            throw new Error('store is down')
          },
          consume: async () => undefined,
        } as unknown as SyncGatewayOptions['tickets'],
      }),
    })

    await expect(
      attached.sync.issueTicket({ userUuid: 'user-1', sessionUuid: 'session-1', deviceId: 'device-1' }),
    ).rejects.toThrow('store is down')
    // The deployment whose STORE is the broken thing is the one an operator is
    // reading this row on. Counting only the precondition arm would show zero
    // refusals there.
    expect(admission()).toMatchObject({ ticketsIssued: 0, ticketsRefused: 1 })
  })
})

describe('admission(): handshakes', () => {
  it('counts a presented ticket the gateway would not take, and survives the reconnect that follows', async () => {
    await attach()
    expect(admission().handshakeRejected).toBe(0)

    // A ticket the store never minted, but WELL-FORMED: the envelope requires
    // 32..256 characters, and a short string would be refused as a protocol
    // error before the ticket is ever consulted — which counts nothing, and
    // would make this test pass against a counter that does not exist.
    for (const ticket of ['t'.repeat(43), 'u'.repeat(64)]) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/sockets/sync`, { origin: APP_ORIGIN })
      await opened(socket)
      const answer = nextJson(socket)
      socket.send(authFrame(ticket, 'device-1'))
      expect(await answer).toMatchObject({ payload: { code: 'AUTH_REJECTED' } })
      await closed(socket)
    }

    // Two sockets, both gone. The count lives in the gateway.
    expect(admission().handshakeRejected).toBe(2)
  })

  it('does not count a ticket minted for another device as anything but a handshake rejection', async () => {
    await attach()
    const issued = await attached!.sync.issueTicket({
      userUuid: 'user-1',
      sessionUuid: 'session-1',
      deviceId: 'device-1',
    })
    const socket = new WebSocket(`ws://127.0.0.1:${port}/sockets/sync`, { origin: APP_ORIGIN })
    await opened(socket)
    const answer = nextJson(socket)
    socket.send(authFrame(issued.ticket, 'device-2'))
    expect(await answer).toMatchObject({ payload: { code: 'AUTH_REJECTED' } })

    expect(admission()).toMatchObject({ ticketsIssued: 1, ticketsRefused: 0, handshakeRejected: 1 })
    expect(admission().rejections.originNotAllowed).toBe(0)
  })

  it('leaves the counter alone for a handshake that succeeds', async () => {
    await attach()
    const issued = await attached!.sync.issueTicket({
      userUuid: 'user-1',
      sessionUuid: 'session-1',
      deviceId: 'device-1',
    })
    const socket = new WebSocket(`ws://127.0.0.1:${port}/sockets/sync`, { origin: APP_ORIGIN })
    await opened(socket)
    const answer = nextJson(socket)
    socket.send(authFrame(issued.ticket, 'device-1'))
    expect(await answer).toMatchObject({ type: 'AUTHENTICATED' })

    expect(admission().handshakeRejected).toBe(0)
    socket.close()
  })
})

describe('admission(): the live socket gauge', () => {
  it('rises with an open socket and falls when it closes', async () => {
    await attach()
    expect(admission().liveSockets).toBe(0)

    const first = new WebSocket(`ws://127.0.0.1:${port}/sockets/sync`, { origin: APP_ORIGIN })
    await opened(first)
    const second = new WebSocket(`ws://127.0.0.1:${port}/sockets/sync`, { origin: APP_ORIGIN })
    await opened(second)
    expect(admission().liveSockets).toBe(2)

    const gone = closed(second)
    second.close()
    await gone
    // The server side of a close is not instantaneous; the gauge is read after
    // the server has actually let go of it.
    await vi.waitFor(() => expect(admission().liveSockets).toBe(1))
    first.close()
  })
})

describe('admission(): the origin question', () => {
  it('answers yes for a listed origin and no for one nobody added', async () => {
    await attach()

    expect(admission({ origin: APP_ORIGIN }).originAdmitted).toBe(true)
    expect(admission({ origin: 'https://evil.example' }).originAdmitted).toBe(false)
    // Asking the question does not count a refusal: a diagnostics read is not
    // a client being turned away.
    expect(admission().rejections.originNotAllowed).toBe(0)
  })

  it('omits the answer rather than saying no when the caller named no origin', async () => {
    await attach()

    expect(admission()).not.toHaveProperty('originAdmitted')
    expect(admission({ host: 'app.example.test' })).not.toHaveProperty('originAdmitted')
    // Present but unparseable IS a no: that is what the upgrade path does with
    // it, and the honest answer is the one the socket would give.
    expect(admission({ origin: 'not an origin' }).originAdmitted).toBe(false)
  })

  it('runs the same same-origin rule the upgrade runs, including the forwarded scheme', async () => {
    await attach({ allowedOrigins: [], allowSameOrigin: true })

    const sameOrigin = {
      origin: 'https://notes.example',
      host: 'notes.example:443',
      forwardedProto: 'https',
    }
    expect(admission(sameOrigin).originAdmitted).toBe(true)
    expect(admission({ ...sameOrigin, origin: 'https://notes.example:444' }).originAdmitted).toBe(false)
    expect(admission({ ...sameOrigin, origin: 'http://notes.example' }).originAdmitted).toBe(false)
    expect(admission({ ...sameOrigin, origin: 'https://evil.example' }).originAdmitted).toBe(false)
  })

  it('accepts a port a proxy normalised away ONLY when the caller asks for that widening', async () => {
    await attach({ allowedOrigins: [], allowSameOrigin: true })

    // The single container's nginx: `/v1` is forwarded with the port stripped
    // while `/sockets` keeps it. Strict, this is the conclusive NO that paints
    // a healthy deployment broken.
    const proxied = { origin: 'http://localhost:3001', host: 'localhost', forwardedProto: 'http' }
    expect(admission(proxied).originAdmitted).toBe(false)
    expect(admission({ ...proxied, proxyNormalizedHostPort: true }).originAdmitted).toBe(true)

    // The widening is confined to a host with NO port. A host that names one is
    // compared strictly even when the widening is asked for, which is what
    // keeps the multi-container answer conclusive.
    const twoPorts = { origin: 'http://localhost:3001', host: 'localhost:3000', forwardedProto: 'http' }
    expect(admission({ ...twoPorts, proxyNormalizedHostPort: true }).originAdmitted).toBe(false)

    // And it never crosses a hostname or a scheme.
    expect(
      admission({ origin: 'http://evil.example', host: 'localhost', proxyNormalizedHostPort: true }).originAdmitted,
    ).toBe(false)
    expect(
      admission({
        origin: 'https://localhost:3001',
        host: 'localhost',
        forwardedProto: 'http',
        proxyNormalizedHostPort: true,
      }).originAdmitted,
    ).toBe(false)
  })

  it('agrees with what the socket actually does, origin for origin', async () => {
    await attach()

    // The door refuses AFTER the upgrade completes (the close is 1008 on an
    // opened socket), so "did it open" proves nothing; what separates the two
    // is whether a close arrives.
    for (const [origin, expected] of [
      [APP_ORIGIN, true],
      ['https://evil.example', false],
    ] as const) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/sockets/sync`, { origin })
      const closeCode = await Promise.race([
        closed(socket),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 250)),
      ])
      expect(closeCode === undefined).toBe(expected)
      expect(admission({ origin }).originAdmitted).toBe(expected)
      socket.close()
    }
  })
})

describe('admission(): the configuration half', () => {
  it('counts origin RULES so that zero means the lane admits nobody', async () => {
    await attach({ allowedOrigins: [APP_ORIGIN, 'tauri://localhost'], allowSameOrigin: false })
    expect(admission()).toMatchObject({ allowedOriginCount: 2, allowsSameOrigin: false })

    await attached!.stop()
    attached = undefined

    // The bundled single container: an EMPTY allowlist, because same-origin
    // admission covers it. The raw cardinality would be zero, which the panel
    // renders as broken — and the lane's own `no-allowed-origins` precondition
    // is NOT met here, so broken would be wrong.
    await attach({ allowedOrigins: [], allowSameOrigin: true })
    expect(admission()).toMatchObject({ allowedOriginCount: 1, allowsSameOrigin: true })
    expect(attached!.sync.unavailabilityReasons?.()).not.toContain('no-allowed-origins')

    await attached!.stop()
    attached = undefined

    // Zero rules, and the lane says the same thing in its own vocabulary.
    await attach({ allowedOrigins: [], allowSameOrigin: false })
    expect(admission().allowedOriginCount).toBe(0)
    expect(attached!.sync.unavailabilityReasons?.()).toContain('no-allowed-origins')
  })

  it('does not count an origin the gateway refused to normalise', async () => {
    // A wildcard and a malformed entry are dropped at normalisation, so the
    // rule count must not report rules that cannot admit anyone.
    await attach({ allowedOrigins: ['*', 'not-an-origin', APP_ORIGIN], allowSameOrigin: false })

    expect(admission().allowedOriginCount).toBe(1)
  })
})

describe('admission(): the emitted contract', () => {
  /**
   * The structural assertion. Every key must be named here, every value must
   * satisfy its declared bound or type — so a field added later with no
   * sentinel planted in it fails, which is the arm a denylist cannot have.
   */
  const CONTRACT: Record<string, { kind: 'boolean' } | { kind: 'bound'; max: number }> = {
    originAdmitted: { kind: 'boolean' },
    allowedOriginCount: { kind: 'bound', max: MAX_REPORTED_ORIGIN_RULES },
    allowsSameOrigin: { kind: 'boolean' },
    liveSockets: { kind: 'bound', max: MAX_REPORTED_LIVE_SOCKETS },
    ticketsIssued: { kind: 'bound', max: MAX_REPORTED_ADMISSION_EVENTS },
    ticketsRefused: { kind: 'bound', max: MAX_REPORTED_ADMISSION_EVENTS },
    handshakeRejected: { kind: 'bound', max: MAX_REPORTED_ADMISSION_EVENTS },
  }

  const assertLeaf = (key: string, value: unknown): void => {
    const rule = CONTRACT[key]
    if (rule === undefined) {
      throw new Error(`admission.${key} is emitted but not named in the contract`)
    }
    if (rule.kind === 'boolean') {
      expect(typeof value).toBe('boolean')
    } else {
      expect(typeof value).toBe('number')
      expect(Number.isInteger(value)).toBe(true)
      expect(value as number).toBeGreaterThanOrEqual(0)
      expect(value as number).toBeLessThanOrEqual(rule.max)
    }
  }

  it('emits nothing but booleans and bounded counts, over a hostile allowlist and a hostile origin', async () => {
    // Every entry is a different shape of disclosure, and one of them is even
    // admissible as an origin. None of them may appear in the block, and the
    // block must still be fully populated so the sweep is not passing over an
    // empty payload.
    await attach({
      allowedOrigins: [
        APP_ORIGIN,
        'https://admin:hunter2@notes.internal.example:8443',
        'redis://someuser:somepassword@redis.internal.example:6379/2',
        'https://std-notes.internal.example:3306',
      ],
      allowSameOrigin: true,
    })
    expect(await closed(new WebSocket(`ws://127.0.0.1:${port}/sockets/sync`, { origin: 'https://evil.example' }))).toBe(
      1008,
    )
    await attached!.sync.issueTicket({ userUuid: 'user-1', sessionUuid: 'session-1', deviceId: 'device-1' })

    const block = admission({
      origin: 'https://std-notes.internal.example:3306',
      host: 'db.internal.example:3306',
      forwardedProto: 'https',
    }) as unknown as Record<string, unknown>

    const checked: string[] = []
    for (const [key, value] of Object.entries(block)) {
      if (key === 'rejections') {
        expect(Object.keys(value as object).sort()).toEqual([
          'originNotAllowed',
          'queryStringNotPermitted',
          'unavailable',
        ])
        for (const [cause, count] of Object.entries(value as Record<string, unknown>)) {
          expect(typeof count).toBe('number')
          expect(Number.isInteger(count)).toBe(true)
          expect(count as number).toBeGreaterThanOrEqual(0)
          expect(count as number).toBeLessThanOrEqual(MAX_REPORTED_ADMISSION_EVENTS)
          checked.push(`rejections.${cause}`)
        }
        continue
      }
      assertLeaf(key, value)
      checked.push(key)
    }

    // 7 scalars + 3 causes. If a member silently stopped reporting, this falls
    // and the test fails rather than passing on absence.
    expect(checked).toHaveLength(10)

    // Corroborating only, and deliberately second: this is the denylist arm,
    // here to document the shapes rather than to be the boundary.
    const serialized = JSON.stringify(block)
    for (const planted of [
      'hunter2',
      'someuser',
      'somepassword',
      'internal.example',
      'app.example.test',
      'evil.example',
      '8443',
      '6379',
      '3306',
      'redis',
    ]) {
      expect(serialized).not.toContain(planted)
    }
  })

  it('saturates a count at the ceiling this build declares rather than emitting an unbounded figure', async () => {
    await attach({ allowedOrigins: [], allowSameOrigin: true })

    // A rule count past the ceiling is a misconfiguration, not a measurement:
    // it reads as the ceiling and never as an open number.
    await attached!.stop()
    attached = undefined
    const many = Array.from({ length: MAX_REPORTED_ORIGIN_RULES + 50 }, (_unused, index) => `https://a${index}.example`)
    await attach({ allowedOrigins: many, allowSameOrigin: true })

    expect(admission().allowedOriginCount).toBe(MAX_REPORTED_ORIGIN_RULES)
  })
})
