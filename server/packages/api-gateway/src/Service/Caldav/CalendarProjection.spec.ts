import {
  addCalendarDays,
  CALENDAR_PROJECTION_MAX_DURATION_MINUTES,
  firstInstantOfZonedDate,
  CALENDAR_PROJECTION_MAX_SUMMARY_PREFIX_LENGTH,
  CALENDAR_PROJECTION_MIN_DURATION_MINUTES,
  CalendarProjectionSettings,
  DEFAULT_CALENDAR_PROJECTION,
  isAllDayDeadline,
  isSupportedTimeZone,
  normalizeCalendarProjectionSettings,
  normalizePublishedTodoRecurrence,
  ProjectableTodo,
  PROJECTED_EVENT_UID_PREFIX,
  projectTodosToEvents,
  projectTodoToEvent,
  PublishedTodoRecurrence,
  recurrenceToRRule,
  zonedPartsOf,
} from './CalendarProjection'

const on = (overrides: Partial<CalendarProjectionSettings> = {}): CalendarProjectionSettings => ({
  ...DEFAULT_CALENDAR_PROJECTION,
  enabled: true,
  ...overrides,
})

const task = (overrides: Partial<ProjectableTodo> = {}): ProjectableTodo => ({
  uid: 'task-1',
  summary: 'File taxes',
  due: '2026-03-14T17:00:00.000Z',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_001_000,
  ...overrides,
})

