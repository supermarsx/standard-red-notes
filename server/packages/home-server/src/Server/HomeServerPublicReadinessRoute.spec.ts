import * as http from 'http'

jest.mock('@standardnotes/auth-server', () => ({
  Service: jest.fn(),
}))

import express, { NextFunction, Request, Response } from 'express'

import { aggregateReadinessRequestHandler } from './HomeServer'
import type { AggregateReadinessReport } from '@standardnotes/api-gateway'

/**
 * Standard Red Notes: the PUBLIC app's `/healthcheck/readiness` route, exercised
 * over a REAL loopback socket.
 *
 * This route is the one entry point that does NOT go through the gateway's
 * annotated `HealthCheckController`: the bundled home-server registers it
 * directly on the public app, ahead of the controller router, because every
 * service it bundles declares its own `@controller('/healthcheck')` and the
 * winner would otherwise depend on controller discovery order. Winning that
 * precedence race is exactly how it came to reach PAST `publicReadinessBody`
 * and serve `checks.services` and `checks.gateway.realtime` — the internal
 * service topology and which internal dependency is up — to every
 * unauthenticated caller on the front door.
 *
 * Every case below drives a real `http.request` against a real `express()`
 * app, so `socket.remoteAddress` and the forwarding header are whatever the
 * transport actually produced. A hand-built `{ socket, headers }` literal would
 * let the withholding decision be proven on a shape this route never sees, and
 * a fabricated `Response` has no working `status().json()` chain at all.
 */

const fullReport = (status: 'ready' | 'unavailable'): AggregateReadinessReport => ({
  status,
  deployment: { revision: 'a'.repeat(40), version: 'src-aaaaaaaaaaaa' },
  checks: {
    gateway: {
      redis: true,
      runtime: true,
      realtime: {
        attached: true,
        pushBridge: 'in-process',
        pushBridgeReady: true,
        sqsConsumerRunning: false,
        collaborationRelayHealthy: true,
        syncLane: 'up',
        pushesDispatched: 0,
      },
    },
    services: { auth: true, 'syncing-server': true, files: true, revisions: true },
    programs: { 'auth-worker': true },
  },
})

type Answer = { statusCode: number; body: unknown; raw: string }

const listening: http.Server[] = []

const startApp = (resolveService: () => { check(): Promise<AggregateReadinessReport> }): Promise<number> => {
  const app = express()
  app.get('/healthcheck/readiness', aggregateReadinessRequestHandler(resolveService))
  // Mirrors the home-server's own setErrorConfig: anything handed to next()
  // becomes a 500 and never an answer on this route.
  app.use((_error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    response.status(500).json({ error: { message: 'boom' } })
  })

  return new Promise<number>((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      listening.push(server)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('the readiness harness did not bind a TCP port'))

        return
      }
      resolve(address.port)
    })
    server.on('error', reject)
  })
}

const get = (port: number, headers: Record<string, string> = {}): Promise<Answer> =>
  new Promise<Answer>((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: '/healthcheck/readiness', method: 'GET', headers },
      (response) => {
        let raw = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          raw += chunk
        })
        response.on('end', () => {
          resolve({ statusCode: response.statusCode ?? 0, body: raw === '' ? undefined : JSON.parse(raw), raw })
        })
      },
    )
    request.on('error', reject)
    request.end()
  })

