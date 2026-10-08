import { Request, Response } from 'express'

import {
  HealthCheckController,
  isLoopbackReadinessCaller,
  publicReadinessBody,
  resolveReadinessAnswer,
} from './HealthCheckController'
import { AggregateReadinessService } from '../Service/Readiness/AggregateReadinessService'

const report = {
  status: 'unavailable' as const,
  deployment: { revision: null, version: null },
  checks: { gateway: { redis: true, runtime: true }, services: { auth: false } },
}

const requestFrom = (remoteAddress: string | undefined, headers: Record<string, string> = {}): Request =>
  ({ socket: { remoteAddress }, headers }) as unknown as Request

const responseDouble = (): { response: Response; status: jest.Mock; json: jest.Mock } => {
  const json = jest.fn()
  const status = jest.fn().mockReturnValue({ json })
  return { response: { status, json } as unknown as Response, status, json }
}

describe('HealthCheckController', () => {
  it('keeps liveness dependency-free', async () => {
    const aggregate = { check: jest.fn() } as unknown as AggregateReadinessService

    await expect(new HealthCheckController(aggregate).get()).resolves.toBe('OK')
    expect(aggregate.check).not.toHaveBeenCalled()
  })

  it('returns 503 with the full aggregate report to an in-container (loopback) caller', async () => {
    const aggregate = { check: jest.fn().mockResolvedValue(report) } as unknown as AggregateReadinessService
    const { response, status, json } = responseDouble()

    await new HealthCheckController(aggregate).readiness(requestFrom('127.0.0.1'), response)

    expect(status).toHaveBeenCalledWith(503)
    expect(json).toHaveBeenCalledWith(report)
  })

  // N44: the public front door proxies /healthcheck/readiness without auth; the
  // per-service and supervisord program map must not leave the container.
  it('strips checks for a caller that came through the reverse proxy', async () => {
    const aggregate = { check: jest.fn().mockResolvedValue(report) } as unknown as AggregateReadinessService
    const { response, status, json } = responseDouble()

    await new HealthCheckController(aggregate).readiness(
      requestFrom('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }),
      response,
    )

    expect(status).toHaveBeenCalledWith(503)
    expect(json).toHaveBeenCalledWith({ status: 'unavailable', deployment: { revision: null, version: null } })
    expect(json.mock.calls[0][0]).not.toHaveProperty('checks')
  })

  it('strips checks for a remote peer even when no forwarding header is present', async () => {
    const aggregate = { check: jest.fn().mockResolvedValue({ ...report, status: 'ready' as const }) }
    const { response, status, json } = responseDouble()

    await new HealthCheckController(aggregate as unknown as AggregateReadinessService).readiness(
      requestFrom('10.0.0.5'),
      response,
    )

    expect(status).toHaveBeenCalledWith(200)
    expect(json).toHaveBeenCalledWith({ status: 'ready', deployment: { revision: null, version: null } })
  })

  it.each([
    ['127.0.0.1', {}, true],
    ['::1', {}, true],
    ['::ffff:127.0.0.1', {}, true],
    ['127.0.0.1', { 'x-forwarded-for': '127.0.0.1' }, false],
    ['172.18.0.3', {}, false],
    [undefined, {}, false],
  ])('classifies peer %s with headers %j as loopback=%s', (peer, headers, expected) => {
    expect(isLoopbackReadinessCaller(requestFrom(peer as string | undefined, headers as Record<string, string>))).toBe(
      expected,
    )
  })

  it('keeps only status and deployment in the public body', () => {
    expect(Object.keys(publicReadinessBody(report)).sort()).toEqual(['deployment', 'status'])
  })
})

/**
 * Standard Red Notes: `resolveReadinessAnswer` is the ONE composition of this
 * route's answer, and it exists because the route has two entry points — this
 * controller on a multi-process deployment, and a direct registration on the
 * bundled home-server's public app (which has to win a precedence race against
 * four other `@controller('/healthcheck')` classes). That direct registration
 * held its own copy of the 200/503 rule and no copy at all of the withholding
 * rule, so on the single container the front door published `checks.services`
 * and `checks.gateway.realtime` while the multi-container twin withheld them.
 */
describe('resolveReadinessAnswer', () => {
  it('hands the full report to an in-container loopback caller', () => {
    expect(resolveReadinessAnswer(requestFrom('127.0.0.1'), report)).toEqual({ statusCode: 503, body: report })
  })

  it('narrows the body for a caller that came through the reverse proxy', () => {
    const answer = resolveReadinessAnswer(requestFrom('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }), report)

    expect(answer.body).toEqual({ status: 'unavailable', deployment: report.deployment })
    expect(answer.body).not.toHaveProperty('checks')
  })

  it('narrows the body for a remote peer that sent no forwarding header', () => {
    const answer = resolveReadinessAnswer(requestFrom('198.51.100.7'), report)

    expect(answer.body).toEqual({ status: 'unavailable', deployment: report.deployment })
  })

  // The container healthcheck discards the body and scores the status line, so
  // the status code must not depend on who is asking. If it did, withholding the
  // body would be able to turn a healthy container unhealthy.
  it.each([
    ['ready', 200],
    ['unavailable', 503],
  ] as const)('derives %s as %i for every caller class', (status, statusCode) => {
    const subject = { ...report, status }

    expect(resolveReadinessAnswer(requestFrom('127.0.0.1'), subject).statusCode).toBe(statusCode)
    expect(
      resolveReadinessAnswer(requestFrom('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }), subject).statusCode,
    ).toBe(statusCode)
    expect(resolveReadinessAnswer(requestFrom('198.51.100.7'), subject).statusCode).toBe(statusCode)
  })

  it('does not copy the report when the caller may see all of it', () => {
    expect(resolveReadinessAnswer(requestFrom('::1'), report).body).toBe(report)
  })

  it('serialises nothing about the internals for a public caller', () => {
    const serialised = JSON.stringify(
      resolveReadinessAnswer(requestFrom('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }), report).body,
    )

    for (const token of ['checks', 'gateway', 'services', 'realtime', 'auth', 'redis', 'runtime']) {
      expect(serialised).not.toContain(token)
    }
  })
})
