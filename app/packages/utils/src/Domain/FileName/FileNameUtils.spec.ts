import {
  createZippableFileName,
  parseAndCreateZippableFileName,
  parseFileName,
  sanitizeFileName,
  truncateFileName,
} from './FileNameUtils'

describe('parseFileName', () => {
  it('should split a simple name and extension', () => {
    expect(parseFileName('note.txt')).toEqual({ name: 'note', ext: 'txt' })
  })

  it('should split on the last dot only', () => {
    expect(parseFileName('archive.tar.gz')).toEqual({ name: 'archive.tar', ext: 'gz' })
  })

  it('should return an empty extension when there is no dot', () => {
    expect(parseFileName('extensionless')).toEqual({ name: 'extensionless', ext: '' })
  })

  it('should treat a leading dot as an extension with an empty name', () => {
    expect(parseFileName('.gitignore')).toEqual({ name: '', ext: 'gitignore' })
  })

  it('should return an empty extension for a trailing dot', () => {
    expect(parseFileName('trailing.')).toEqual({ name: 'trailing', ext: '' })
  })
})

describe('sanitizeFileName', () => {
  it('should replace every reserved character with an underscore', () => {
    expect(sanitizeFileName('a.b\\c/d:e"f?g*h|i<j>k')).toBe('a_b_c_d_e_f_g_h_i_j_k')
  })

  it('should trim surrounding whitespace', () => {
    expect(sanitizeFileName('  spaced  ')).toBe('spaced')
  })

  it('should leave an already safe name untouched', () => {
    expect(sanitizeFileName('safe name-1')).toBe('safe name-1')
  })
})

describe('truncateFileName', () => {
  it('should cut a name longer than the maximum', () => {
    expect(truncateFileName('abcdefgh', 3)).toBe('abc')
  })

  it('should leave a name at exactly the maximum alone', () => {
    expect(truncateFileName('abc', 3)).toBe('abc')
  })

  it('should leave a shorter name alone', () => {
    expect(truncateFileName('ab', 3)).toBe('ab')
  })
})

describe('createZippableFileName', () => {
  it('should default to a .txt extension and no suffix', () => {
    expect(createZippableFileName('note')).toBe('note.txt')
  })

  it('should append the suffix before the extension', () => {
    expect(createZippableFileName('note', '-1', 'md')).toBe('note-1.md')
  })

  it('should sanitize the name', () => {
    expect(createZippableFileName('a/b:c')).toBe('a_b_c.txt')
  })

  it('should truncate at the default 100 character limit', () => {
    expect(createZippableFileName('x'.repeat(150))).toBe('x'.repeat(100) + '.txt')
  })

  it('should honour an explicit maximum length', () => {
    expect(createZippableFileName('abcdefgh', '', 'txt', 4)).toBe('abcd.txt')
  })
})

describe('parseAndCreateZippableFileName', () => {
  it('should keep the original extension', () => {
    expect(parseAndCreateZippableFileName('report.md')).toBe('report.md')
  })

  it('should insert the suffix before the original extension', () => {
    expect(parseAndCreateZippableFileName('report.md', '-copy')).toBe('report-copy.md')
  })

  it('should produce a trailing dot for a name without an extension', () => {
    expect(parseAndCreateZippableFileName('report')).toBe('report.')
  })
})
