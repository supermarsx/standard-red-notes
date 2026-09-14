import { Request, Response } from 'express'

import { HealthCheckController, isLoopbackReadinessCaller, publicReadinessBody } from './HealthCheckController'
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
