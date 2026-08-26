import { FileItem } from '@standardnotes/snjs'
import { BulkFileProgress, describeBulkFileError, runBulkFileOperation } from './bulkFileOperation'

const file = (uuid: string, name = `${uuid}.txt`) => ({ uuid, name }) as FileItem

describe('runBulkFileOperation', () => {
  it('attempts every file even when one fails, and attributes the failure to that file', async () => {
    const files = [file('a'), file('b'), file('c')]
    const attempted: string[] = []

    const result = await runBulkFileOperation(
      files,
      async (target) => {
        attempted.push(target.uuid)
        if (target.uuid === 'b') {
          throw new Error('Network unreachable')
        }
      },
      { concurrency: 1 },
    )

    expect(attempted).toEqual(['a', 'b', 'c'])
    expect(result.succeeded.map((item) => item.uuid)).toEqual(['a', 'c'])
    expect(result.failed).toEqual([{ uuid: 'b', name: 'b.txt', message: 'Network unreachable' }])
  })

  it('reports in the original order regardless of completion order', async () => {
    const files = [file('a'), file('b'), file('c'), file('d')]
    const delays: Record<string, number> = { a: 40, b: 0, c: 30, d: 0 }

    const result = await runBulkFileOperation(
      files,
      async (target) => {
        await new Promise((resolve) => setTimeout(resolve, delays[target.uuid]))
        if (target.uuid === 'a' || target.uuid === 'c') {
          throw new Error(`failed ${target.uuid}`)
        }
      },
      { concurrency: 4 },
    )

    expect(result.succeeded.map((item) => item.uuid)).toEqual(['b', 'd'])
    expect(result.failed.map((item) => item.uuid)).toEqual(['a', 'c'])
  })

  it('never rejects when every file fails', async () => {
    const result = await runBulkFileOperation([file('a'), file('b')], async () => {
      throw new Error('nope')
    })

    expect(result.succeeded).toEqual([])
    expect(result.failed).toHaveLength(2)
  })

  it('emits monotonic progress so a long batch can be shown moving', async () => {
    const progress: BulkFileProgress[] = []

    await runBulkFileOperation([file('a'), file('b'), file('c')], async () => undefined, {
      concurrency: 1,
      onProgress: (update) => progress.push(update),
    })

    expect(progress).toEqual([
      { completed: 0, total: 3 },
      { completed: 1, total: 3 },
      { completed: 2, total: 3 },
      { completed: 3, total: 3 },
    ])
  })

  it('bounds how many operations run at once', async () => {
    let inFlight = 0
    let peak = 0

    await runBulkFileOperation(
      Array.from({ length: 10 }, (_, index) => file(`f${index}`)),
      async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 1))
        inFlight -= 1
      },
      { concurrency: 3 },
    )

    expect(peak).toBe(3)
  })

  it('handles an empty selection without running anything', async () => {
    const operation = jest.fn()
    const result = await runBulkFileOperation([], operation)

    expect(operation).not.toHaveBeenCalled()
    expect(result).toEqual({ succeeded: [], failed: [] })
  })
})

describe('describeBulkFileError', () => {
  it('reads the message off a ClientDisplayableError, which is not an Error subclass', () => {
    expect(describeBulkFileError({ text: 'File server rejected the request' })).toBe(
      'File server rejected the request',
    )
  })

  it('falls back to a stable label for unrecognisable throws', () => {
    expect(describeBulkFileError(undefined)).toBe('Unknown error')
    expect(describeBulkFileError({})).toBe('Unknown error')
  })

  it('prefers a real Error message', () => {
    expect(describeBulkFileError(new Error('Boom'))).toBe('Boom')
  })
})
