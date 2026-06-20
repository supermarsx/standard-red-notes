import { normalizeRows, parseCsv } from './parseCsv'

describe('parseCsv', () => {
  it('parses a simple comma-separated grid', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ])
  })

  it('returns an empty array for empty input', () => {
    expect(parseCsv('')).toEqual([])
  })

  it('handles quoted fields containing commas', () => {
    expect(parseCsv('name,note\n"Smith, John","hello, world"')).toEqual([
      ['name', 'note'],
      ['Smith, John', 'hello, world'],
    ])
  })

  it('handles escaped quotes ("") inside quoted fields', () => {
    expect(parseCsv('"she said ""hi"""')).toEqual([['she said "hi"']])
  })

  it('handles newlines inside quoted fields', () => {
    expect(parseCsv('"line1\nline2",b')).toEqual([['line1\nline2', 'b']])
  })

  it('handles CRLF inside quoted fields', () => {
    expect(parseCsv('"line1\r\nline2",b')).toEqual([['line1\r\nline2', 'b']])
  })

  it('treats CRLF as a record separator', () => {
    expect(parseCsv('a,b\r\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('treats a lone CR as a record separator', () => {
    expect(parseCsv('a,b\rc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('does not emit a trailing empty row for a trailing newline', () => {
    expect(parseCsv('a,b\nc,d\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('does not emit a trailing empty row for a trailing CRLF', () => {
    expect(parseCsv('a,b\r\n')).toEqual([['a', 'b']])
  })

  it('preserves empty fields', () => {
    expect(parseCsv('a,,c\n,,')).toEqual([
      ['a', '', 'c'],
      ['', '', ''],
    ])
  })

  it('parses ragged rows as-is', () => {
    expect(parseCsv('a,b,c\n1,2\nx')).toEqual([['a', 'b', 'c'], ['1', '2'], ['x']])
  })

  it('strips a leading UTF-8 BOM', () => {
    expect(parseCsv('﻿a,b')).toEqual([['a', 'b']])
  })

  it('keeps quoted whitespace exactly', () => {
    expect(parseCsv('"  spaced  ",x')).toEqual([['  spaced  ', 'x']])
  })

  it('supports an alternate delimiter', () => {
    expect(parseCsv('a;b;c', ';')).toEqual([['a', 'b', 'c']])
  })
})

describe('normalizeRows', () => {
  it('pads short rows with empty strings', () => {
    expect(normalizeRows([['a']], 3)).toEqual([['a', '', '']])
  })

  it('truncates long rows', () => {
    expect(normalizeRows([['a', 'b', 'c', 'd']], 2)).toEqual([['a', 'b']])
  })

  it('leaves exact-width rows untouched', () => {
    expect(normalizeRows([['a', 'b']], 2)).toEqual([['a', 'b']])
  })
})
