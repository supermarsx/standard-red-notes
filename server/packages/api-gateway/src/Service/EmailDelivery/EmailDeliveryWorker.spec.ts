import { EmailDeliveryService, ProcessEmailResult } from './EmailDeliveryService'
import { EmailDeliveryWorker } from './EmailDeliveryWorker'

describe('EmailDeliveryWorker', () => {
  it('does not overlap batches and stop drains the active delivery before resolving', async () => {
    jest.useFakeTimers()
    try {
      let finish!: (result: ProcessEmailResult) => void
      const processOne = jest
        .fn<Promise<ProcessEmailResult>, []>()
        .mockReturnValueOnce(new Promise<ProcessEmailResult>((resolve) => (finish = resolve)))
        .mockResolvedValue({ status: 'idle' })
      const beginDrain = jest.fn()
      const endDrain = jest.fn()
      const service = { processOne, beginDrain, endDrain } as unknown as EmailDeliveryService
      const worker = new EmailDeliveryWorker(service, undefined, { intervalMs: 250, batchSize: 2 })

      expect(worker.start()).toBe(true)
      expect(endDrain).toHaveBeenCalledTimes(1)
      await jest.advanceTimersByTimeAsync(500)
      expect(processOne).toHaveBeenCalledTimes(1)

      let stopped = false
      const stopping = worker.stop().then(() => (stopped = true))
      await Promise.resolve()
      expect(beginDrain).toHaveBeenCalledTimes(1)
      expect(stopped).toBe(false)
      expect(worker.start()).toBe(false)

      finish({ status: 'sent', jobId: 'job-1' })
      await stopping
      expect(stopped).toBe(true)
      await jest.advanceTimersByTimeAsync(500)
      expect(processOne).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })

  it('clears drain state before a stopped worker is restarted', async () => {
    const processOne = jest.fn<Promise<ProcessEmailResult>, []>().mockResolvedValue({ status: 'idle' })
    const service = {
      processOne,
      beginDrain: jest.fn(),
      endDrain: jest.fn(),
    } as unknown as EmailDeliveryService
    const worker = new EmailDeliveryWorker(service)

    expect(worker.start()).toBe(true)
    await worker.stop()
    expect(worker.start()).toBe(true)
    await worker.tick()

    expect(service.beginDrain).toHaveBeenCalledTimes(1)
    expect(service.endDrain).toHaveBeenCalledTimes(2)
    expect(processOne).toHaveBeenCalledTimes(1)
    await worker.stop()
  })

  it('reports only redacted aggregate outcomes for quarantine batches', async () => {
    const processOne = jest
      .fn<Promise<ProcessEmailResult>, []>()
      .mockResolvedValueOnce({ status: 'quarantined', jobId: 'private-job-id' })
      .mockResolvedValueOnce({ status: 'idle' })
    const logger = { info: jest.fn(), error: jest.fn() }
    const worker = new EmailDeliveryWorker(
      { processOne, beginDrain: jest.fn(), endDrain: jest.fn() } as unknown as EmailDeliveryService,
      logger,
      { batchSize: 2 },
    )

    await worker.tick()

    expect(logger.info).toHaveBeenCalledWith('Email delivery worker batch completed.', {
      processed: 1,
      outcomes: { quarantined: 1, idle: 1 },
    })
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('private-job-id')
    expect(logger.error).not.toHaveBeenCalled()
  })
})
