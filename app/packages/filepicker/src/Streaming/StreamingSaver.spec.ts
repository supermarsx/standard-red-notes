import { StreamingFileSaver } from './StreamingSaver'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyWindow = () => globalThis.window as any

const createWritable = () => ({
  write: jest.fn().mockResolvedValue(undefined),
  close: jest.fn().mockResolvedValue(undefined),
})

describe('StreamingFileSaver', () => {
  afterEach(() => {
    delete anyWindow().showSaveFilePicker
    jest.restoreAllMocks()
  })

  describe('available', () => {
    it('should be false when the browser has no showSaveFilePicker', () => {
      expect(StreamingFileSaver.available()).toBe(false)
    })

    it('should be true when the browser exposes showSaveFilePicker', () => {
      anyWindow().showSaveFilePicker = jest.fn()

      expect(StreamingFileSaver.available()).toBe(true)
    })
  })

  describe('selectFileToSaveTo', () => {
    it('should open the picker with the saver name as the suggested name', async () => {
      const writable = createWritable()
      const picker = jest.fn().mockResolvedValue({ createWritable: jest.fn().mockResolvedValue(writable) })
      anyWindow().showSaveFilePicker = picker

      const saver = new StreamingFileSaver('note.txt')

      await expect(saver.selectFileToSaveTo()).resolves.toBe(true)
      expect(picker).toHaveBeenCalledWith({ suggestedName: 'note.txt' })
    })

    it('should use a supplied handle instead of opening the picker', async () => {
      const picker = jest.fn()
      anyWindow().showSaveFilePicker = picker
      const handle = { createWritable: jest.fn().mockResolvedValue(createWritable()) }

      const saver = new StreamingFileSaver('note.txt')

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(saver.selectFileToSaveTo(handle as any)).resolves.toBe(true)
      expect(picker).not.toHaveBeenCalled()
      expect(handle.createWritable).toHaveBeenCalledTimes(1)
    })

    it('should return false when the user dismisses the picker', async () => {
      anyWindow().showSaveFilePicker = jest.fn().mockRejectedValue(new Error('The user aborted a request.'))

      await expect(new StreamingFileSaver('note.txt').selectFileToSaveTo()).resolves.toBe(false)
    })

    it('should return false when the API is unavailable', async () => {
      await expect(new StreamingFileSaver('note.txt').selectFileToSaveTo()).resolves.toBe(false)
    })

    it('should return false when the picker resolves without a handle', async () => {
      anyWindow().showSaveFilePicker = jest.fn().mockResolvedValue(undefined)

      await expect(new StreamingFileSaver('note.txt').selectFileToSaveTo()).resolves.toBe(false)
    })
  })

  describe('pushBytes', () => {
    it('should throw before a destination file has been selected', async () => {
      await expect(new StreamingFileSaver('note.txt').pushBytes(new Uint8Array([1]))).rejects.toThrow(
        'Must call selectFileToSaveTo first',
      )
    })

    it('should write the bytes to the writable stream', async () => {
      const writable = createWritable()
      anyWindow().showSaveFilePicker = jest
        .fn()
        .mockResolvedValue({ createWritable: jest.fn().mockResolvedValue(writable) })
      const saver = new StreamingFileSaver('note.txt')
      await saver.selectFileToSaveTo()

      const bytes = new Uint8Array([1, 2, 3])
      await saver.pushBytes(bytes)

      expect(writable.write).toHaveBeenCalledWith(bytes)
    })
  })

  describe('finish', () => {
    it('should throw before a destination file has been selected', async () => {
      await expect(new StreamingFileSaver('note.txt').finish()).rejects.toThrow('Must call selectFileToSaveTo first')
    })

    it('should close the writable stream', async () => {
      const writable = createWritable()
      anyWindow().showSaveFilePicker = jest
        .fn()
        .mockResolvedValue({ createWritable: jest.fn().mockResolvedValue(writable) })
      const saver = new StreamingFileSaver('note.txt')
      await saver.selectFileToSaveTo()

      await saver.finish()

      expect(writable.close).toHaveBeenCalledTimes(1)
    })
  })

  describe('logging', () => {
    it('should stay silent while loggingEnabled is false', async () => {
      const log = jest.spyOn(console, 'log').mockImplementation(() => undefined)
      const writable = createWritable()
      anyWindow().showSaveFilePicker = jest
        .fn()
        .mockResolvedValue({ createWritable: jest.fn().mockResolvedValue(writable) })
      const saver = new StreamingFileSaver('note.txt')

      await saver.selectFileToSaveTo()
      await saver.pushBytes(new Uint8Array([1]))
      await saver.finish()

      expect(log).not.toHaveBeenCalled()
    })

    it('should log each stage once loggingEnabled is true', async () => {
      const log = jest.spyOn(console, 'log').mockImplementation(() => undefined)
      const writable = createWritable()
      anyWindow().showSaveFilePicker = jest
        .fn()
        .mockResolvedValue({ createWritable: jest.fn().mockResolvedValue(writable) })
      const saver = new StreamingFileSaver('note.txt')
      saver.loggingEnabled = true

      await saver.selectFileToSaveTo()
      await saver.pushBytes(new Uint8Array([1, 2]))
      await saver.finish()

      expect(log.mock.calls).toEqual([
        [['Showing save file picker']],
        [['Writing chunk to disk of size', 2]],
        [['Closing write stream']],
      ])
    })
  })
})
