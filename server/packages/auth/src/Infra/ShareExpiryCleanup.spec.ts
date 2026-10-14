import { ShareExpiryCleanup } from './ShareExpiryCleanup'
import type { ShareRepositoryInterface } from '../Domain/Share/ShareRepositoryInterface'

afterEach(() => jest.useRealTimers())

it('runs on startup and periodically without overlapping scans, and stops cleanly', async () => {
  jest.useFakeTimers().setSystemTime(new Date('2026-10-14T00:00:00Z'))
  let complete: () => void = () => undefined
  const cleanup = jest
    .fn()
    .mockImplementationOnce(() => new Promise<void>((resolve) => (complete = resolve)))
    .mockResolvedValue(undefined)
  const runner = new ShareExpiryCleanup(
    { revokeExpiredAndErasePayloads: cleanup } as unknown as ShareRepositoryInterface,
    jest.fn(),
  )
  runner.start()
  expect(cleanup).toHaveBeenCalledTimes(1)
  await jest.advanceTimersByTimeAsync(120_000)
  expect(cleanup).toHaveBeenCalledTimes(1)
  complete()
  await Promise.resolve()
  await jest.advanceTimersByTimeAsync(60_000)
  expect(cleanup).toHaveBeenCalledTimes(2)
  runner.stop()
  await jest.advanceTimersByTimeAsync(120_000)
  expect(cleanup).toHaveBeenCalledTimes(2)
})

it('reports cleanup failure and retries on the next scan', async () => {
  jest.useFakeTimers()
  const cleanup = jest.fn().mockRejectedValueOnce(new Error('storage unavailable')).mockResolvedValue(undefined)
  const onError = jest.fn()
  const runner = new ShareExpiryCleanup(
    { revokeExpiredAndErasePayloads: cleanup } as unknown as ShareRepositoryInterface,
    onError,
  )
  runner.start()
  await jest.advanceTimersByTimeAsync(0)
  expect(onError).toHaveBeenCalledTimes(1)
  await jest.advanceTimersByTimeAsync(60_000)
  expect(cleanup).toHaveBeenCalledTimes(2)
  runner.stop()
})
