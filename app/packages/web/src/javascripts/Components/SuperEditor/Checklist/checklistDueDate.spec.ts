import {
  CHECKLIST_DUE_FORMATTER_CACHE_SIZE,
  checklistDueAtFromLocalInput,
  checklistDueAtToLocalInput,
  checklistDueExportText,
  formatChecklistDue,
  normalizeChecklistDueAt,
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
