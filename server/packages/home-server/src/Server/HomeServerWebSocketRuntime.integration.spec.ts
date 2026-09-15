import { EventEmitter } from 'events'
import express, { json } from 'express'
import * as http from 'http'
import * as net from 'net'

import {
  SyncWebSocketController,
  SyncWebSocketRuntime,
  SYNC_HOST_REMEDIES,
  syncGateDiagnostics,
  syncWebSocketAccessService,
} from '@standardnotes/api-gateway'
import type { SyncCommandBackendAdapter, SyncLiveAuthorizationAdapter } from '@standard-red-notes/websocket-gateway'

import { HomeServerRuntime } from './HomeServerRuntime'
import { WebSocketRedisBridge } from './WebSocketRedisBridge'
import {
  boundedBootFailureText,
  describeHomeServerRealtimePreconditions,
  formatGatewayLogArguments,
  IN_PROCESS_PUSH_BRIDGE_REASON,
  parseHomeServerRedisNamespace,
  REDIS_NAMESPACE_INVALID_CODE,
  REDIS_NAMESPACE_INVALID_REMEDY,
  REDIS_READY_TIMEOUT_MS,
  resolveHomeServerRealtimeGate,
  waitForRedisReady,
} from './HomeServer'

jest.mock('@standardnotes/auth-server', () => ({
  Service: jest.fn(),
}))

jest.mock('ioredis', () => {
  const { EventEmitter } = jest.requireActual<typeof import('events')>('events')

  class RedisDouble extends EventEmitter {
    status = 'ready'

    subscribe(_channel: string, callback?: (error: Error | undefined, count: number) => void): Promise<number> {
      callback?.(undefined, 1)
      return Promise.resolve(1)
    }

    eval(): Promise<number> {
      return Promise.resolve(1)
    }

    publish(): Promise<number> {
      return Promise.resolve(1)
    }

    quit(): Promise<string> {
      this.status = 'end'
      return Promise.resolve('OK')
    }

    disconnect(): void {
      this.status = 'end'
    }
  }

  return { __esModule: true, default: RedisDouble, Redis: RedisDouble }
})

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve((server.address() as net.AddressInfo).port)
    })
  })
}

function requestJson(
  port: number,
  path: string,
  options: { method?: string; headers?: http.OutgoingHttpHeaders; body?: Record<string, unknown> } = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const body = options.body ? JSON.stringify(options.body) : undefined
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        agent: false,
        headers: {
          connection: 'close',
          ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
          ...options.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.once('error', reject)
        response.once('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          resolve({
            status: response.statusCode ?? 0,
            body: raw ? (JSON.parse(raw) as unknown) : undefined,
          })
        })
      },
    )
    request.once('error', reject)
    request.end(body)
  })
}

function upgrade(port: number, path = '/sockets/sync'): Promise<{ socket: net.Socket; response: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error('WebSocket upgrade timed out.'))
    }, 3_000)
    timeout.unref()
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          'Origin: https://notes.example',
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          '',
          '',
        ].join('\r\n'),
      )
    })
    socket.once('data', (data) => {
      clearTimeout(timeout)
      resolve({ socket, response: data.toString('utf8') })
    })
  })
}

const authorization: SyncLiveAuthorizationAdapter = {
  ready: () => true,
  authorize: async () => ({ authorized: true }),
}
const backend: SyncCommandBackendAdapter = {
  ready: () => true,
  execute: async (input) => ({ digest: input.digest, payload: { ok: true } }),
  status: async (input) => ({ status: 'UNKNOWN', digest: input.digest }),
}

function buildApp(): { app: express.Express; controller: SyncWebSocketController } {
  const controller = new SyncWebSocketController()
  const app = express()
  app.use(json())
  app.get('/v1/sockets/sync/capabilities', (request, response) => controller.capabilities(request, response))
  app.post('/v1/sockets/sync/ticket', (request, response, next) => {
    response.locals.user = { uuid: 'user-1' }
    response.locals.session = { uuid: 'session-1' }
    void controller.ticket(request, response).catch(next)
  })
  return { app, controller }
}

