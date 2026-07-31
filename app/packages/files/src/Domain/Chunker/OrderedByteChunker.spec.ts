import { OrderedByteChunker, OrderedByteChunkerError } from './OrderedByteChunker'

const chunkOfSize = (size: number) => {
  return new TextEncoder().encode('a'.repeat(size))
}

describe('ordered byte chunker', () => {
  it('should callback multiple times if added bytes matches multiple chunk sizes', async () => {
    const chunkSizes = [10, 10, 10]
    let receivedBytes = new Uint8Array()
    let numCallbacks = 0

    const chunker = new OrderedByteChunker(chunkSizes, 'network', async (chunk) => {
      numCallbacks++
      receivedBytes = new Uint8Array([...receivedBytes, ...chunk.data])
    })

    await chunker.addBytes(chunkOfSize(30))
    chunker.finish()

    expect(numCallbacks).toEqual(3)
    expect(receivedBytes.length).toEqual(30)
  })

  it('should correctly report progress', async () => {
    const chunkSizes = [10, 10, 10]
    let receivedBytes = new Uint8Array()
    let numCallbacks = 0

    const chunker = new OrderedByteChunker(chunkSizes, 'network', async (chunk) => {
      numCallbacks++

      receivedBytes = new Uint8Array([...receivedBytes, ...chunk.data])

      expect(chunk.progress.encryptedBytesDownloaded).toEqual(receivedBytes.length)

      expect(chunk.progress.percentComplete).toEqual((numCallbacks / chunkSizes.length) * 100.0)
    })

    await chunker.addBytes(chunkOfSize(30))
    chunker.finish()

    expect(numCallbacks).toEqual(3)
    expect(receivedBytes.length).toEqual(30)
  })

  it('marks only the final declared chunk as last', async () => {
    const isLastValues: boolean[] = []
    const chunker = new OrderedByteChunker([2, 2, 2], 'network', async (chunk) => {
      isLastValues.push(chunk.isLast)
    })

    await chunker.addBytes(chunkOfSize(6))
    chunker.finish()

    expect(isLastValues).toEqual([false, false, true])
  })

  it('rejects a truncated stream when it is finished', async () => {
    const chunker = new OrderedByteChunker([4, 4], 'network', jest.fn().mockResolvedValue(undefined))

    await chunker.addBytes(chunkOfSize(6))

    expect(() => chunker.finish()).toThrow(OrderedByteChunkerError)
  })

  it('rejects bytes beyond the declared chunk metadata', async () => {
    const chunker = new OrderedByteChunker([4], 'network', jest.fn().mockResolvedValue(undefined))

    await expect(chunker.addBytes(chunkOfSize(5))).rejects.toBeInstanceOf(OrderedByteChunkerError)
  })

  it('rejects an additional run after all declared chunks have been consumed', async () => {
    const chunker = new OrderedByteChunker([4], 'network', jest.fn().mockResolvedValue(undefined))

    await chunker.addBytes(chunkOfSize(4))

    await expect(chunker.addBytes(chunkOfSize(1))).rejects.toBeInstanceOf(OrderedByteChunkerError)
  })

  it('ignores an empty read without advancing the declared stream', async () => {
    const onChunk = jest.fn().mockResolvedValue(undefined)
    const chunker = new OrderedByteChunker([4], 'network', onChunk)

    await chunker.addBytes(new Uint8Array())
    await chunker.addBytes(chunkOfSize(4))
    chunker.finish()

    expect(onChunk).toHaveBeenCalledTimes(1)
  })

  it.each([
    { chunkSizes: [] },
    { chunkSizes: [0] },
    { chunkSizes: [-1] },
    { chunkSizes: [1.5] },
    { chunkSizes: [Number.NaN] },
    { chunkSizes: [Number.MAX_SAFE_INTEGER, 1] },
  ])('rejects invalid chunk metadata $chunkSizes', ({ chunkSizes }) => {
    expect(() => new OrderedByteChunker(chunkSizes, 'network', jest.fn().mockResolvedValue(undefined))).toThrow(
      OrderedByteChunkerError,
    )
  })
})
