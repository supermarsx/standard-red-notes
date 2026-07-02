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
})