afterEach(async () => {
  while (listening.length > 0) {
    const server = listening.pop() as http.Server
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

describe('the public app aggregate readiness route', () => {
  it('gives an in-container loopback caller the full report', async () => {
    const report = fullReport('ready')
    const port = await startApp(() => ({ check: () => Promise.resolve(report) }))

    const answer = await get(port)

    expect(answer.statusCode).toBe(200)
    expect(answer.body).toEqual(report)
  })

  // THE DISCLOSURE. nginx sets X-Forwarded-For on every request it proxies, so
  // this is precisely what a client of the published front door looks like to
  // this route.
  it('withholds every check from a caller that came through the reverse proxy', async () => {
    const report = fullReport('ready')
    const port = await startApp(() => ({ check: () => Promise.resolve(report) }))

    const answer = await get(port, { 'x-forwarded-for': '203.0.113.9' })

    expect(answer.statusCode).toBe(200)
    expect(answer.body).toEqual({ status: 'ready', deployment: report.deployment })
    expect(answer.body).not.toHaveProperty('checks')
  })

  // Not a shape assertion: the point of the leak was that NAMES of internal
  // services and realtime fields reached the wire. Read the bytes.
  it.each(['checks', 'services', 'realtime', 'syncing-server', 'auth-worker', 'pushBridge', 'syncLane', 'redis'])(
    'never writes %s onto the public wire',
    async (token) => {
      const port = await startApp(() => ({ check: () => Promise.resolve(fullReport('ready')) }))

      const answer = await get(port, { 'x-forwarded-for': '203.0.113.9' })

      expect(answer.raw).not.toContain(token)
    },
  )

  // The container healthcheck is `curl -fsS … >/dev/null`: it reads the status
  // line and throws the body away. If narrowing the body could move the status
  // code, this change would be able to turn a healthy container unhealthy.
  it.each([
    ['ready', 200],
    ['unavailable', 503],
  ] as const)('answers %s with %i for BOTH caller classes', async (status, expected) => {
    const port = await startApp(() => ({ check: () => Promise.resolve(fullReport(status)) }))

    const loopback = await get(port)
    const proxied = await get(port, { 'x-forwarded-for': '203.0.113.9' })

    expect(loopback.statusCode).toBe(expected)
    expect(proxied.statusCode).toBe(expected)
    expect(proxied.statusCode).toBe(loopback.statusCode)
  })

  // A 503 still has to be narrowed. "Not ready" is the state in which the check
  // map is most revealing — it names the dependency that is down.
  it('withholds the checks of an unavailable deployment too', async () => {
    const report = fullReport('unavailable')
    const port = await startApp(() => ({ check: () => Promise.resolve(report) }))

    const answer = await get(port, { 'x-forwarded-for': '203.0.113.9' })

    expect(answer.statusCode).toBe(503)
    expect(answer.body).toEqual({ status: 'unavailable', deployment: report.deployment })
  })

  // The deployment identity is public by design — it is also served unauthenticated
  // at /.well-known/srn-deployment.json — and operator tooling
  // (scripts/verify-deployment-identity.mjs, setup.sh) reads it off this route
  // through the front door. Narrowing must not take it away.
  it('keeps the public deployment identity on the front door', async () => {
    const port = await startApp(() => ({ check: () => Promise.resolve(fullReport('ready')) }))

    const answer = await get(port, { 'x-forwarded-for': '198.51.100.7' })

    expect(answer.body).toEqual({
      status: 'ready',
      deployment: { revision: 'a'.repeat(40), version: 'src-aaaaaaaaaaaa' },
    })
  })

  it('resolves the readiness service per request, not once at registration', async () => {
    const resolve = jest.fn(() => ({ check: () => Promise.resolve(fullReport('ready')) }))
    const port = await startApp(resolve)

    await get(port)
    await get(port)

    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('hands a rejected readiness check to the error config instead of answering', async () => {
    const port = await startApp(() => ({ check: () => Promise.reject(new Error('readiness exploded')) }))

    const answer = await get(port, { 'x-forwarded-for': '203.0.113.9' })

    expect(answer.statusCode).toBe(500)
    expect(answer.raw).not.toContain('ready')
  })

  it('does not answer at all when the readiness binding is missing', async () => {
    const port = await startApp(() => {
      throw new Error('No matching bindings found for serviceIdentifier')
    })

    const answer = await get(port)

    expect(answer.statusCode).toBe(500)
    expect(answer.raw).not.toContain('"status"')
  })
})
