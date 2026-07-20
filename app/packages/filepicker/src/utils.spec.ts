import { formatSizeToReadableString, readFile, saveFile } from './utils'
import { parseFileName } from '@standardnotes/utils'

describe('utils', () => {
  describe('readFile', () => {
    it('should read a file into a Uint8Array of its bytes', async () => {
      const file = new File([new Uint8Array([1, 2, 3, 250])], 'bytes.bin')

      const bytes = await readFile(file)

      expect(bytes).toBeInstanceOf(Uint8Array)
      expect(Array.from(bytes)).toEqual([1, 2, 3, 250])
    })

    it('should read an empty file as an empty Uint8Array', async () => {
      const bytes = await readFile(new File([], 'empty.bin'))

      expect(bytes.length).toBe(0)
    })
  })

  describe('saveFile', () => {
    let createObjectURL: jest.Mock
    let revokeObjectURL: jest.Mock
    let click: jest.SpyInstance

    beforeEach(() => {
      createObjectURL = jest.fn().mockReturnValue('blob:srn/download')
      revokeObjectURL = jest.fn()
      // jsdom implements neither of these.
      window.URL.createObjectURL = createObjectURL
      window.URL.revokeObjectURL = revokeObjectURL
      // Prevent jsdom from attempting a real navigation on the synthetic click.
      click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    })

    afterEach(() => {
      click.mockRestore()
      delete (window.URL as unknown as Record<string, unknown>).createObjectURL
      delete (window.URL as unknown as Record<string, unknown>).revokeObjectURL
    })

    it('should click a download link pointing at an object URL for the bytes', () => {
      saveFile('note.txt', new Uint8Array([1, 2, 3]))

      expect(createObjectURL).toHaveBeenCalledTimes(1)
      expect(createObjectURL.mock.calls[0][0]).toBeInstanceOf(Blob)
      expect(createObjectURL.mock.calls[0][0].type).toBe('text/plain;charset=utf-8')
      expect(click).toHaveBeenCalledTimes(1)
    })

    it('should set the download attribute to the requested file name', () => {
      let downloadName: string | null = null
      click.mockImplementation(function (this: HTMLAnchorElement) {
        downloadName = this.getAttribute('download')
      })

      saveFile('my note.txt', new Uint8Array([1]))

      expect(downloadName).toBe('my note.txt')
    })

    it('should remove the link from the document and revoke the object URL', () => {
      saveFile('note.txt', new Uint8Array([1]))

      expect(document.querySelectorAll('a').length).toBe(0)
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:srn/download')
    })
  })

  describe('parseFileName', () => {
    it('should parse regular filenames', () => {
      const fileName = 'test.txt'

      const { name, ext } = parseFileName(fileName)

      expect(name).toBe('test')
      expect(ext).toBe('txt')
    })

    it('should parse filenames with multiple dots', () => {
      const fileName = 'Screen Shot 2022-03-06 at 12.13.32 PM.png'

      const { name, ext } = parseFileName(fileName)

      expect(name).toBe('Screen Shot 2022-03-06 at 12.13.32 PM')
      expect(ext).toBe('png')
    })

    it('should parse filenames without extensions', () => {
      const fileName = 'extensionless'

      const { name, ext } = parseFileName(fileName)

      expect(name).toBe('extensionless')
      expect(ext).toBe('')
    })
  })

  describe('formatSizeToReadableString', () => {
    it('should show as bytes if less than 1KB', () => {
      const size = 1_023

      const formattedSize = formatSizeToReadableString(size)

      expect(formattedSize).toBe('1023 B')
    })

    it('should format as KB', () => {
      const size = 1_024

      const formattedSize = formatSizeToReadableString(size)

      expect(formattedSize).toBe('1 KB')
    })

    it('should format as MB', () => {
      const size = 1_048_576

      const formattedSize = formatSizeToReadableString(size)

      expect(formattedSize).toBe('1 MB')
    })

    it('should format as GB', () => {
      const size = 1_073_741_824

      const formattedSize = formatSizeToReadableString(size)

      expect(formattedSize).toBe('1 GB')
    })

    it('should only show fixed-point notation if calculated size is not an integer', () => {
      const size1 = 1_048_576
      const size2 = 1_572_864

      const formattedSize1 = formatSizeToReadableString(size1)
      const formattedSize2 = formatSizeToReadableString(size2)

      expect(formattedSize1).toBe('1 MB')
      expect(formattedSize2).toBe('1.50 MB')
    })
  })
})
