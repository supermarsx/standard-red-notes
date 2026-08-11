import { Response } from 'express'

import { HealthCheckController } from './HealthCheckController'
import { AggregateReadinessService } from '../Service/Readiness/AggregateReadinessService'

describe('HealthCheckController', () => {
  it('keeps liveness dependency-free', async () => {
    const aggregate = { check: jest.fn() } as unknown as AggregateReadinessService

    await expect(new HealthCheckController(aggregate).get()).resolves.toBe('OK')
    expect(aggregate.check).not.toHaveBeenCalled()
  })

  it('returns 503 with the aggregate report when any required component is unavailable', async () => {
    const report = {
      status: 'unavailable' as const,
      deployment: { revision: null, version: null },
      checks: { gateway: { redis: true, runtime: true }, services: { auth: false } },
    }
    const aggregate = { check: jest.fn().mockResolvedValue(report) } as unknown as AggregateReadinessService
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    } as unknown as Response

    await new HealthCheckController(aggregate).readiness(response)

    expect(response.status).toHaveBeenCalledWith(503)
    expect(response.json).toHaveBeenCalledWith(report)
  })
})
