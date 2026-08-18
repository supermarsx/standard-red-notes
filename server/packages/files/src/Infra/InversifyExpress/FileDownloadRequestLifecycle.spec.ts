import { EventEmitter } from 'events'
import { Request, Response } from 'express'
import { PassThrough } from 'stream'
import { Logger } from 'winston'

import {
  FILE_DOWNLOAD_TIMEOUT_CODE,
  FileDownloadRequestLifecycle,
  pipeFileDownload,
} from './FileDownloadRequestLifecycle'

describe('FileDownloadRequestLifecycle', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  const createEvents = () => {
    const request = new EventEmitter() as Request
    const response = new EventEmitter() as Response
    Object.assign(response, {
      writableEnded: false,
      destroyed: false,
      destroy: jest.fn(),
    })
    return { request, response }
  }

  const createReadStream = (pipeImplementation?: () => Writable) => {
    const readStream = new EventEmitter() as unknown as Readable
    Object.assign(readStream, {
      destroyed: false,
      destroy: jest.fn(),
      pipe: jest.fn(pipeImplementation ?? (() => new Writable())),
    })
    return readStream
  }

  it('aborts at the deadline and clears its timer and disconnect listeners', () => {
    const { request, response } = createEvents()
    const lifecycle = new FileDownloadRequestLifecycle(request, response, 25)

    expect(jest.getTimerCount()).toBe(1)
    jest.advanceTimersByTime(25)

    expect(lifecycle.signal.aborted).toBe(true)
    expect(lifecycle.reason).toBe('deadline')
    expect(jest.getTimerCount()).toBe(0)
    expect(request.listenerCount('aborted')).toBe(0)
    expect(response.listenerCount('close')).toBe(0)
    expect(response.listenerCount('finish')).toBe(0)
  })

  it('aborts on client disconnect and clears the deadline immediately', () => {
    const { request, response } = createEvents()
    const lifecycle = new FileDownloadRequestLifecycle(request, response, 25)
    const repeatAbort = request.listeners('aborted')[0] as () => void

    request.emit('aborted')
    repeatAbort()

    expect(lifecycle.signal.aborted).toBe(true)
    expect(lifecycle.reason).toBe('client-disconnect')
    expect(jest.getTimerCount()).toBe(0)
    expect(request.listenerCount('aborted')).toBe(0)
    expect(response.listenerCount('close')).toBe(0)
  })

  it('disposes without aborting when the response closes after its body ended', () => {
    const { request, response } = createEvents()
    Object.assign(response, { writableEnded: true })
    const lifecycle = new FileDownloadRequestLifecycle(request, response, 25)

    response.emit('close')

    expect(lifecycle.signal.aborted).toBe(false)
    expect(lifecycle.reason).toBeUndefined()
    expect(jest.getTimerCount()).toBe(0)
    expect(request.listenerCount('aborted')).toBe(0)
  })

  it('destroys a hung stream body at the request deadline without completing it', () => {
    const request = new EventEmitter() as Request
    const response = new PassThrough() as unknown as Response
    const readStream = new PassThrough()
    const logger = { error: jest.fn(), warn: jest.fn() } as unknown as Logger
    const lifecycle = new FileDownloadRequestLifecycle(request, response, 25)

    pipeFileDownload(readStream, response, lifecycle, logger)
    jest.advanceTimersByTime(25)

    expect(readStream.destroyed).toBe(true)
    expect(response.destroyed).toBe(true)
    expect(response.writableEnded).toBe(false)
    expect(logger.warn).toHaveBeenCalledWith(
      'File download terminated after its server deadline.',
      expect.objectContaining({ code: FILE_DOWNLOAD_TIMEOUT_CODE, stage: 'stream-body' }),
    )
    expect(jest.getTimerCount()).toBe(0)
  })

  it('clears its timer and listeners after a complete stream', async () => {
    const request = new EventEmitter() as Request
    const response = new PassThrough() as unknown as Response
    const readStream = new PassThrough()
    const logger = { error: jest.fn(), warn: jest.fn() } as unknown as Logger
    const lifecycle = new FileDownloadRequestLifecycle(request, response, 25)
    const finished = new Promise<void>((resolve) => response.once('finish', resolve))

    pipeFileDownload(readStream, response, lifecycle, logger)
    readStream.end(Buffer.from('complete'))
    await finished

    expect(response.writableEnded).toBe(true)
    expect(lifecycle.signal.aborted).toBe(false)
    expect(jest.getTimerCount()).toBe(0)
    expect(request.listenerCount('aborted')).toBe(0)
    expect(response.listenerCount('close')).toBe(0)
  })

  it('makes pipe close and finish callbacks idempotent', () => {
    const { request, response } = createEvents()
    const readStream = createReadStream(() => response as unknown as Writable)
    const logger = { error: jest.fn(), warn: jest.fn() } as unknown as Logger
    const lifecycle = new FileDownloadRequestLifecycle(request, response, 25)

    pipeFileDownload(readStream, response, lifecycle, logger)
    const close = response.listeners('close').at(-1) as () => void
    const finish = response.listeners('finish').at(-1) as () => void

    close()
    close()
    finish()

    expect(readStream.destroy).toHaveBeenCalledTimes(1)
    expect(response.destroy).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('terminates immediately when piping starts after the request was aborted', () => {
    const { request, response } = createEvents()
    const readStream = createReadStream(() => response as unknown as Writable)
    const logger = { error: jest.fn(), warn: jest.fn() } as unknown as Logger
    const lifecycle = new FileDownloadRequestLifecycle(request, response, 25)
    request.emit('aborted')

    const result = pipeFileDownload(readStream, response, lifecycle, logger)

    expect(result).toBe(response)
    expect(readStream.destroy).toHaveBeenCalledTimes(1)
    expect(response.destroy).toHaveBeenCalledTimes(1)
  })

  it.each([[new Error('pipe failed')], ['pipe failed']])(
    'normalizes a synchronous pipe failure and terminates both sides',
    (failure) => {
      const { request, response } = createEvents()
      const readStream = createReadStream(() => {
        throw failure
      })
      const logger = { error: jest.fn(), warn: jest.fn() } as unknown as Logger
      const lifecycle = new FileDownloadRequestLifecycle(request, response, 25)

      const result = pipeFileDownload(readStream, response, lifecycle, logger)

      expect(result).toBe(response)
      expect(logger.error).toHaveBeenCalledWith(
        'Error while streaming file download.',
        expect.objectContaining({ errorType: 'Error' }),
      )
      expect(readStream.destroy).toHaveBeenCalledTimes(1)
      expect(response.destroy).toHaveBeenCalledWith(expect.any(Error))
    },
  )
})