describe('CalendarProjection', () => {
  describe('defaults', () => {
    it('is OFF, so turning CalDAV on cannot start drawing events nobody asked for', () => {
      expect(DEFAULT_CALENDAR_PROJECTION.enabled).toBe(false)
      expect(projectTodoToEvent(task(), DEFAULT_CALENDAR_PROJECTION)).toBeNull()
    })

    it('hides completed tasks and rings no alarm by default', () => {
      expect(DEFAULT_CALENDAR_PROJECTION.completed).toBe('hide')
      expect(DEFAULT_CALENDAR_PROJECTION.alarm).toBe('none')
    })
  })

  describe('normalizeCalendarProjectionSettings', () => {
    it('returns the defaults for a non-object', () => {
      for (const value of [undefined, null, 'x', 7, []]) {
        expect(normalizeCalendarProjectionSettings(value)).toEqual(DEFAULT_CALENDAR_PROJECTION)
      }
    })

    it('falls back FIELD BY FIELD so one bad value cannot revert the rest', () => {
      const normalized = normalizeCalendarProjectionSettings({
        enabled: true,
        allDay: 'nonsense',
        durationMinutes: 45,
        anchor: 'start',
        completed: 'mark',
      })
      expect(normalized.allDay).toBe(DEFAULT_CALENDAR_PROJECTION.allDay)
      expect(normalized.enabled).toBe(true)
      expect(normalized.durationMinutes).toBe(45)
      expect(normalized.anchor).toBe('start')
      expect(normalized.completed).toBe('mark')
    })

    it('treats anything but literal true as not enabled', () => {
      for (const value of ['true', 1, {}, [], 'yes']) {
        expect(normalizeCalendarProjectionSettings({ enabled: value }).enabled).toBe(false)
      }
    })

    it('clamps the duration into its bounds and rounds a fraction', () => {
      expect(normalizeCalendarProjectionSettings({ durationMinutes: 0 }).durationMinutes).toBe(
        CALENDAR_PROJECTION_MIN_DURATION_MINUTES,
      )
      expect(normalizeCalendarProjectionSettings({ durationMinutes: 99_999 }).durationMinutes).toBe(
        CALENDAR_PROJECTION_MAX_DURATION_MINUTES,
      )
      expect(normalizeCalendarProjectionSettings({ durationMinutes: 30.4 }).durationMinutes).toBe(30)
      expect(normalizeCalendarProjectionSettings({ durationMinutes: Number.NaN }).durationMinutes).toBe(
        DEFAULT_CALENDAR_PROJECTION.durationMinutes,
      )
    })

    it('clamps the alarm lead time, allowing zero', () => {
      expect(normalizeCalendarProjectionSettings({ alarmLeadMinutes: 0 }).alarmLeadMinutes).toBe(0)
      expect(normalizeCalendarProjectionSettings({ alarmLeadMinutes: -5 }).alarmLeadMinutes).toBe(0)
      expect(normalizeCalendarProjectionSettings({ alarmLeadMinutes: 1_000_000 }).alarmLeadMinutes).toBe(10_080)
    })

    it('drops an unresolvable time zone rather than storing one that throws on read', () => {
      expect(normalizeCalendarProjectionSettings({ timeZone: 'Mars/Olympus' }).timeZone).toBe('')
      expect(normalizeCalendarProjectionSettings({ timeZone: 'Europe/Berlin' }).timeZone).toBe('Europe/Berlin')
    })

    it('strips control characters from the prefix and bounds its length', () => {
      expect(normalizeCalendarProjectionSettings({ summaryPrefix: 'Due\r\n: ' }).summaryPrefix).toBe('Due: ')
      expect(normalizeCalendarProjectionSettings({ summaryPrefix: 'x'.repeat(200) }).summaryPrefix).toHaveLength(
        CALENDAR_PROJECTION_MAX_SUMMARY_PREFIX_LENGTH,
      )
    })
  })

  describe('isSupportedTimeZone / zonedPartsOf', () => {
    it('rejects a shape that is not a zone name at all', () => {
      expect(isSupportedTimeZone('')).toBe(false)
      expect(isSupportedTimeZone('Europe/Berlin; rm -rf')).toBe(false)
      expect(isSupportedTimeZone('x'.repeat(200))).toBe(false)
    })

    it('reads wall-clock parts in a named zone, normalizing a 24:00 midnight', () => {
      // 2026-03-14T00:00:00Z is 01:00 in Berlin (CET) on the same date.
      expect(zonedPartsOf(Date.parse('2026-03-14T00:00:00.000Z'), 'Europe/Berlin')).toEqual({
        year: 2026,
        month: 3,
        day: 14,
        hour: 1,
        minute: 0,
        second: 0,
      })
      // And exactly midnight in Berlin for 23:00Z the day before.
      expect(zonedPartsOf(Date.parse('2026-03-13T23:00:00.000Z'), 'Europe/Berlin')).toEqual({
        year: 2026,
        month: 3,
        day: 14,
        hour: 0,
        minute: 0,
        second: 0,
      })
    })

    it('treats a blank zone as UTC', () => {
      expect(zonedPartsOf(Date.parse('2026-03-14T00:00:00.000Z'), '')?.hour).toBe(0)
    })

    it('returns undefined for a non-finite instant', () => {
      expect(zonedPartsOf(Number.NaN, '')).toBeUndefined()
    })
  })

  describe('all-day discrimination', () => {
    it('is all-day for a DATE-ONLY stored value under auto and always', () => {
      for (const mode of ['auto', 'always'] as const) {
        expect(isAllDayDeadline('2026-03-14', on({ allDay: mode }))).toBe(true)
      }
    })

    it('never is TOTAL: even a date-only record becomes timed', () => {
      // An axis that silently did nothing for the records published as plain
      // dates would be a setting with no effect for half the feed.
      expect(isAllDayDeadline('2026-03-14', on({ allDay: 'never' }))).toBe(false)
      const event = projectTodoToEvent(task({ due: '2026-03-14' }), on({ allDay: 'never' }))
      expect(event).toMatchObject({
        allDay: false,
        startAt: '2026-03-13T23:00:00.000Z',
        endAt: '2026-03-14T00:00:00.000Z',
      })
    })

    it('anchors a date-only never-event on the first instant of that day IN ZONE', () => {
      expect(
        projectTodoToEvent(task({ due: '2026-03-14' }), on({ allDay: 'never', timeZone: 'Europe/Berlin' }))?.endAt,
      ).toBe('2026-03-13T23:00:00.000Z')
      expect(
        projectTodoToEvent(task({ due: '2026-03-14' }), on({ allDay: 'never', timeZone: 'Pacific/Auckland' }))?.endAt,
      ).toBe('2026-03-13T11:00:00.000Z')
    })

    it('finds the first REAL instant of a day whose local midnight a DST jump deletes', () => {
      // Havana springs forward at 00:00, so 2026-03-08T00:00 does not exist
      // there; the day still does, and 01:00 is its first instant.
      expect(firstInstantOfZonedDate('2026-03-08', 'America/Havana')).toBe(Date.parse('2026-03-08T05:00:00.000Z'))
      expect(
        zonedPartsOf(firstInstantOfZonedDate('2026-03-08', 'America/Havana') as number, 'America/Havana'),
      ).toMatchObject({ year: 2026, month: 3, day: 8, hour: 1 })
    })

    it('refuses a value that is not a calendar date', () => {
      expect(firstInstantOfZonedDate('2026-3-8', '')).toBeUndefined()
      expect(firstInstantOfZonedDate('', '')).toBeUndefined()
    })

    it('auto treats midnight in the projection zone as "a date, no time"', () => {
      expect(isAllDayDeadline('2026-03-14T00:00:00.000Z', on())).toBe(true)
      expect(isAllDayDeadline('2026-03-14T17:00:00.000Z', on())).toBe(false)
    })

    it('auto follows the ZONE: the same instant is a date in UTC and a time in Berlin', () => {
      const instant = '2026-03-14T00:00:00.000Z'
      expect(isAllDayDeadline(instant, on({ timeZone: '' }))).toBe(true)
      expect(isAllDayDeadline(instant, on({ timeZone: 'Europe/Berlin' }))).toBe(false)
      expect(isAllDayDeadline('2026-03-13T23:00:00.000Z', on({ timeZone: 'Europe/Berlin' }))).toBe(true)
    })

    it('auto does not call a sub-second-past-midnight instant a date', () => {
      expect(isAllDayDeadline('2026-03-14T00:00:00.500Z', on())).toBe(false)
    })

    it('always and never override the inference', () => {
      expect(isAllDayDeadline('2026-03-14T17:00:00.000Z', on({ allDay: 'always' }))).toBe(true)
      expect(isAllDayDeadline('2026-03-14T00:00:00.000Z', on({ allDay: 'never' }))).toBe(false)
    })

    it('returns undefined for an unparseable deadline', () => {
      expect(isAllDayDeadline('not-a-date', on())).toBeUndefined()
    })
  })

  describe('addCalendarDays', () => {
    it('crosses a month and a leap day', () => {
      expect(addCalendarDays('2026-03-31', 1)).toBe('2026-04-01')
      expect(addCalendarDays('2024-02-28', 1)).toBe('2024-02-29')
      expect(addCalendarDays('2026-01-01', -1)).toBe('2025-12-31')
    })

    it('rejects a non-date', () => {
      expect(addCalendarDays('2026-3-1', 1)).toBeUndefined()
      expect(addCalendarDays('', 1)).toBeUndefined()
    })
  })

  describe('projectTodoToEvent', () => {
    it('refuses a task with no deadline: an event without a date is not an event', () => {
      expect(projectTodoToEvent(task({ due: undefined }), on())).toBeNull()
      expect(projectTodoToEvent(task({ due: '' }), on())).toBeNull()
    })

    it('refuses a blank summary', () => {
      expect(projectTodoToEvent(task({ summary: '   ' }), on())).toBeNull()
    })

    it('gives the event a uid DISTINCT from the task it describes', () => {
      const event = projectTodoToEvent(task(), on())
      expect(event?.uid).toBe(`${PROJECTED_EVENT_UID_PREFIX}task-1`)
      expect(event?.uid).not.toBe('task-1')
    })

    it('ends a timed event at the deadline by default', () => {
      const event = projectTodoToEvent(task(), on())
      expect(event).toMatchObject({
        allDay: false,
        startAt: '2026-03-14T16:00:00.000Z',
        endAt: '2026-03-14T17:00:00.000Z',
      })
    })

    it('starts a timed event at the deadline under anchor=start', () => {
      expect(projectTodoToEvent(task(), on({ anchor: 'start' }))).toMatchObject({
        startAt: '2026-03-14T17:00:00.000Z',
        endAt: '2026-03-14T18:00:00.000Z',
      })
    })

    it('scales the block with durationMinutes', () => {
      expect(projectTodoToEvent(task(), on({ durationMinutes: 15 }))?.startAt).toBe('2026-03-14T16:45:00.000Z')
      expect(projectTodoToEvent(task(), on({ durationMinutes: 240 }))?.startAt).toBe('2026-03-14T13:00:00.000Z')
    })

    it('makes an all-day END date EXCLUSIVE, so a one-day event spans one day', () => {
      expect(projectTodoToEvent(task({ due: '2026-03-14' }), on())).toMatchObject({
        allDay: true,
        startDate: '2026-03-14',
        endDate: '2026-03-15',
      })
    })

    it('derives the all-day date in the projection zone', () => {
      // 2026-03-14T11:00Z is still the 14th in Berlin but already the 15th in Auckland.
      const auckland = projectTodoToEvent(
        task({ due: '2026-03-14T11:00:00.000Z' }),
        on({
          allDay: 'always',
          timeZone: 'Pacific/Auckland',
        }),
      )
      expect(auckland?.startDate).toBe('2026-03-15')
      const berlin = projectTodoToEvent(
        task({ due: '2026-03-14T11:00:00.000Z' }),
        on({
          allDay: 'always',
          timeZone: 'Europe/Berlin',
        }),
      )
      expect(berlin?.startDate).toBe('2026-03-14')
    })

    it('hides, shows or cancels a completed task per the completed axis', () => {
      const done = task({ completed: true })
      expect(projectTodoToEvent(done, on({ completed: 'hide' }))).toBeNull()
      expect(projectTodoToEvent(done, on({ completed: 'show' }))?.cancelled).toBe(false)
      expect(projectTodoToEvent(done, on({ completed: 'mark' }))?.cancelled).toBe(true)
    })

    it('never marks an OUTSTANDING task cancelled, whatever the completed axis says', () => {
      expect(projectTodoToEvent(task(), on({ completed: 'mark' }))?.cancelled).toBe(false)
    })

    it('carries an alarm only when asked, at the configured lead', () => {
      expect(projectTodoToEvent(task(), on())?.alarmLeadMinutes).toBeUndefined()
      expect(projectTodoToEvent(task(), on({ alarm: 'at-time', alarmLeadMinutes: 99 }))?.alarmLeadMinutes).toBe(0)
      expect(projectTodoToEvent(task(), on({ alarm: 'lead', alarmLeadMinutes: 45 }))?.alarmLeadMinutes).toBe(45)
    })

    it('anchors the alarm to the DEADLINE edge, not blindly to the start', () => {
      expect(projectTodoToEvent(task(), on({ alarm: 'lead' }))?.alarmRelatedToEnd).toBe(true)
      expect(projectTodoToEvent(task(), on({ alarm: 'lead', anchor: 'start' }))?.alarmRelatedToEnd).toBe(false)
      // An all-day event has no end edge to hang a lead off.
      expect(projectTodoToEvent(task({ due: '2026-03-14' }), on({ alarm: 'lead' }))?.alarmRelatedToEnd).toBe(false)
    })

    it('applies the summary prefix verbatim', () => {
      expect(projectTodoToEvent(task(), on({ summaryPrefix: 'Due: ' }))?.summary).toBe('Due: File taxes')
      expect(projectTodoToEvent(task(), on())?.summary).toBe('File taxes')
    })

    it('passes categories through and omits an empty list', () => {
      expect(projectTodoToEvent(task({ categories: ['Work', 'Q1'] }), on())?.categories).toEqual(['Work', 'Q1'])
      expect(projectTodoToEvent(task({ categories: [] }), on())?.categories).toBeUndefined()
    })

    it('copies categories rather than aliasing the stored array', () => {
      const categories = ['Work']
      const event = projectTodoToEvent(task({ categories }), on())
      categories.push('Leaked')
      expect(event?.categories).toEqual(['Work'])
    })

    describe('recurrence axis', () => {
      const repeating = task({ recurrence: { frequency: 'daily', timeZone: 'Europe/Berlin' } })

      it('ignore: a repeating task produces no event at all', () => {
        expect(projectTodoToEvent(repeating, on({ recurrence: 'ignore' }))).toBeNull()
        // A one-off task is untouched by the axis.
        expect(projectTodoToEvent(task(), on({ recurrence: 'ignore' }))).not.toBeNull()
      })

      it('first-only: one event, no rule', () => {
        const event = projectTodoToEvent(repeating, on({ recurrence: 'first-only' }))
        expect(event?.rrule).toBeUndefined()
        expect(event?.recurrenceTimeZone).toBe('Europe/Berlin')
      })

      it('rrule: a real RRULE', () => {
        expect(projectTodoToEvent(repeating, on({ recurrence: 'rrule' }))?.rrule).toBe('FREQ=DAILY')
      })
    })

    it('projects a collection, dropping only what the settings exclude', () => {
      const events = projectTodosToEvents(
        [
          task({ uid: 'a' }),
          task({ uid: 'b', due: undefined }),
          task({ uid: 'c', completed: true }),
          task({ uid: 'd', recurrence: { frequency: 'weekly' } }),
        ],
        on(),
      )
      expect(events.map((event) => event.uid)).toEqual([
        `${PROJECTED_EVENT_UID_PREFIX}a`,
        `${PROJECTED_EVENT_UID_PREFIX}d`,
      ])
    })
  })

  describe('normalizePublishedTodoRecurrence', () => {
    it('accepts the five frequencies and rejects anything else', () => {
      for (const frequency of ['daily', 'weekdays', 'weekly', 'monthly', 'yearly']) {
        expect(normalizePublishedTodoRecurrence({ frequency })).toMatchObject({ frequency })
      }
      expect(normalizePublishedTodoRecurrence({ frequency: 'custom' })).toBeUndefined()
      expect(normalizePublishedTodoRecurrence({ frequency: 'hourly' })).toBeUndefined()
    })

    it('rejects an unknown field, so a malformed rule cannot smuggle data into the store', () => {
      expect(normalizePublishedTodoRecurrence({ frequency: 'daily', extra: 1 })).toBeUndefined()
    })

    it('rejects an out-of-range interval, month day or month', () => {
      expect(normalizePublishedTodoRecurrence({ frequency: 'daily', interval: 0 })).toBeUndefined()
      expect(normalizePublishedTodoRecurrence({ frequency: 'daily', interval: 1_000 })).toBeUndefined()
      expect(normalizePublishedTodoRecurrence({ frequency: 'monthly', monthDay: 32 })).toBeUndefined()
      expect(normalizePublishedTodoRecurrence({ frequency: 'yearly', month: 13 })).toBeUndefined()
    })

    it('drops a redundant interval of 1 so two equal rules compare equal', () => {
      expect(normalizePublishedTodoRecurrence({ frequency: 'daily', interval: 1 })).toEqual({ frequency: 'daily' })
    })

    it('rejects an unresolvable time zone', () => {
      expect(normalizePublishedTodoRecurrence({ frequency: 'daily', timeZone: 'Nowhere/Nothing' })).toBeUndefined()
    })

    it('rejects a non-object', () => {
      for (const value of [undefined, null, 'daily', []]) {
        expect(normalizePublishedTodoRecurrence(value)).toBeUndefined()
      }
    })
  })

  describe('recurrenceToRRule', () => {
    it('maps the exactly-representable frequencies', () => {
      expect(recurrenceToRRule({ frequency: 'daily' })).toBe('FREQ=DAILY')
      expect(recurrenceToRRule({ frequency: 'daily', interval: 3 })).toBe('FREQ=DAILY;INTERVAL=3')
      expect(recurrenceToRRule({ frequency: 'weekly' })).toBe('FREQ=WEEKLY')
      expect(recurrenceToRRule({ frequency: 'weekly', interval: 2 })).toBe('FREQ=WEEKLY;INTERVAL=2')
      expect(recurrenceToRRule({ frequency: 'weekdays' })).toBe('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')
    })

    it('emits no INTERVAL on a weekday rule, which the editor has no notion of', () => {
      expect(recurrenceToRRule({ frequency: 'weekdays', interval: 4 })).toBe('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')
    })

    it('keeps monthly/yearly plain when the anchor day CANNOT be clamped', () => {
      expect(recurrenceToRRule({ frequency: 'monthly', monthDay: 15 })).toBe('FREQ=MONTHLY')
      expect(recurrenceToRRule({ frequency: 'monthly', monthDay: 28, interval: 2 })).toBe('FREQ=MONTHLY;INTERVAL=2')
      expect(recurrenceToRRule({ frequency: 'yearly', monthDay: 10, month: 6 })).toBe('FREQ=YEARLY')
    })

    it('reproduces the editor CLAMP for a day a short month lacks', () => {
      expect(recurrenceToRRule({ frequency: 'monthly', monthDay: 31 })).toBe('FREQ=MONTHLY;BYMONTHDAY=31,-1;BYSETPOS=1')
      expect(recurrenceToRRule({ frequency: 'monthly', monthDay: 29, interval: 3 })).toBe(
        'FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=29,-1;BYSETPOS=1',
      )
      expect(recurrenceToRRule({ frequency: 'yearly', monthDay: 29, month: 2 })).toBe(
        'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29,-1;BYSETPOS=1',
      )
    })

    it('stays plain when a monthly/yearly rule carries no anchor to clamp against', () => {
      expect(recurrenceToRRule({ frequency: 'monthly' })).toBe('FREQ=MONTHLY')
      expect(recurrenceToRRule({ frequency: 'yearly', monthDay: 31 })).toBe('FREQ=YEARLY')
    })

    it('refuses an interval outside the accepted range rather than emitting a broken rule', () => {
      expect(recurrenceToRRule({ frequency: 'daily', interval: 0 } as PublishedTodoRecurrence)).toBeUndefined()
      expect(recurrenceToRRule({ frequency: 'daily', interval: 2_000 } as PublishedTodoRecurrence)).toBeUndefined()
    })

    /**
     * The RRULE is only worth emitting if a client expanding it lands on the same
     * dates the editor's own occurrence math does. The editor CLAMPS
     * (`Math.min(anchor.day, lastDayOfMonth)`); a plain FREQ=MONTHLY SKIPS. This
     * walks both models over four years and asserts they agree, which is the
     * check that would have caught a plain rule being emitted for the 31st.
     */
    describe('agreement with the editor occurrence model', () => {
      const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate()

      /** The editor's own monthly step: anchor day clamped into the target month. */
      const editorMonthly = (year: number, month: number, anchorDay: number, steps: number): string => {
        const index = year * 12 + (month - 1) + steps
        const targetYear = Math.floor(index / 12)
        const targetMonth = (index % 12) + 1
        const day = Math.min(anchorDay, daysInMonth(targetYear, targetMonth))
        return `${targetYear}-${`${targetMonth}`.padStart(2, '0')}-${`${day}`.padStart(2, '0')}`
      }

      /** Expand a monthly RRULE the way RFC 5545 defines it, BYSETPOS included. */
      const expandMonthly = (rrule: string, year: number, month: number, count: number, startDay: number): string[] => {
        const parts = new Map(rrule.split(';').map((part) => part.split('=') as [string, string]))
        expect(parts.get('FREQ')).toBe('MONTHLY')
        const interval = Number(parts.get('INTERVAL') ?? '1')
        const byMonthDay = parts.get('BYMONTHDAY')
        const bySetPos = parts.get('BYSETPOS')
        const dates: string[] = []
        for (let step = 0; dates.length < count; step += 1) {
          const index = year * 12 + (month - 1) + step * interval
          const targetYear = Math.floor(index / 12)
          const targetMonth = (index % 12) + 1
          const lastDay = daysInMonth(targetYear, targetMonth)
          let candidates: number[]
          if (byMonthDay === undefined) {
            // No BYMONTHDAY: the day comes from DTSTART, and a month without it
            // is SKIPPED (the RFC behaviour this code must not rely on).
            candidates = startDay <= lastDay ? [startDay] : []
          } else {
            candidates = byMonthDay
              .split(',')
              .map((value) => (Number(value) < 0 ? lastDay + 1 + Number(value) : Number(value)))
              .filter((day) => day >= 1 && day <= lastDay)
            candidates = Array.from(new Set(candidates)).sort((left, right) => left - right)
            if (bySetPos !== undefined) {
              const position = Number(bySetPos)
              const picked = position > 0 ? candidates[position - 1] : candidates[candidates.length + position]
              candidates = picked === undefined ? [] : [picked]
            }
          }
          for (const day of candidates) {
            dates.push(`${targetYear}-${`${targetMonth}`.padStart(2, '0')}-${`${day}`.padStart(2, '0')}`)
            if (dates.length >= count) {
              break
            }
          }
          if (step > 200) {
            break
          }
        }
        return dates
      }

      it('agrees for every anchor day over four years', () => {
        for (let anchorDay = 1; anchorDay <= 31; anchorDay += 1) {
          const startDay = Math.min(anchorDay, daysInMonth(2026, 1))
          const rrule = recurrenceToRRule({ frequency: 'monthly', monthDay: anchorDay }) as string
          const editor = Array.from({ length: 48 }, (_value, step) => editorMonthly(2026, 1, anchorDay, step))
          expect(expandMonthly(rrule, 2026, 1, 48, startDay)).toEqual(editor)
        }
      })

      it('and the plain rule a day >= 29 would otherwise get does NOT agree', () => {
        // The reason the BYMONTHDAY/BYSETPOS form exists: a plain FREQ=MONTHLY
        // anchored on the 31st loses every short month.
        const editor = Array.from({ length: 12 }, (_value, step) => editorMonthly(2026, 1, 31, step))
        expect(expandMonthly('FREQ=MONTHLY', 2026, 1, 12, 31)).not.toEqual(editor)
      })
    })
  })
})
