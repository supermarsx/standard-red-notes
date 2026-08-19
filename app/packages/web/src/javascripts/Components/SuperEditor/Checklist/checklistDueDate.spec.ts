import {
  CHECKLIST_DUE_FORMATTER_CACHE_SIZE,
  checklistDueAtFromLocalInput,
  checklistDueAtToLocalInput,
  checklistDueExportText,
  composeChecklistDueLocalInput,
  formatChecklistDue,
  normalizeChecklistDueAt,
  splitChecklistDueLocalInput,
} from './checklistDueDate'

describe('checklist due dates', () => {
  const now = Date.parse('2026-08-11T12:00:00.000Z')

  it('normalizes valid instants to UTC and rejects malformed or out-of-range values', () => {
    expect(normalizeChecklistDueAt('2026-08-11T13:00:00+01:00')).toBe('2026-08-11T12:00:00.000Z')
    expect(normalizeChecklistDueAt('2026-08-11T13:00:00')).toBeUndefined()
    expect(normalizeChecklistDueAt('2026-02-30T12:00:00Z')).toBeUndefined()
    expect(normalizeChecklistDueAt('not-a-date')).toBeUndefined()
    expect(normalizeChecklistDueAt('1969-12-31T23:59:59.000Z')).toBeUndefined()
  })

  it('round-trips a local datetime without changing the represented instant', () => {
    const local = checklistDueAtToLocalInput('2026-08-11T12:34:00.000Z')
    const roundTrip = checklistDueAtFromLocalInput(local)
    expect(Date.parse(roundTrip ?? '')).toBe(Date.parse('2026-08-11T12:34:00.000Z'))
  })

  it('rejects malformed, overflowing, and normalized-away local wall times without throwing', () => {
    expect(() => checklistDueAtFromLocalInput('2026-99-99T99:99')).not.toThrow()
    expect(checklistDueAtFromLocalInput('2026-99-99T99:99')).toBeUndefined()
    expect(checklistDueAtFromLocalInput('2026-02-30T10:00')).toBeUndefined()

    // The component round-trip is also what rejects a local time skipped by a
    // daylight-saving transition in time zones where that wall time exists.
    const accepted = checklistDueAtFromLocalInput('2026-03-29T01:30')
    if (accepted) {
      expect(checklistDueAtToLocalInput(accepted)).toBe('2026-03-29T01:30')
    }
  })

  it('defaults a date with no time to local 00:00', () => {
    const dateOnly = checklistDueAtFromLocalInput('2026-08-20')
    expect(dateOnly).toBeDefined()
    // Local, not UTC: the wall value read back must be midnight on that date.
    expect(checklistDueAtToLocalInput(dateOnly!)).toBe('2026-08-20T00:00')
    // "No time" and an explicit 00:00 describe the same instant.
    expect(dateOnly).toBe(checklistDueAtFromLocalInput('2026-08-20T00:00'))
  })

  it('leaves an explicitly supplied time alone', () => {
    const timed = checklistDueAtFromLocalInput('2026-08-20T17:45')
    expect(checklistDueAtToLocalInput(timed!)).toBe('2026-08-20T17:45')
    expect(timed).not.toBe(checklistDueAtFromLocalInput('2026-08-20'))
  })

  it('rejects a date-only value that is not a real calendar day', () => {
    expect(checklistDueAtFromLocalInput('2026-02-30')).toBeUndefined()
    expect(checklistDueAtFromLocalInput('2026-13-01')).toBeUndefined()
    expect(checklistDueAtFromLocalInput('1969-12-31')).toBeUndefined()
    expect(checklistDueAtFromLocalInput('20260820')).toBeUndefined()
    expect(checklistDueAtFromLocalInput('2026-08-20T')).toBeUndefined()
    expect(checklistDueAtFromLocalInput('')).toBeUndefined()
  })

  it('resolves a defaulted midnight on every daylight-saving boundary to the start of that day', () => {
    // Northern and southern spring-forward / fall-back dates. Some zones (e.g.
    // parts of South America) jump AT 00:00, so midnight itself can be missing;
    // a date-only entry must still land on the first instant of that day rather
    // than failing the way an explicitly typed missing wall time does.
    for (const day of ['2026-03-08', '2026-03-29', '2026-04-05', '2026-09-06', '2026-10-18', '2026-11-01']) {
      const resolved = checklistDueAtFromLocalInput(day)
      expect(resolved).toBeDefined()
      const local = checklistDueAtToLocalInput(resolved!)
      expect(local.slice(0, 10)).toBe(day)
      // Nothing earlier on that day exists: one minute back is the previous day.
      const earlier = new Date(Date.parse(resolved!) - 60_000)
      expect(checklistDueAtToLocalInput(earlier.toISOString()).slice(0, 10)).not.toBe(day)
    }
  })

  it('splits and recombines the date and optional time halves of a wall value', () => {
    expect(splitChecklistDueLocalInput('2026-08-20T17:45')).toEqual({ date: '2026-08-20', time: '17:45' })
    expect(splitChecklistDueLocalInput('2026-08-20')).toEqual({ date: '2026-08-20', time: '' })
    expect(splitChecklistDueLocalInput('')).toEqual({ date: '', time: '' })

    expect(composeChecklistDueLocalInput('2026-08-20', '17:45')).toBe('2026-08-20T17:45')
    expect(composeChecklistDueLocalInput('2026-08-20', '')).toBe('2026-08-20')
    expect(composeChecklistDueLocalInput('2026-08-20', '  ')).toBe('2026-08-20')
    // A time with no date is not a schedule; it must not become "today".
    expect(composeChecklistDueLocalInput('', '17:45')).toBe('')
    expect(checklistDueAtFromLocalInput(composeChecklistDueLocalInput('', '17:45'))).toBeUndefined()
  })

  it('reports day/hour time remaining and the due-soon boundary', () => {
    const upcoming = formatChecklistDue('2026-08-13T14:00:00.000Z', false, now, 'en-GB')
    expect(upcoming?.state).toBe('upcoming')
    expect(upcoming?.relativeLabel).toBe('2d 2h left')

    const dueSoon = formatChecklistDue('2026-08-12T12:00:00.000Z', false, now, 'en-GB')
    expect(dueSoon?.state).toBe('due-soon')
    expect(dueSoon?.relativeLabel).toBe('1d left')

    expect(formatChecklistDue('2026-08-11T13:59:59.000Z', false, now, 'en-GB')?.relativeLabel).toBe('2h left')
  })

  it('changes to overdue exactly at the deadline and keeps completed items completed', () => {
    expect(formatChecklistDue('2026-08-11T12:00:00.000Z', false, now, 'en-GB')?.state).toBe('overdue')
    expect(formatChecklistDue('2026-08-11T11:00:00.000Z', false, now, 'en-GB')?.relativeLabel).toBe('Overdue by 1h')
    expect(formatChecklistDue('2026-08-10T11:00:00.000Z', true, now, 'en-GB')?.state).toBe('completed')
    expect(formatChecklistDue('2026-08-10T11:00:00.000Z', true, now, 'en-GB')?.relativeLabel).toBe('Completed')
  })

  it('reuses row formatters and bounds explicit-locale formatter memory', () => {
    const constructor = jest.spyOn(Intl, 'DateTimeFormat')
    try {
      const beforeDefaultRows = constructor.mock.calls.length
      for (let index = 0; index < 100; index += 1) {
        expect(formatChecklistDue('2026-08-13T14:00:00.000Z', false, now)).toBeDefined()
      }
      expect(constructor.mock.calls.length - beforeDefaultRows).toBe(1)

      const locales = [
        'en-US',
        'fr-FR',
        'de-DE',
        'es-ES',
        'pt-PT',
        'it-IT',
        'nl-NL',
        'sv-SE',
        'da-DK',
        'fi-FI',
        'pl-PL',
        'cs-CZ',
        'ja-JP',
        'ko-KR',
        'zh-CN',
        'ar-EG',
        'he-IL',
      ]
      expect(locales.length).toBeGreaterThan(CHECKLIST_DUE_FORMATTER_CACHE_SIZE)
      for (const locale of locales) {
        expect(formatChecklistDue('2026-08-13T14:00:00.000Z', false, now, locale)).toBeDefined()
      }
      const afterFill = constructor.mock.calls.length
      expect(formatChecklistDue('2026-08-13T14:00:00.000Z', false, now, 'en-US')).toBeDefined()
      expect(constructor.mock.calls.length - afterFill).toBe(1)
    } finally {
      constructor.mockRestore()
    }
  })

  it('includes the canonical UTC instant in portable text alongside the localized label', () => {
    const exported = checklistDueExportText('2026-08-11T13:00:00+01:00', false, now)

    expect(exported).toContain('[2026-08-11T12:00:00.000Z]')
    expect(exported).toContain('(Overdue by 0m)')
  })
})
