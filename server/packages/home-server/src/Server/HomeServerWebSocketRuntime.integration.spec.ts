import express, { json } from 'express'
import * as http from 'http'
import * as net from 'net'

import { SyncWebSocketController, SyncWebSocketRuntime, syncWebSocketAccessService } from '@standardnotes/api-gateway'
import type { SyncCommandBackendAdapter, SyncLiveAuthorizationAdapter } from '@standard-red-notes/websocket-gateway'

import { HomeServerRuntime } from './HomeServerRuntime'

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

function upgrade(port: number): Promise<{ socket: net.Socket; response: string }> {
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
          'GET /sockets/sync HTTP/1.1',
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

describe('HomeServer WebSocket sync lifecycle integration', () => {
  it('registers HTTP capability/ticket routes, upgrades on the same listener, and clears provider before HTTP close', async () => {
    const controller = new SyncWebSocketController()
    const app = express()
    app.use(json())
    app.get('/v1/sockets/sync/capabilities', (request, response) => controller.capabilities(request, response))
    app.post('/v1/sockets/sync/ticket', (request, response, next) => {
      response.locals.user = { uuid: 'user-1' }
      response.locals.session = { uuid: 'session-1' }
      void controller.ticket(request, response).catch(next)
    })
    const server = http.createServer(app)
    const authorization: SyncLiveAuthorizationAdapter = {
      ready: () => true,
      authorize: async () => ({ authorized: true }),
    }
    const backend: SyncCommandBackendAdapter = {
      ready: () => true,
      execute: async (input) => ({ digest: input.digest, payload: { ok: true } }),
      status: async (input) => ({ status: 'UNKNOWN', digest: input.digest }),
    }
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
})
