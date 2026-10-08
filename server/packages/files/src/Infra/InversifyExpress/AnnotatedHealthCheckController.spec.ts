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

  // The readiness probe is raced against a 2 s deadline, and before this test
  // existed nothing drove the deadline itself: the `setTimeout` callback that
  // rejects was the one uncovered function in this file, so a storage backend
  // that accepts the connection and then never answers — the failure mode the
  // timeout is FOR — had no test at all. Fake timers rather than a 2 s sleep,
  // but the real `withTimeout`, the real `Promise.race` and the real callback.
  it('fails readiness closed when the storage probe never answers', async () => {
    jest.useFakeTimers()
    try {
      const response = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as unknown as Response
      const controller = new AnnotatedHealthCheckController(undefined, {
        check: jest.fn().mockReturnValue(new Promise<void>(() => undefined)),
      })

      const pending = controller.readiness(response)
      await jest.advanceTimersByTimeAsync(2000)
      await pending

      expect(response.status).toHaveBeenCalledWith(503)
      expect(response.json).toHaveBeenCalledWith({
        status: 'unavailable',
        checks: { redis: true, storage: false },
      })
    } finally {
      jest.useRealTimers()
    }
  })
})
