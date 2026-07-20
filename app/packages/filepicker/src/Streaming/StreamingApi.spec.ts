import { StreamingFileApi } from './StreamingApi'

type WritableStub = {
  write: jest.Mock
  close: jest.Mock
}

const createWritable = (): WritableStub => ({
  write: jest.fn().mockResolvedValue(undefined),
  close: jest.fn().mockResolvedValue(undefined),
})

const chunk = (...bytes: number[]) => new Uint8Array(bytes)

/** A minimal ReadableStream-like reader that yields the supplied chunks then `done`. */
const readerOver = (chunks: Uint8Array[]) => {
  let index = 0
  return {
    read: jest.fn().mockImplementation(() => {
      if (index >= chunks.length) {
        return Promise.resolve({ done: true, value: undefined })
      }
      return Promise.resolve({ done: false, value: chunks[index++] })
    }),
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyWindow = () => globalThis.window as any

describe('StreamingFileApi', () => {
  let api: StreamingFileApi

  beforeEach(() => {
    api = new StreamingFileApi()
  })

  afterEach(() => {
    delete anyWindow().showDirectoryPicker
    delete anyWindow().showOpenFilePicker
  })

  describe('selectDirectory', () => {
    it('should wrap the native handle returned by the picker', async () => {
      const nativeHandle = { name: 'backups' }
      anyWindow().showDirectoryPicker = jest.fn().mockResolvedValue(nativeHandle)

      await expect(api.selectDirectory()).resolves.toEqual({ nativeHandle })
    })

    it('should return "aborted" when the user dismisses the picker', async () => {
      anyWindow().showDirectoryPicker = jest.fn().mockRejectedValue(new Error('The user aborted a request.'))

      await expect(api.selectDirectory()).resolves.toBe('aborted')
    })

    it('should return "aborted" when the API is unavailable', async () => {
      await expect(api.selectDirectory()).resolves.toBe('aborted')
    })
  })

  describe('createFile', () => {
    it('should create the file handle and open a writable stream', async () => {
      const writableStream = createWritable()
      const nativeHandle = { createWritable: jest.fn().mockResolvedValue(writableStream) }
      const directory = {
        nativeHandle: { getFileHandle: jest.fn().mockResolvedValue(nativeHandle) },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any

      const result = await api.createFile(directory, 'note.txt')

      expect(directory.nativeHandle.getFileHandle).toHaveBeenCalledWith('note.txt', { create: true })
      expect(result.nativeHandle).toBe(nativeHandle)
      expect(result.writableStream).toBe(writableStream)
    })
  })

  describe('createDirectory', () => {
    it('should create the child directory and wrap its handle', async () => {
      const nativeHandle = { name: 'child' }
      const parent = {
        nativeHandle: { getDirectoryHandle: jest.fn().mockResolvedValue(nativeHandle) },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any

      const result = await api.createDirectory(parent, 'child')

      expect(parent.nativeHandle.getDirectoryHandle).toHaveBeenCalledWith('child', { create: true })
      expect(result).toEqual({ nativeHandle })
    })
  })

  describe('writing', () => {
    it('saveBytes should write the bytes to the stream', async () => {
      const writableStream = createWritable()
      const bytes = chunk(1, 2, 3)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(api.saveBytes({ writableStream } as any, bytes)).resolves.toBe('success')
      expect(writableStream.write).toHaveBeenCalledWith(bytes)
    })

    it('saveString should write the string to the stream', async () => {
      const writableStream = createWritable()

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(api.saveString({ writableStream } as any, 'hello')).resolves.toBe('success')
      expect(writableStream.write).toHaveBeenCalledWith('hello')
    })

    it('closeFileWriteStream should close the stream', async () => {
      const writableStream = createWritable()

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(api.closeFileWriteStream({ writableStream } as any)).resolves.toBe('success')
      expect(writableStream.close).toHaveBeenCalledTimes(1)
    })
  })

  describe('selectFile', () => {
    it('should wrap the first handle the picker returns', async () => {
      const first = { name: 'first' }
      anyWindow().showOpenFilePicker = jest.fn().mockResolvedValue([first, { name: 'second' }])

      await expect(api.selectFile()).resolves.toEqual({ nativeHandle: first })
    })

    it('should return "aborted" when the picker rejects', async () => {
      anyWindow().showOpenFilePicker = jest.fn().mockRejectedValue(new Error('aborted'))

      await expect(api.selectFile()).resolves.toBe('aborted')
    })
  })

  describe('readFile', () => {
    const handleStreaming = (chunks: Uint8Array[]) => {
      const reader = readerOver(chunks)
      const fileHandle = {
        nativeHandle: {
          getFile: jest.fn().mockResolvedValue({ stream: () => ({ getReader: () => reader }) }),
        },
      }
      return fileHandle
    }

    it('should emit every chunk, marking only the last one as final', async () => {
      const chunks = [chunk(1, 2), chunk(3, 4), chunk(5)]
      const onBytes = jest.fn().mockResolvedValue(undefined)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await api.readFile(handleStreaming(chunks) as any, onBytes)

      expect(result).toBe('success')
      expect(onBytes.mock.calls).toEqual([
        [chunks[0], false],
        [chunks[1], false],
        [chunks[2], true],
      ])
    })

    it('should emit a single chunk as the final one', async () => {
      const only = chunk(9)
      const onBytes = jest.fn().mockResolvedValue(undefined)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await api.readFile(handleStreaming([only]) as any, onBytes)

      expect(onBytes.mock.calls).toEqual([[only, true]])
    })

    // Documents current behaviour, which is arguably wrong: a zero-chunk stream (empty file)
    // hands `undefined` to the callback instead of an empty Uint8Array. Reported, not fixed here.
    it('should emit undefined as the final chunk for an empty stream', async () => {
      const onBytes = jest.fn().mockResolvedValue(undefined)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await api.readFile(handleStreaming([]) as any, onBytes)

      expect(onBytes.mock.calls).toEqual([[undefined, true]])
    })
  })
})
