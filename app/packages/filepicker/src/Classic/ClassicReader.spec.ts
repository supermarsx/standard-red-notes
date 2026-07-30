import { ClassicFileReader } from './ClassicReader'

const FileInputId = 'classic-reader-file-input'

const fileOfBytes = (name: string, type: string, bytes: Uint8Array) => new File([bytes as BlobPart], name, { type })

describe('ClassicFileReader', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('should always report itself as available', () => {
    expect(ClassicFileReader.available()).toBe(true)
  })

  it('should cap the classic (non-streaming) path at 50 MB', () => {
    expect(ClassicFileReader.maximumFileSize()).toBe(50_000_000)
  })

  describe('selectFiles', () => {
    it('should append a hidden multi-select file input to the body', () => {
      void ClassicFileReader.selectFiles()

      const input = document.getElementById(FileInputId) as HTMLInputElement
      expect(input).not.toBeNull()
      expect(input.type).toBe('file')
      expect(input.multiple).toBe(true)
      expect(input.style.opacity).toBe('0')
      expect(input.style.position).toBe('absolute')
    })

    it('should reuse the existing input rather than creating a second one', () => {
      void ClassicFileReader.selectFiles()
      void ClassicFileReader.selectFiles()

      expect(document.querySelectorAll(`#${FileInputId}`).length).toBe(1)
    })

    it('should resolve with the selected files and clear the input value', async () => {
      const promise = ClassicFileReader.selectFiles()
      const input = document.getElementById(FileInputId) as HTMLInputElement
      const first = new File(['a'], 'a.txt')
      const second = new File(['b'], 'b.txt')

      // jsdom will not let us assign to input.files, so drive the handler directly with a
      // synthetic event whose target carries the FileList the browser would have supplied.
      await (input.onchange as unknown as (event: { target: { files: File[] } }) => Promise<void>)({
        target: { files: [first, second] },
      })

      await expect(promise).resolves.toEqual([first, second])
      expect(input.value).toBe('')
    })

    it('should resolve with an empty array when the user selects nothing', async () => {
      const promise = ClassicFileReader.selectFiles()
      const input = document.getElementById(FileInputId) as HTMLInputElement

      await (input.onchange as unknown as (event: { target: { files: File[] } }) => Promise<void>)({
        target: { files: [] },
      })

      await expect(promise).resolves.toEqual([])
    })
  })

  describe('readFile', () => {
    it('should return the file name and mime type', async () => {
      const file = fileOfBytes('note.txt', 'text/plain', new Uint8Array([1, 2, 3]))

      await expect(ClassicFileReader.readFile(file, 1, jest.fn().mockResolvedValue(undefined))).resolves.toEqual({
        name: 'note.txt',
        mimeType: 'text/plain',
      })
    })

    it('should deliver the whole file through the chunker, flagging the final chunk', async () => {
      const file = fileOfBytes('note.txt', 'text/plain', new Uint8Array([1, 2, 3, 4]))
      const onChunk = jest.fn().mockResolvedValue(undefined)

      await ClassicFileReader.readFile(file, 2, onChunk)

      expect(onChunk).toHaveBeenCalledTimes(1)
      const chunk = onChunk.mock.calls[0][0]
      expect(Array.from(chunk.data)).toEqual([1, 2, 3, 4])
      expect(chunk.index).toBe(1)
      expect(chunk.isLast).toBe(true)
    })

    it('should emit an empty terminal chunk for an empty file', async () => {
      const onChunk = jest.fn().mockResolvedValue(undefined)

      const response = await ClassicFileReader.readFile(fileOfBytes('empty.bin', '', new Uint8Array([])), 1, onChunk)

      expect(onChunk).toHaveBeenCalledTimes(1)
      expect(onChunk.mock.calls[0][0]).toEqual({
        data: new Uint8Array(),
        index: 1,
        isLast: true,
      })
      expect(response).toEqual({ name: 'empty.bin', mimeType: '' })
    })

    it('marks only the second read as terminal when the file ends on an exact read boundary', async () => {
      const bytes = new Uint8Array(4_000_000)
      bytes[0] = 1
      bytes[2_000_000] = 2
      const onChunk = jest.fn().mockResolvedValue(undefined)

      await ClassicFileReader.readFile(fileOfBytes('boundary.bin', '', bytes), 2_000_000, onChunk)

      expect(onChunk).toHaveBeenCalledTimes(2)
      expect(onChunk.mock.calls.map(([value]) => [value.data.length, value.data[0], value.isLast])).toEqual([
        [2_000_000, 1, false],
        [2_000_000, 2, true],
      ])
    })

    it('propagates a terminal chunk callback error', async () => {
      const error = new Error('consumer failed')
      const onChunk = jest.fn().mockRejectedValue(error)

      await expect(
        ClassicFileReader.readFile(fileOfBytes('note.txt', 'text/plain', new Uint8Array([1])), 1, onChunk),
      ).rejects.toBe(error)
    })
  })
})
