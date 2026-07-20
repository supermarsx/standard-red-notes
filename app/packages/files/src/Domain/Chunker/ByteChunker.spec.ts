import { ByteChunker } from './ByteChunker'

const chunkOfSize = (size: number) => {
  return new TextEncoder().encode('a'.repeat(size))
}

describe('byte chunker', () => {
  it('should hold back small chunks until minimum size is met', async () => {
    let receivedBytes = new Uint8Array()
    let numChunks = 0
    const chunker = new ByteChunker(100, async (chunk) => {
      numChunks++
      receivedBytes = new Uint8Array([...receivedBytes, ...chunk.data])
    })

    await chunker.addBytes(chunkOfSize(50), false)
    await chunker.addBytes(chunkOfSize(50), false)
    await chunker.addBytes(chunkOfSize(50), false)
    await chunker.addBytes(chunkOfSize(50), true)

    expect(numChunks).toEqual(2)
    expect(receivedBytes.length).toEqual(200)
  })

  it('should send back big chunks immediately', async () => {
    let receivedBytes = new Uint8Array()
    let numChunks = 0
    const chunker = new ByteChunker(100, async (chunk) => {
      numChunks++
      receivedBytes = new Uint8Array([...receivedBytes, ...chunk.data])
    })

    await chunker.addBytes(chunkOfSize(150), false)
    await chunker.addBytes(chunkOfSize(150), false)
    await chunker.addBytes(chunkOfSize(150), false)
    await chunker.addBytes(chunkOfSize(50), true)

    expect(numChunks).toEqual(4)
    expect(receivedBytes.length).toEqual(500)
  })

  it('last chunk should be popped regardless of size', async () => {
    let receivedBytes = new Uint8Array()
    let numChunks = 0
    const chunker = new ByteChunker(100, async (chunk) => {
      numChunks++
      receivedBytes = new Uint8Array([...receivedBytes, ...chunk.data])
    })

    await chunker.addBytes(chunkOfSize(50), false)
    await chunker.addBytes(chunkOfSize(25), true)

    expect(numChunks).toEqual(1)
    expect(receivedBytes.length).toEqual(75)
  })

  it('should stay silent while logging is disabled', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const chunker = new ByteChunker(10, async () => undefined)

    await chunker.addBytes(chunkOfSize(10), true)

    expect(log).not.toHaveBeenCalled()
    log.mockRestore()
  })

  it('should log every add and pop once logging is enabled', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const chunker = new ByteChunker(10, async () => undefined)
    chunker.loggingEnabled = true

    await chunker.addBytes(chunkOfSize(4), false)
    await chunker.addBytes(chunkOfSize(10), true)

    expect(log.mock.calls).toEqual([
      [['Chunker adding 4, total size 4']],
      [['Chunker adding 10, total size 14']],
      [['Chunker popping 14, total size in queue 0']],
    ])
    log.mockRestore()
  })

  it('single chunk should be popped immediately', async () => {
    let receivedBytes = new Uint8Array()
    let numChunks = 0
    const chunker = new ByteChunker(100, async (chunk) => {
      numChunks++
      receivedBytes = new Uint8Array([...receivedBytes, ...chunk.data])
    })

    await chunker.addBytes(chunkOfSize(50), true)

    expect(numChunks).toEqual(1)
    expect(receivedBytes.length).toEqual(50)
  })
})
