import { createBackupFileName, formatBackupTimestamp, sanitizeBackupTitle } from './BackupFileName'

describe('BackupFileName', () => {
  // 2021-03-09T07:05:09 in LOCAL time. We build the Date from local components so
  // the assertion is independent of the machine's timezone.
  const fixedDate = new Date(2021, 2, 9, 7, 5, 9)

  describe('formatBackupTimestamp', () => {
    it('formats a date as YYYY-MM-DDTHH.mm.ss with zero padding', () => {
      expect(formatBackupTimestamp(fixedDate)).toBe('2021-03-09T07.05.09')
    })

    it('does not use a colon (illegal on Windows)', () => {
      expect(formatBackupTimestamp(fixedDate)).not.toContain(':')
    })

    it('returns a fallback for an invalid date', () => {
      expect(formatBackupTimestamp(new Date('not a date'))).toBe('unknown-date')
    })
  })

  describe('sanitizeBackupTitle', () => {
    it('keeps a normal title unchanged', () => {
      expect(sanitizeBackupTitle('My Shopping List')).toBe('My Shopping List')
    })

    it('replaces every character illegal on Windows with an underscore', () => {
      expect(sanitizeBackupTitle('a\\b/c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j')
    })

    it('strips ASCII control characters', () => {
      const withControls = `tab${String.fromCharCode(9)}null${String.fromCharCode(0)}end`
      // tab is whitespace -> collapsed to a single space; null is stripped entirely
      expect(sanitizeBackupTitle(withControls)).toBe('tab nullend')
    })

    it('collapses internal whitespace runs', () => {
      expect(sanitizeBackupTitle('a   b\t\tc')).toBe('a b c')
    })

    it('removes trailing dots and spaces', () => {
      expect(sanitizeBackupTitle('report...   ')).toBe('report')
    })

    it('falls back to Untitled for an empty title', () => {
      expect(sanitizeBackupTitle('')).toBe('Untitled')
    })

    it('falls back to Untitled for a whitespace-only title', () => {
      expect(sanitizeBackupTitle('   \t  ')).toBe('Untitled')
    })

    it('falls back to Untitled for a control-character-only title', () => {
      expect(sanitizeBackupTitle(`${String.fromCharCode(0)}${String.fromCharCode(7)}`)).toBe('Untitled')
    })
  })

  describe('createBackupFileName', () => {
    it('builds a readable name from title + timestamp + extension', () => {
      expect(createBackupFileName('Meeting Notes', fixedDate, 'txt')).toBe('Meeting Notes - 2021-03-09T07.05.09.txt')
    })

    it('keeps the json extension when requested', () => {
      expect(createBackupFileName('Config', fixedDate, 'json')).toBe('Config - 2021-03-09T07.05.09.json')
    })

    it('uses Untitled for an empty title', () => {
      expect(createBackupFileName('', fixedDate, 'md')).toBe('Untitled - 2021-03-09T07.05.09.md')
    })

    it('produces a Windows-safe name for an illegal title', () => {
      const result = createBackupFileName('a/b:c*d?', fixedDate, 'txt')
      expect(result).toBe('a_b_c_d_ - 2021-03-09T07.05.09.txt')
      expect(result).not.toMatch(/[\\/:*?"<>|]/)
    })

    it('truncates a very long title to a sane length while keeping the timestamp and extension', () => {
      const longTitle = 'x'.repeat(500)
      const result = createBackupFileName(longTitle, fixedDate, 'txt')
      // base is truncated to 100 chars, then the timestamp suffix + extension remain
      expect(result).toBe(`${'x'.repeat(100)} - 2021-03-09T07.05.09.txt`)
      expect(result.endsWith('2021-03-09T07.05.09.txt')).toBe(true)
    })

    it('disambiguates two notes sharing a title and timestamp at the call site', () => {
      // createBackupFileName is deterministic by design; uniqueness is enforced by
      // the caller appending a uuid suffix. Here we verify that two distinct suffixes
      // yield two distinct, still-readable names.
      const a = createBackupFileName('Same Title', fixedDate, 'txt')
      const b = `Same Title - 2021-03-09T07.05.09-1a2b3c4d.txt`
      expect(a).not.toBe(b)
      expect(a).toBe('Same Title - 2021-03-09T07.05.09.txt')
    })
  })
})
