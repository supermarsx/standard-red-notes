import {
  extensionForImage,
  getImageEntryFileName,
  isImageFile,
  parseRemoteImageUrlsFromSuperNote,
  remoteImageNameFromUrl,
  sanitizeImageName,
} from './NoteImagesUtils'

describe('NoteImagesUtils', () => {
  describe('isImageFile', () => {
    it('detects images by mime type', () => {
      expect(isImageFile('image/png', 'whatever')).toBe(true)
      expect(isImageFile('IMAGE/JPEG', 'whatever')).toBe(true)
    })

    it('detects images by extension when mime is missing', () => {
      expect(isImageFile(undefined, 'photo.PNG')).toBe(true)
      expect(isImageFile(undefined, 'diagram.svg')).toBe(true)
    })

    it('rejects non-images', () => {
      expect(isImageFile('application/pdf', 'doc.pdf')).toBe(false)
      expect(isImageFile(undefined, 'notes.txt')).toBe(false)
      expect(isImageFile(undefined, 'noextension')).toBe(false)
    })
  })

  describe('extensionForImage', () => {
    it('keeps the existing extension on the name', () => {
      expect(extensionForImage('cat.JPG', 'image/png')).toBe('jpg')
    })

    it('infers the extension from mime type when missing', () => {
      expect(extensionForImage('cat', 'image/png')).toBe('png')
      expect(extensionForImage('vector', 'image/svg+xml')).toBe('svg')
      expect(extensionForImage('photo', 'image/jpeg')).toBe('jpg')
    })

    it('returns empty string when nothing is known', () => {
      expect(extensionForImage('cat', undefined)).toBe('')
      expect(extensionForImage('cat', 'application/octet-stream')).toBe('')
    })
  })

  describe('sanitizeImageName', () => {
    it('replaces characters illegal on Windows', () => {
      expect(sanitizeImageName('a/b:c*d?e"f<g>h|i')).toBe('a_b_c_d_e_f_g_h_i')
    })

    it('collapses whitespace and trims trailing dots/spaces', () => {
      expect(sanitizeImageName('  my   image .  ')).toBe('my image')
    })

    it('falls back to "image" when empty', () => {
      expect(sanitizeImageName('   ')).toBe('image')
      expect(sanitizeImageName('')).toBe('image')
    })
  })

  describe('getImageEntryFileName', () => {
    it('builds a sanitized name with the correct extension', () => {
      const used = new Set<string>()
      expect(getImageEntryFileName({ name: 'My Photo.png' }, used)).toBe('My Photo.png')
    })

    it('infers the extension from mime type when the name has none', () => {
      const used = new Set<string>()
      expect(getImageEntryFileName({ name: 'screenshot', mimeType: 'image/png' }, used)).toBe('screenshot.png')
    })

    it('ensures uniqueness on collisions (case-insensitive)', () => {
      const used = new Set<string>()
      expect(getImageEntryFileName({ name: 'photo.png' }, used)).toBe('photo.png')
      expect(getImageEntryFileName({ name: 'photo.png' }, used)).toBe('photo (2).png')
      expect(getImageEntryFileName({ name: 'PHOTO.png' }, used)).toBe('PHOTO (3).png')
    })

    it('sanitizes illegal characters in the base name', () => {
      const used = new Set<string>()
      expect(getImageEntryFileName({ name: 'a/b:c.jpg' }, used)).toBe('a_b_c.jpg')
    })
  })

  describe('parseRemoteImageUrlsFromSuperNote', () => {
    const superNote = JSON.stringify({
      root: {
        children: [
          { type: 'paragraph', children: [{ type: 'text', text: 'hi' }] },
          { type: 'unencrypted-image', src: 'https://example.com/a.png' },
          {
            type: 'listitem',
            children: [{ type: 'unencrypted-image', src: 'https://example.com/b.jpg' }],
          },
          { type: 'unencrypted-image', src: '' },
        ],
      },
    })

    it('extracts remote image urls from nested super json', () => {
      expect(parseRemoteImageUrlsFromSuperNote(superNote)).toEqual([
        'https://example.com/a.png',
        'https://example.com/b.jpg',
      ])
    })

    it('returns [] for plain text / non-super notes', () => {
      expect(parseRemoteImageUrlsFromSuperNote('just some plain text')).toEqual([])
    })

    it('returns [] for invalid json that mentions the node type', () => {
      expect(parseRemoteImageUrlsFromSuperNote('{ broken unencrypted-image')).toEqual([])
    })
  })

  describe('remoteImageNameFromUrl', () => {
    it('uses the basename of the url path', () => {
      expect(remoteImageNameFromUrl('https://example.com/path/cat.png?x=1', 0)).toBe('cat.png')
    })

    it('decodes percent-encoded names', () => {
      expect(remoteImageNameFromUrl('https://example.com/my%20cat.png', 0)).toBe('my cat.png')
    })

    it('falls back to an indexed name when there is no basename', () => {
      expect(remoteImageNameFromUrl('https://example.com/', 2)).toBe('remote-image-3')
    })
  })
})
