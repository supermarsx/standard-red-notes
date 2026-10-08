import 'reflect-metadata'

import { Response } from 'express'
import { Repository } from 'typeorm'

import { AnnotatedHealthCheckController } from './AnnotatedHealthCheckController'
import { SQLRevision } from '../TypeORM/SQL/SQLRevision'

describe('AnnotatedHealthCheckController', () => {
  let jsonMock: jest.Mock
  let statusMock: jest.Mock

  const makeResponse = (): Response => {
    jsonMock = jest.fn()
    statusMock = jest.fn(() => ({ json: jsonMock }))

    return { status: statusMock } as unknown as Response
  }

  const makeRepository = (query: jest.Mock): Repository<SQLRevision> =>
    ({ manager: { query } }) as unknown as Repository<SQLRevision>

  it('returns OK for liveness', async () => {
    expect(await new AnnotatedHealthCheckController().get()).toEqual('OK')
  })

  it('reports ready (200) when the DB answers SELECT 1', async () => {
    const query = jest.fn().mockResolvedValue([])

    await new AnnotatedHealthCheckController(makeRepository(query)).readiness(makeResponse())

    expect(query).toHaveBeenCalledWith('SELECT 1')
    expect(statusMock).toHaveBeenCalledWith(200)
    expect(jsonMock).toHaveBeenCalledWith({ status: 'ready', checks: { db: true } })
  })

  it('reports unavailable (503) when the DB check fails', async () => {
    const query = jest.fn().mockRejectedValue(new Error('down'))

    await new AnnotatedHealthCheckController(makeRepository(query)).readiness(makeResponse())

    expect(statusMock).toHaveBeenCalledWith(503)
    expect(jsonMock).toHaveBeenCalledWith({ status: 'unavailable', checks: { db: false } })
  })

  it('treats an absent repository as healthy (unit-test construction)', async () => {
    await new AnnotatedHealthCheckController().readiness(makeResponse())

    expect(statusMock).toHaveBeenCalledWith(200)
  })

  // The DB probe is raced against a 2 s deadline and nothing drove the
  // deadline itself: the `setTimeout` callback that rejects was an uncovered
  // function, so the failure mode the timeout is FOR — a database that accepts
  // the connection and then never answers `SELECT 1`, which is what a
  // saturated or wedged DB looks like — had no test. A wedged DB must read 503
  // so the orchestrator stops routing here, not hang the readiness request.
  // Fake timers rather than a 2 s sleep, but the real `withTimeout`, the real
  // `Promise.race` and the real callback.
  it('reports unavailable (503) when the DB accepts the query and never answers', async () => {
    jest.useFakeTimers()
    try {
      const query = jest.fn().mockReturnValue(new Promise<unknown>(() => undefined))
      const response = makeResponse()

      const pending = new AnnotatedHealthCheckController(makeRepository(query)).readiness(response)
      await jest.advanceTimersByTimeAsync(2000)
      await pending

      expect(statusMock).toHaveBeenCalledWith(503)
      expect(jsonMock).toHaveBeenCalledWith({ status: 'unavailable', checks: { db: false } })
    } finally {
      jest.useRealTimers()
    }
  })
})
