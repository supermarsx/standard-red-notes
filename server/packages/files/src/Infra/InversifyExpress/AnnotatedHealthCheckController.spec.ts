import 'reflect-metadata'

import { AnnotatedHealthCheckController } from './AnnotatedHealthCheckController'
import { Response } from 'express'

describe('AnnotatedHealthCheckController', () => {
  const createController = () => new AnnotatedHealthCheckController()

  it('should return OK', async () => {
    const response = (await createController().get()) as string
    expect(response).toEqual('OK')
  })

  it('reports ready only when Redis and storage are available', async () => {
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    } as unknown as Response
    const controller = new AnnotatedHealthCheckController(
      { ping: jest.fn().mockResolvedValue('PONG') },
      { check: jest.fn().mockResolvedValue(undefined) },
    )

    await controller.readiness(response)

    expect(response.status).toHaveBeenCalledWith(200)
    expect(response.json).toHaveBeenCalledWith({
      status: 'ready',
      checks: { redis: true, storage: true },
    })
  })

  it.each([
    ['Redis', { ping: jest.fn().mockRejectedValue(new Error('down')) }, { check: jest.fn() }],
    ['storage', undefined, { check: jest.fn().mockRejectedValue(new Error('down')) }],
    ['a missing storage binding', undefined, undefined],
  ])('fails readiness closed when %s is unavailable', async (_name, redis, storage) => {
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    } as unknown as Response
    const controller = new AnnotatedHealthCheckController(redis, storage)

    await controller.readiness(response)

    expect(response.status).toHaveBeenCalledWith(503)
  })
})
