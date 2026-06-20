import {
  formatPdfDeepLink,
  isPdfDeepLink,
  parsePdfDeepLink,
  parsePdfFragment,
  SN_FILE_LINK_SCHEME,
} from './PdfDeepLink'

describe('PdfDeepLink', () => {
  const uuid = '3f2a1b4c-0000-4d5e-9f00-aabbccddeeff'

  describe('formatPdfDeepLink', () => {
    it('encodes a bare file link with no target', () => {
      expect(formatPdfDeepLink(uuid)).toBe(`${SN_FILE_LINK_SCHEME}${uuid}`)
    })

    it('encodes a page target', () => {
      expect(formatPdfDeepLink(uuid, { page: 12 })).toBe(`${SN_FILE_LINK_SCHEME}${uuid}#page=12`)
    })

    it('floors non-integer pages and ignores invalid pages', () => {
      expect(formatPdfDeepLink(uuid, { page: 4.9 })).toBe(`${SN_FILE_LINK_SCHEME}${uuid}#page=4`)
      expect(formatPdfDeepLink(uuid, { page: 0 })).toBe(`${SN_FILE_LINK_SCHEME}${uuid}`)
      expect(formatPdfDeepLink(uuid, { page: NaN })).toBe(`${SN_FILE_LINK_SCHEME}${uuid}`)
    })

    it('encodes a page + quote target with url-encoding', () => {
      const link = formatPdfDeepLink(uuid, { page: 3, quote: 'the quick & brown fox' })
      expect(link).toBe(`${SN_FILE_LINK_SCHEME}${uuid}#page=3&quote=the%20quick%20%26%20brown%20fox`)
    })

    it('trims and ignores empty quotes', () => {
      expect(formatPdfDeepLink(uuid, { quote: '   ' })).toBe(`${SN_FILE_LINK_SCHEME}${uuid}`)
      expect(formatPdfDeepLink(uuid, { quote: '  hi  ' })).toBe(`${SN_FILE_LINK_SCHEME}${uuid}#quote=hi`)
    })

    it('throws when uuid is missing', () => {
      expect(() => formatPdfDeepLink('')).toThrow()
    })
  })

  describe('parsePdfDeepLink', () => {
    it('returns undefined for non sn-file links', () => {
      expect(parsePdfDeepLink('https://example.com/foo.pdf#page=2')).toBeUndefined()
      expect(parsePdfDeepLink('')).toBeUndefined()
      // @ts-expect-error testing runtime guard
      expect(parsePdfDeepLink(null)).toBeUndefined()
    })

    it('parses a bare file link', () => {
      expect(parsePdfDeepLink(`${SN_FILE_LINK_SCHEME}${uuid}`)).toEqual({ fileUuid: uuid })
    })

    it('parses a page target', () => {
      expect(parsePdfDeepLink(`${SN_FILE_LINK_SCHEME}${uuid}#page=12`)).toEqual({ fileUuid: uuid, page: 12 })
    })

    it('parses a page + quote target', () => {
      expect(parsePdfDeepLink(`${SN_FILE_LINK_SCHEME}${uuid}#page=3&quote=the%20quick%20%26%20brown%20fox`)).toEqual({
        fileUuid: uuid,
        page: 3,
        quote: 'the quick & brown fox',
      })
    })

    it('is case-insensitive on the scheme and tolerant of whitespace', () => {
      expect(parsePdfDeepLink(`  SN-FILE://${uuid}#page=5  `)).toEqual({ fileUuid: uuid, page: 5 })
    })

    it('returns undefined when uuid is empty', () => {
      expect(parsePdfDeepLink(`${SN_FILE_LINK_SCHEME}#page=5`)).toBeUndefined()
    })
  })

  describe('round-trip', () => {
    it.each([
      { page: undefined, quote: undefined },
      { page: 1, quote: undefined },
      { page: 42, quote: undefined },
      { page: 7, quote: 'a quote with spaces, commas & symbols #?=' },
      { page: undefined, quote: 'unicode: café — naïve' },
    ])('encode -> decode preserves target %j', (target) => {
      const link = formatPdfDeepLink(uuid, target)
      const parsed = parsePdfDeepLink(link)
      expect(parsed?.fileUuid).toBe(uuid)
      expect(parsed?.page).toBe(target.page)
      expect(parsed?.quote).toBe(target.quote)
    })
  })

  describe('parsePdfFragment', () => {
    it('parses a bare #page=N url fragment', () => {
      expect(parsePdfFragment('#page=9')).toEqual({ page: 9 })
      expect(parsePdfFragment('page=9')).toEqual({ page: 9 })
    })

    it('ignores invalid page values', () => {
      expect(parsePdfFragment('page=abc')).toEqual({})
      expect(parsePdfFragment('page=0')).toEqual({})
    })

    it('decodes a quote and tolerates malformed encoding', () => {
      expect(parsePdfFragment('quote=hello%20world')).toEqual({ quote: 'hello world' })
      expect(parsePdfFragment('quote=%E0%A4%A')).toEqual({})
    })

    it('returns empty for empty input', () => {
      expect(parsePdfFragment('')).toEqual({})
    })
  })

  describe('isPdfDeepLink', () => {
    it('detects sn-file links', () => {
      expect(isPdfDeepLink(`${SN_FILE_LINK_SCHEME}${uuid}`)).toBe(true)
      expect(isPdfDeepLink('https://x.com')).toBe(false)
    })
  })
})
