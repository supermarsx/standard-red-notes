import { StreamingFileReader } from './StreamingReader'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyWindow = () => globalThis.window as any

const chunk = (...bytes: number[]) => new Uint8Array(bytes)

const fileYielding = (name: string, type: string, chunks: Uint8Array[]) => {
  let index = 0
  const reader = {
    read: jest.fn().mockImplementation(() => {
      if (index >= chunks.length) {
        return Promise.resolve({ done: true, value: undefined })
      }
      return Promise.resolve({ done: false, value: chunks[index++] })
    }),
    cancel: jest.fn().mockResolvedValue(undefined),
    releaseLock: jest.fn(),
  }
  return { name, type, stream: () => ({ getReader: () => reader }), reader }
}

describe('StreamingFileReader', () => {
  afterEach(() => {
    delete anyWindow().showOpenFilePicker
  })

  describe('available', () => {
    it('should be false when showOpenFilePicker is missing', () => {
      expect(StreamingFileReader.available()).toBe(false)
    })

    it('should be true when showOpenFilePicker is present', () => {
      anyWindow().showOpenFilePicker = jest.fn()

      expect(StreamingFileReader.available()).toBe(true)
    })
  })

  describe('maximumFileSize', () => {
    it('should be undefined because streaming imposes no limit', () => {
      expect(StreamingFileReader.maximumFileSize()).toBeUndefined()
    })
  })

  describe('getFilesFromHandles', () => {
    it('should resolve every handle to its file, preserving order', async () => {
      const a = { name: 'a.txt' }
      const b = { name: 'b.txt' }
      const handles = [{ getFile: jest.fn().mockResolvedValue(a) }, { getFile: jest.fn().mockResolvedValue(b) }]

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(StreamingFileReader.getFilesFromHandles(handles as any)).resolves.toEqual([a, b])
    })

    it('should resolve to an empty array for no handles', async () => {
      await expect(StreamingFileReader.getFilesFromHandles([])).resolves.toEqual([])
    })
  })

  describe('selectFiles', () => {
    it('should open a multi-select picker and resolve the chosen handles', async () => {
      const file = { name: 'a.txt' }
      const picker = jest.fn().mockResolvedValue([{ getFile: jest.fn().mockResolvedValue(file) }])
      anyWindow().showOpenFilePicker = picker

      await expect(StreamingFileReader.selectFiles()).resolves.toEqual([file])
      expect(picker).toHaveBeenCalledWith({ multiple: true })
    })

    it('should resolve to an empty array when the user dismisses the picker', async () => {
      anyWindow().showOpenFilePicker = jest.fn().mockRejectedValue(new Error('The user aborted a request.'))

      await expect(StreamingFileReader.selectFiles()).resolves.toEqual([])
    })

    it('should resolve to an empty array when the API is unavailable', async () => {
      await expect(StreamingFileReader.selectFiles()).resolves.toEqual([])
    })
  })

  describe('readFile', () => {
    it('should return the file name and mime type', async () => {
      const file = fileYielding('note.txt', 'text/plain', [chunk(1)])

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await StreamingFileReader.readFile(file as any, 1, jest.fn().mockResolvedValue(undefined))

      expect(response).toEqual({ name: 'note.txt', mimeType: 'text/plain' })
    })

    it('should chunk the stream through ByteChunker, flagging only the final chunk', async () => {
      const file = fileYielding('note.txt', 'text/plain', [chunk(1, 2), chunk(3, 4), chunk(5, 6)])
      const onChunk = jest.fn().mockResolvedValue(undefined)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await StreamingFileReader.readFile(file as any, 2, onChunk)

      expect(onChunk.mock.calls.map(([c]) => [Array.from(c.data), c.index, c.isLast])).toEqual([
        [[1, 2], 1, false],
        [[3, 4], 2, false],
        [[5, 6], 3, true],
      ])
    })

    it('should coalesce chunks smaller than the minimum chunk size', async () => {
      const file = fileYielding('note.txt', 'text/plain', [chunk(1), chunk(2), chunk(3), chunk(4)])
      const onChunk = jest.fn().mockResolvedValue(undefined)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await StreamingFileReader.readFile(file as any, 3, onChunk)

      expect(onChunk.mock.calls.map(([c]) => [Array.from(c.data), c.index, c.isLast])).toEqual([
        [[1, 2, 3], 1, false],
        [[4], 2, true],
      ])
    })

    it('should emit an empty terminal chunk for an empty stream', async () => {
      const file = fileYielding('empty.bin', '', [])
      const onChunk = jest.fn().mockResolvedValue(undefined)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await StreamingFileReader.readFile(file as any, 1, onChunk)

      expect(onChunk.mock.calls).toEqual([[{ data: new Uint8Array(), index: 1, isLast: true }]])
      expect(response).toEqual({ name: 'empty.bin', mimeType: '' })
    })

    it('marks only the second chunk final when the stream ends on an exact chunk boundary', async () => {
      const file = fileYielding('boundary.bin', '', [chunk(1, 2), chunk(3, 4)])
      const onChunk = jest.fn().mockResolvedValue(undefined)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await StreamingFileReader.readFile(file as any, 2, onChunk)

      expect(onChunk.mock.calls.map(([value]) => [Array.from(value.data), value.isLast])).toEqual([
        [[1, 2], false],
        [[3, 4], true],
      ])
    })

    it('cancels the reader, releases its lock, and preserves a consumer error', async () => {
      const file = fileYielding('note.txt', 'text/plain', [chunk(1), chunk(2)])
      const error = new Error('consumer failed')

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(StreamingFileReader.readFile(file as any, 1, jest.fn().mockRejectedValue(error))).rejects.toBe(error)

      expect(file.reader.cancel).toHaveBeenCalledWith(error)
      expect(file.reader.releaseLock).toHaveBeenCalledTimes(1)
    })

    it('cancels the reader, releases its lock, and preserves a read error', async () => {
      const file = fileYielding('note.txt', 'text/plain', [])
      const error = new Error('read failed')
      file.reader.read.mockRejectedValueOnce(error)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(StreamingFileReader.readFile(file as any, 1, jest.fn().mockResolvedValue(undefined))).rejects.toBe(
        error,
      )

      expect(file.reader.cancel).toHaveBeenCalledWith(error)
      expect(file.reader.releaseLock).toHaveBeenCalledTimes(1)
    })
  })
})