describe('HomeServer WebSocket sync lifecycle integration', () => {
  afterEach(() => {
    syncGateDiagnostics.clear()
  })

  it('registers HTTP capability/ticket routes, upgrades on the same listener, and clears provider before HTTP close', async () => {
    const { app } = buildApp()
    const server = http.createServer(app)
    const webSocketRuntime = new SyncWebSocketRuntime()
    webSocketRuntime.attach({
      httpServer: server,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      config: {
        connectionTokenSecret: 'integration-connection-secret',
        connectionTokenTtl: '60s',
        internalSecret: 'integration-internal-secret',
        authJwtSecret: 'integration-auth-secret',
        redisHost: '127.0.0.1',
        redisPort: 1,
      },
      sync: {
        isEnabled: () => true,
        allowedOrigins: ['https://notes.example'],
        authorization,
        backend,
        authDeadlineMs: 2_000,
      },
    })
    const port = await listen(server)
    const bridge = { close: jest.fn().mockResolvedValue(undefined) }
    const readiness = { markReady: jest.fn(), markUnavailable: jest.fn() }
    const homeRuntime = new HomeServerRuntime(process)
    await homeRuntime.start({
      server,
      bridge,
      realtime: webSocketRuntime,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      readinessState: readiness,
      startScheduler: () => ({ stop: () => undefined }),
      onSigterm: async () => undefined,
    })

    try {
      const capabilityResponse = await requestJson(port, '/v1/sockets/sync/capabilities')
      expect(capabilityResponse.status).toBe(200)
      expect(capabilityResponse.body).toEqual({
        capabilities: [{ id: 'ws-sync', version: 1, endpoint: '/sockets/sync' }],
      })

      const ticketResponse = await requestJson(port, '/v1/sockets/sync/ticket', {
        method: 'POST',
        headers: { authorization: 'Bearer session-token' },
        body: { deviceId: 'device-1' },
      })
      expect(ticketResponse.status).toBe(200)
      expect(ticketResponse.body).toMatchObject({
        endpoint: '/sockets/sync',
        capability: 'ws-sync',
        version: 1,
      })

      const upgraded = await upgrade(port)
      expect(upgraded.response).toContain('101 Switching Protocols')
      expect(upgraded.response).not.toContain('ticket=')
      upgraded.socket.destroy()
    } finally {
      await homeRuntime.stop()
    }

    expect(syncWebSocketAccessService.capabilities()).toEqual({ capabilities: [] })
    expect(server.listening).toBe(false)
    expect(bridge.close).toHaveBeenCalledTimes(1)
    expect(readiness.markUnavailable).toHaveBeenCalled()
  }, 15_000)

  it('attaches only the legacy lane on a 16-byte secret: no sync lane, gateway still up, gate recorded as attached', async () => {
    // The composition HomeServer.start performs, driven by the same gate.
    const shortSecret = 'sixteen-byte-key'
    const gate = resolveHomeServerRealtimeGate({
      connectionTokenSecret: shortSecret,
      redisHost: '127.0.0.1',
      webSocketSyncEnabled: true,
      redisNamespaceValid: true,
    })
    expect(gate.attachGateway).toBe(true)
    expect(gate.buildSyncLane).toBe(false)

    const { app } = buildApp()
    const server = http.createServer(app)
    const webSocketRuntime = new SyncWebSocketRuntime()
    let recordedGate = { ...gate.observation, filesAdvertised: false, gatewayAttached: false }
    syncGateDiagnostics.record(recordedGate)
    // No RedisInviteEventStore is constructed for the short secret, so the
    // boot no longer throws "Invite cursor secret must contain at least 32 bytes."
    expect(() =>
      webSocketRuntime.attach({
        httpServer: server,
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        config: {
          connectionTokenSecret: shortSecret,
          connectionTokenTtl: '60s',
          internalSecret: 'integration-internal-secret',
          authJwtSecret: 'integration-auth-secret',
          redisHost: '127.0.0.1',
          redisPort: 1,
        },
        sync: gate.buildSyncLane
          ? { isEnabled: () => true, allowedOrigins: [], allowSameOrigin: true, authorization, backend }
          : undefined,
      }),
    ).not.toThrow()
    recordedGate = { ...recordedGate, gatewayAttached: true }
    syncGateDiagnostics.record(recordedGate)
    const port = await listen(server)

    try {
      const capabilityResponse = await requestJson(port, '/v1/sockets/sync/capabilities')
      expect(capabilityResponse.status).toBe(200)
      expect(capabilityResponse.body).toEqual({ capabilities: [] })

      const ticketResponse = await requestJson(port, '/v1/sockets/sync/ticket', {
        method: 'POST',
        headers: { authorization: 'Bearer session-token' },
        body: { deviceId: 'device-1' },
      })
      expect(ticketResponse.status).toBe(503)

      // The legacy lane completes the websocket handshake (and only then
      // refuses the missing authToken), which a listener with no gateway
      // attached cannot do.
      const legacy = await upgrade(port, '/sockets')
      expect(legacy.response).toContain('101 Switching Protocols')
      legacy.socket.destroy()

      const report = syncGateDiagnostics.report()
      expect(report.recorded).toBe(true)
      expect(report.syncLaneEnabled).toBe(false)
      expect(report.unmetCodes).toEqual(['WEB_SOCKET_CONNECTION_TOKEN_SECRET_MISSING'])
    } finally {
      await webSocketRuntime.stop()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 15_000)
})

// ---------------------------------------------------------------------------
// Boot helpers exported by HomeServer.ts (pure; no service boot needed).
// ---------------------------------------------------------------------------

const USABLE_SECRET = 'a'.repeat(32)
const SHORT_SECRET = 'sixteen-byte-key'

describe('resolveHomeServerRealtimeGate', () => {
  it('attaches the gateway and builds the sync lane on a usable secret with Redis', () => {
    const gate = resolveHomeServerRealtimeGate({
      connectionTokenSecret: USABLE_SECRET,
      redisHost: '127.0.0.1',
      webSocketSyncEnabled: true,
      redisNamespaceValid: true,
    })

    expect(gate.connectionTokenSecretUsable).toBe(true)
    expect(gate.attachGateway).toBe(true)
    expect(gate.buildSyncLane).toBe(true)
    expect(gate.sharedState).toBe('redis')
    expect(gate.unmetSyncPreconditions).toEqual([])
    expect(gate.observation).toEqual({
      connectionTokenSecretPresent: true,
      webSocketSyncEnabled: true,
      redisBound: true,
      sharedState: 'redis',
      syncingServerGrpcBound: true,
    })
  })

  it('names an invalid WEBSOCKET_REDIS_NAMESPACE and attaches nothing, keeping the shared observation truthful', () => {
    const gate = resolveHomeServerRealtimeGate({
      connectionTokenSecret: USABLE_SECRET,
      redisHost: '127.0.0.1',
      webSocketSyncEnabled: true,
      redisNamespaceValid: false,
    })

    expect(gate.attachGateway).toBe(false)
    expect(gate.buildSyncLane).toBe(false)
    expect(gate.unmetSyncPreconditions).toEqual([
      { code: REDIS_NAMESPACE_INVALID_CODE, remedy: REDIS_NAMESPACE_INVALID_REMEDY },
    ])
    // Recorded into the diagnostics observation by HomeServer.start; the
    // remedy is the one constant copy the admin report renders.
    expect(gate.hostUnmetCondition).toBe('WEBSOCKET_REDIS_NAMESPACE_INVALID')
    expect(REDIS_NAMESPACE_INVALID_REMEDY).toBe(SYNC_HOST_REMEDIES.WEBSOCKET_REDIS_NAMESPACE_INVALID)
    expect(
      resolveHomeServerRealtimeGate({
        connectionTokenSecret: USABLE_SECRET,
        redisHost: '127.0.0.1',
        webSocketSyncEnabled: true,
        redisNamespaceValid: true,
      }).hostUnmetCondition,
    ).toBeUndefined()
    // The four shared conditions are all met and say so; only the host-local
    // condition is unmet. Nothing here lies about Redis being bound.
    expect(gate.observation).toEqual({
      connectionTokenSecretPresent: true,
      webSocketSyncEnabled: true,
      redisBound: true,
      sharedState: 'redis',
      syncingServerGrpcBound: true,
    })
    expect(describeHomeServerRealtimePreconditions(gate.unmetSyncPreconditions)).toBe(
      `${REDIS_NAMESPACE_INVALID_CODE} (${REDIS_NAMESPACE_INVALID_REMEDY})`,
    )
  })

  it('lists the namespace condition after the shared ones when several are unmet', () => {
    const gate = resolveHomeServerRealtimeGate({
      connectionTokenSecret: SHORT_SECRET,
      redisHost: '127.0.0.1',
      webSocketSyncEnabled: true,
      redisNamespaceValid: false,
    })

    expect(gate.unmetSyncPreconditions.map(({ code }) => code)).toEqual([
      'WEB_SOCKET_CONNECTION_TOKEN_SECRET_MISSING',
      REDIS_NAMESPACE_INVALID_CODE,
    ])
    expect(describeHomeServerRealtimePreconditions([])).toBe('none')
  })
})

describe('parseHomeServerRedisNamespace', () => {
  it('treats unset, empty and blank as "no namespace" (byte-identical wire)', () => {
    for (const raw of [undefined, '', '   ']) {
      expect(parseHomeServerRedisNamespace(raw)).toEqual({ namespace: undefined, valid: true })
    }
  })

  it('accepts the gateway rule and trims like the gateway parser does', () => {
    expect(parseHomeServerRedisNamespace('prod')).toEqual({ namespace: 'prod', valid: true })
    expect(parseHomeServerRedisNamespace('  prod:eu_1-a  ')).toEqual({ namespace: 'prod:eu_1-a', valid: true })
    expect(parseHomeServerRedisNamespace('a'.repeat(64))).toEqual({ namespace: 'a'.repeat(64), valid: true })
  })

  it.each(['Prod', 'a b', 'a/b', 'a'.repeat(65), ':ns', 'ns:', 'ns::'])(
    'rejects %j without exposing the value',
    (raw) => {
      expect(parseHomeServerRedisNamespace(raw)).toEqual({ namespace: undefined, valid: false })
    },
  )

  it('treats a secret under 32 bytes as the named unmet precondition, attaching only the legacy lane', () => {
    const gate = resolveHomeServerRealtimeGate({
      connectionTokenSecret: SHORT_SECRET,
      redisHost: '127.0.0.1',
      webSocketSyncEnabled: true,
      redisNamespaceValid: true,
    })

    expect(gate.connectionTokenSecretUsable).toBe(false)
    expect(gate.attachGateway).toBe(true)
    expect(gate.buildSyncLane).toBe(false)
    expect(gate.observation.connectionTokenSecretPresent).toBe(false)
    expect(gate.unmetSyncPreconditions.map(({ code }) => code)).toEqual(['WEB_SOCKET_CONNECTION_TOKEN_SECRET_MISSING'])
    expect(gate.unmetSyncPreconditions[0].remedy).toContain('AT LEAST 32 bytes')
  })

  it('measures the secret in bytes, not characters', () => {
    const sixteenTwoByteGlyphs = 'é'.repeat(16)
    expect(Buffer.byteLength(sixteenTwoByteGlyphs, 'utf8')).toBe(32)

    const gate = resolveHomeServerRealtimeGate({
      connectionTokenSecret: sixteenTwoByteGlyphs,
      redisHost: '127.0.0.1',
      webSocketSyncEnabled: true,
      redisNamespaceValid: true,
    })

    expect(gate.connectionTokenSecretUsable).toBe(true)
    expect(gate.buildSyncLane).toBe(true)
  })

  // D1/C16. This used to attach NOTHING: the single container and the LXC
  // image shipped with no push, no live collaboration, no realtime invites and
  // no push-MFA unless the operator stood up a Redis nothing else in the image
  // uses. One process holds every socket here, so the state a fleet would have
  // to share lives in it.
  it('attaches the in-process plane without Redis and reports no unmet precondition', () => {
    const gate = resolveHomeServerRealtimeGate({
      connectionTokenSecret: USABLE_SECRET,
      redisHost: undefined,
      webSocketSyncEnabled: true,
      redisNamespaceValid: true,
    })

    expect(gate.attachGateway).toBe(true)
    expect(gate.buildSyncLane).toBe(true)
    expect(gate.sharedState).toBe('in-process')
    expect(gate.unmetSyncPreconditions).toEqual([])
    expect(gate.observation).toEqual({
      connectionTokenSecretPresent: true,
      webSocketSyncEnabled: true,
      redisBound: false,
      sharedState: 'in-process',
      syncingServerGrpcBound: true,
    })
  })

  it('still refuses the sync lane without Redis when the secret is too short', () => {
    const gate = resolveHomeServerRealtimeGate({
      connectionTokenSecret: SHORT_SECRET,
      redisHost: undefined,
      webSocketSyncEnabled: true,
      redisNamespaceValid: true,
    })

    expect(gate.attachGateway).toBe(true)
    expect(gate.buildSyncLane).toBe(false)
    expect(gate.unmetSyncPreconditions.map(({ code }) => code)).toEqual(['WEB_SOCKET_CONNECTION_TOKEN_SECRET_MISSING'])
  })

  // The namespace names SHARED Redis keys and channels. With no Redis there is
  // no sibling stack to collide with, so a malformed value cannot do the harm
  // the condition exists to prevent, and must not cost this topology realtime.
  it('ignores an invalid namespace when there is no Redis to namespace', () => {
    const gate = resolveHomeServerRealtimeGate({
      connectionTokenSecret: USABLE_SECRET,
      redisHost: undefined,
      webSocketSyncEnabled: true,
      redisNamespaceValid: false,
    })

    expect(gate.attachGateway).toBe(true)
    expect(gate.buildSyncLane).toBe(true)
    expect(gate.hostUnmetCondition).toBeUndefined()
    expect(gate.unmetSyncPreconditions).toEqual([])
  })

  it('attaches nothing without a secret', () => {
    const gate = resolveHomeServerRealtimeGate({
      connectionTokenSecret: undefined,
      redisHost: '127.0.0.1',
      webSocketSyncEnabled: true,
      redisNamespaceValid: true,
    })

    expect(gate.attachGateway).toBe(false)
    expect(gate.buildSyncLane).toBe(false)
    expect(gate.unmetSyncPreconditions.map(({ code }) => code)).toEqual(['WEB_SOCKET_CONNECTION_TOKEN_SECRET_MISSING'])
  })

  it('keeps the legacy lane on the kill switch and names it', () => {
    const gate = resolveHomeServerRealtimeGate({
      connectionTokenSecret: USABLE_SECRET,
      redisHost: '127.0.0.1',
      webSocketSyncEnabled: false,
      redisNamespaceValid: true,
    })

    expect(gate.attachGateway).toBe(true)
    expect(gate.buildSyncLane).toBe(false)
    expect(gate.unmetSyncPreconditions.map(({ code }) => code)).toEqual(['WEBSOCKET_SYNC_DISABLED_BY_CONFIGURATION'])
  })
})

describe('waitForRedisReady', () => {
  class RedisDouble extends EventEmitter {
    status = 'connecting'
  }

  afterEach(() => {
    jest.useRealTimers()
  })

  it('resolves at once for a client that is already ready', async () => {
    const client = new RedisDouble()
    client.status = 'ready'

    await expect(waitForRedisReady(client, 10)).resolves.toBe(true)
    expect(client.listenerCount('ready')).toBe(0)
  })

  it('resolves true when the client becomes ready inside the bound', async () => {
    const client = new RedisDouble()

    const pending = waitForRedisReady(client, 1_000)
    client.emit('ready')

    await expect(pending).resolves.toBe(true)
    expect(client.listenerCount('ready')).toBe(0)
    expect(client.listenerCount('end')).toBe(0)
  })

  it('resolves false when the client gives up', async () => {
    const client = new RedisDouble()

    const pending = waitForRedisReady(client, 1_000)
    client.emit('end')

    await expect(pending).resolves.toBe(false)
  })

  it('resolves false (never rejects) when the bound elapses, and detaches its listeners', async () => {
    jest.useFakeTimers()
    const client = new RedisDouble()

    const pending = waitForRedisReady(client, REDIS_READY_TIMEOUT_MS)
    jest.advanceTimersByTime(REDIS_READY_TIMEOUT_MS - 1)
    expect(client.listenerCount('ready')).toBe(1)
    jest.advanceTimersByTime(1)

    await expect(pending).resolves.toBe(false)
    expect(client.listenerCount('ready')).toBe(0)
    expect(client.listenerCount('end')).toBe(0)
  })
})

describe('formatGatewayLogArguments', () => {
  it('joins strings and primitives into the message', () => {
    expect(formatGatewayLogArguments(['[push:redis] dispatched', 3, true, null, undefined])).toEqual({
      message: '[push:redis] dispatched 3 true null undefined',
      metadata: undefined,
    })
  })

  it('turns plain metadata objects into winston fields instead of [object Object]', () => {
    const formatted = formatGatewayLogArguments(['[push:sqs] dispatched websocket message', { socketCount: 2 }])

    expect(formatted).toEqual({
      message: '[push:sqs] dispatched websocket message',
      metadata: { socketCount: 2 },
    })
    expect(formatted.message).not.toContain('[object Object]')
  })

  it('merges several metadata objects and keeps null-prototype objects', () => {
    const bare = Object.create(null) as Record<string, unknown>
    bare.code = 'ECONNRESET'

    expect(formatGatewayLogArguments(['x', { a: 1 }, bare, { b: 2 }])).toEqual({
      message: 'x',
      metadata: { a: 1, code: 'ECONNRESET', b: 2 },
    })
  })

  it('reduces an Error to its redacted classification, never its message', () => {
    const error = Object.assign(new Error('secret-bearing message'), { code: 'ECONNREFUSED' })

    const formatted = formatGatewayLogArguments(['[redis] failed', error])

    expect(formatted.metadata).toEqual({ errorType: 'Error', errorCode: 'ECONNREFUSED', status: undefined })
    expect(JSON.stringify(formatted)).not.toContain('secret-bearing')
  })

  it('serialises arrays and class instances into the message', () => {
    class Handle {
      constructor(readonly id: string) {}
    }

    expect(formatGatewayLogArguments(['seen', [1, 'two'], new Handle('h-1')])).toEqual({
      message: 'seen [1,"two"] {"id":"h-1"}',
      metadata: undefined,
    })
  })

  it('falls back to util.inspect for a value JSON cannot serialise', () => {
    const circular: { self?: unknown } = Object.create({ inherited: true })
    circular.self = circular

    const formatted = formatGatewayLogArguments(['cycle', circular])

    expect(formatted.metadata).toBeUndefined()
    expect(formatted.message.startsWith('cycle ')).toBe(true)
    expect(formatted.message).toContain('Circular')
  })
})

describe('boot failure reporting', () => {
  it('passes a constant-string boot error through, bounded', () => {
    expect(boundedBootFailureText('Invite cursor secret must contain at least 32 bytes.')).toBe(
      'Invite cursor secret must contain at least 32 bytes.',
    )
    expect(boundedBootFailureText('  WEBSOCKET_REDIS_NAMESPACE must match pattern, see docs  ')).toBe(
      'WEBSOCKET_REDIS_NAMESPACE must match pattern, see docs',
    )
    // The shared C8 parsers' messages (what a bad TTL / connection cap fails the boot with).
    expect(
      boundedBootFailureText(
        'WEB_SOCKET_CONNECTION_TOKEN_TTL must be a positive integer number of seconds, or <n>s, <n>m or <n>h.',
      ),
    ).toBe('WEB_SOCKET_CONNECTION_TOKEN_TTL must be a positive integer number of seconds, or <n>s, <n>m or <n>h.')
    expect(boundedBootFailureText('WEBSOCKET_MAX_CONNECTIONS_PER_USER must be an integer between 1 and 1024.')).toBe(
      'WEBSOCKET_MAX_CONNECTIONS_PER_USER must be an integer between 1 and 1024.',
    )
  })

  it.each([
    'ENOENT: no such file or directory, open /var/lib/server/data/database/home_server.sqlite',
    'connect ECONNREFUSED redis://user:pw@10.0.0.5:6379',
    'AUTH_JWT_SECRET=abc is invalid',
    'x'.repeat(201),
    '',
  ])('withholds a message that could carry a path, URL or value: %j', (message) => {
    expect(boundedBootFailureText(message)).toBe(
      '(details withheld: the message may carry a path, URL or configured value; see the redacted log line above)',
    )
  })
})

/**
 * D1: the boot log must not contradict itself. `pushBridge: in-process` and
 * "realtime push bridge disabled" two lines apart is the same defect class this
 * whole task is about, in the surface a self-hoster reads first. These drive the
 * REAL bridge rather than a double, because the thing under test IS its output.
 */
describe('WebSocketRedisBridge boot line on the in-process plane', () => {
  function bridgeLogger() {
    return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
  }

  function linesFrom(logger: ReturnType<typeof bridgeLogger>): string {
    return [...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls]
      .map((call) => String(call[0]))
      .join(' | ')
  }

  it('says what carries push instead, never that push is disabled', () => {
    const logger = bridgeLogger()
    const bridge = new WebSocketRedisBridge(
      logger as unknown as ConstructorParameters<typeof WebSocketRedisBridge>[0],
      undefined,
      6379,
      { disabledReason: IN_PROCESS_PUSH_BRIDGE_REASON },
    )

    bridge.connect()
    const lines = linesFrom(logger)

    // The line that used to contradict `pushBridge: in-process` is gone...
    expect(lines).not.toContain('REDIS_HOST not set; realtime push bridge disabled')
    // ...replaced by one that names the transport that IS carrying push, and
    // says when an operator would actually want to set REDIS_HOST.
    expect(lines).toContain('realtime push is delivered in-process')
    expect(lines).toContain('only to run several gateway replicas')
    // Said once, however many events arrive.
    bridge.connect()
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('still reports a genuinely absent push bridge when no reason is supplied', () => {
    const logger = bridgeLogger()

    new WebSocketRedisBridge(
      logger as unknown as ConstructorParameters<typeof WebSocketRedisBridge>[0],
      undefined,
      6379,
      {},
    ).connect()

    // The original line is the right one for a caller that has no other
    // transport: it means what it says there.
    expect(linesFrom(logger)).toContain('REDIS_HOST not set; realtime push bridge disabled')
  })
})
