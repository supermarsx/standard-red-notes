import {
  buildOcrFileKey,
  DEFAULT_OCR_LANGUAGE,
  getOcrServerConfig,
  joinPageTexts,
  mergeOcrWithEmbedded,
  OcrCacheStorage,
  OcrPageText,
  pageNeedsOcr,
  readOcrCache,
  writeOcrCache,
} from './pdfOcr'

/** In-memory implementation of the bits of Storage the cache uses. */
function createMemoryStorage(): OcrCacheStorage & { _map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    _map: map,
    get length() {
      return map.size
    },
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      map.set(k, v)
    },
    removeItem: (k: string) => {
      map.delete(k)
    },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
  }
}

describe('pdfOcr', () => {
  describe('pageNeedsOcr', () => {
    it('flags empty / whitespace-only pages', () => {
      expect(pageNeedsOcr('')).toBe(true)
      expect(pageNeedsOcr('   \n\t  ')).toBe(true)
    })

    it('flags pages with only a few stray characters', () => {
      expect(pageNeedsOcr('a b c')).toBe(true) // 3 non-ws chars < 16
    })

    it('does not flag pages with a real text layer', () => {
      expect(pageNeedsOcr('The quick brown fox jumps over the lazy dog')).toBe(false)
    })

    it('respects a custom threshold', () => {
      expect(pageNeedsOcr('abcde', 10)).toBe(true)
      expect(pageNeedsOcr('abcdefghijk', 10)).toBe(false)
    })
  })

  describe('mergeOcrWithEmbedded', () => {
    const embedded: OcrPageText[] = [
      { pageNumber: 1, text: 'native page one text' },
      { pageNumber: 2, text: '' }, // image-only page
      { pageNumber: 3, text: 'partial native' },
    ]

    it('keeps embedded text and ignores OCR for text pages', () => {
      const merged = mergeOcrWithEmbedded(embedded, [{ pageNumber: 1, text: 'OCR ONE' }])
      expect(merged[0]).toEqual({ pageNumber: 1, text: 'native page one text' })
    })

    it('uses OCR text for image-only pages', () => {
      const merged = mergeOcrWithEmbedded(embedded, [{ pageNumber: 2, text: 'scanned text here' }])
      expect(merged[1]).toEqual({ pageNumber: 2, text: 'scanned text here' })
    })

    it('appends OCR to partially-scanned pages without losing embedded text', () => {
      const merged = mergeOcrWithEmbedded(embedded, [{ pageNumber: 3, text: 'extra scanned' }])
      expect(merged[2]).toEqual({ pageNumber: 3, text: 'partial native\nextra scanned' })
    })

    it('ignores blank OCR results', () => {
      const merged = mergeOcrWithEmbedded(embedded, [{ pageNumber: 2, text: '   ' }])
      expect(merged[1]).toEqual({ pageNumber: 2, text: '' })
    })
  })

  describe('joinPageTexts', () => {
    it('joins non-empty pages with blank lines and drops empties', () => {
      expect(
        joinPageTexts([
          { pageNumber: 1, text: 'one' },
          { pageNumber: 2, text: '  ' },
          { pageNumber: 3, text: 'three' },
        ]),
      ).toBe('one\n\nthree')
    })
  })

  describe('buildOcrFileKey', () => {
    it('combines uuid and remote identifier so edited files miss the cache', () => {
      expect(buildOcrFileKey('uuid-1', 'remote-a')).toBe('uuid-1:remote-a')
      expect(buildOcrFileKey('uuid-1', 'remote-b')).not.toBe(buildOcrFileKey('uuid-1', 'remote-a'))
    })

    it('falls back to uuid when no remote identifier', () => {
      expect(buildOcrFileKey('uuid-1')).toBe('uuid-1')
    })
  })

  describe('cache read/write round-trip', () => {
    it('writes then reads back the same pages', () => {
      const storage = createMemoryStorage()
      const pages: OcrPageText[] = [
        { pageNumber: 1, text: 'hello' },
        { pageNumber: 2, text: 'world' },
      ]
      expect(writeOcrCache('file-a', pages, storage)).toBe(true)
      expect(readOcrCache('file-a', storage)).toEqual(pages)
    })

    it('returns undefined on a cache miss', () => {
      const storage = createMemoryStorage()
      expect(readOcrCache('nope', storage)).toBeUndefined()
    })

    it('does not return another file key (content changed => miss)', () => {
      const storage = createMemoryStorage()
      writeOcrCache('uuid:remote-a', [{ pageNumber: 1, text: 'old' }], storage)
      expect(readOcrCache('uuid:remote-b', storage)).toBeUndefined()
    })

    it('skips caching oversized entries', () => {
      const storage = createMemoryStorage()
      const huge = 'x'.repeat(2_000_001)
      expect(writeOcrCache('big', [{ pageNumber: 1, text: huge }], storage)).toBe(false)
      expect(readOcrCache('big', storage)).toBeUndefined()
    })

    it('evicts the oldest entries past the cap', () => {
      const storage = createMemoryStorage()
      // Write 21 entries with increasing timestamps; cap is 20.
      let now = 1000
      const realNow = Date.now
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(Date as any).now = () => now
        for (let i = 0; i < 21; i++) {
          now += 1
          writeOcrCache(`file-${i}`, [{ pageNumber: 1, text: `t${i}` }], storage)
        }
      } finally {
        Date.now = realNow
      }
      // The very first (oldest) entry should have been evicted.
      expect(readOcrCache('file-0', storage)).toBeUndefined()
      expect(readOcrCache('file-20', storage)).toEqual([{ pageNumber: 1, text: 't20' }])
    })

    it('recovers from a quota error by evicting and retrying', () => {
      const storage = createMemoryStorage()
      writeOcrCache('old', [{ pageNumber: 1, text: 'old' }], storage)
      let throwOnce = true
      const realSet = storage.setItem.bind(storage)
      storage.setItem = (k: string, v: string) => {
        if (throwOnce) {
          throwOnce = false
          throw new DOMException('QuotaExceededError')
        }
        realSet(k, v)
      }
      expect(writeOcrCache('new', [{ pageNumber: 1, text: 'new' }], storage)).toBe(true)
      expect(readOcrCache('new', storage)).toEqual([{ pageNumber: 1, text: 'new' }])
    })
  })

  describe('getOcrServerConfig', () => {
    it('defaults to disabled with the default language', () => {
      expect(getOcrServerConfig({})).toEqual({ enabled: false, defaultLanguage: DEFAULT_OCR_LANGUAGE })
    })

    it('reads the enabled flag and custom language', () => {
      expect(getOcrServerConfig({ ocrEnabled: true, ocrDefaultLanguage: 'deu' })).toEqual({
        enabled: true,
        defaultLanguage: 'deu',
      })
    })

    it('falls back to default language when blank', () => {
      expect(getOcrServerConfig({ ocrEnabled: true, ocrDefaultLanguage: '   ' })).toEqual({
        enabled: true,
        defaultLanguage: DEFAULT_OCR_LANGUAGE,
      })
    })

    it('treats a non-true flag as disabled', () => {
      // @ts-expect-error intentionally wrong type to verify strict check
      expect(getOcrServerConfig({ ocrEnabled: 'yes' }).enabled).toBe(false)
    })
  })
})
