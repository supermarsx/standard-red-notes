/**
 * @jest-environment node
 */
import { createHash } from 'node:crypto'
import {
  EVENT_MODEL_VERSION,
  EventModel,
  ModelTime,
  TEXT_LIMITS,
  canonicalEvent,
  canonicalRule,
  clipText,
  clipTexts,
  fingerprintOfEvent,
  parseRule,
  ruleOfSimpleRecurrence,
  shortDigest,
  simpleRecurrenceOf,
  weekdayIndex,
} from './eventModel'

const zoned = (value: string, zone = 'Europe/Berlin'): ModelTime => ({ kind: 'zoned', value, zone })
const date = (value: string): ModelTime => ({ kind: 'date', value })

// 6 January 2026 is a Tuesday.
const tuesdayEvening = zoned('2026-01-06T18:00:00', 'America/New_York')

describe('canonicalRule', () => {
  it.each([
    // Other apps write out what the start already fixes; the app's own editor does not.
    ['FREQ=WEEKLY;BYDAY=TU', tuesdayEvening, 'FREQ=WEEKLY'],
    ['FREQ=WEEKLY;WKST=MO;BYDAY=TU;INTERVAL=1', tuesdayEvening, 'FREQ=WEEKLY'],
    ['FREQ=WEEKLY;INTERVAL=2;BYDAY=TU', tuesdayEvening, 'FREQ=WEEKLY;INTERVAL=2'],
    ['FREQ=MONTHLY;BYMONTHDAY=6', tuesdayEvening, 'FREQ=MONTHLY'],
    ['FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=6', tuesdayEvening, 'FREQ=YEARLY'],
    ['FREQ=YEARLY;BYMONTH=1', tuesdayEvening, 'FREQ=YEARLY'],
    ['FREQ=YEARLY;BYMONTHDAY=29;BYMONTH=2', date('2024-02-29'), 'FREQ=YEARLY'],
    ['FREQ=DAILY;INTERVAL=1', tuesdayEvening, 'FREQ=DAILY'],
    ['freq=weekly;byday=tu', tuesdayEvening, 'FREQ=WEEKLY'],
  ])('reads %j for an event starting on that day as plain %3$j', (rule, start, canonical) => {
    expect(canonicalRule(rule, start)).toBe(canonical)
  })

  it.each([
    // The same words, but they now say something the start does not.
    ['FREQ=WEEKLY;BYDAY=WE', 'FREQ=WEEKLY;BYDAY=WE'],
    ['FREQ=WEEKLY;BYDAY=TU,TH', 'FREQ=WEEKLY;BYDAY=TU,TH'],
    ['FREQ=MONTHLY;BYMONTHDAY=7', 'FREQ=MONTHLY;BYMONTHDAY=7'],
    ['FREQ=MONTHLY;BYDAY=1TU', 'FREQ=MONTHLY;BYDAY=1TU'],
    ['FREQ=YEARLY;BYMONTH=2', 'FREQ=YEARLY;BYMONTH=2'],
    ['FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=7', 'FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=7'],
    // With a count or an end in play the rule is not the simple form, so nothing is dropped from it.
    ['FREQ=WEEKLY;BYDAY=TU;COUNT=10', 'FREQ=WEEKLY;COUNT=10;BYDAY=TU'],
    ['FREQ=WEEKLY;BYDAY=TU;UNTIL=20260630T215959Z', 'FREQ=WEEKLY;UNTIL=20260630T215959Z;BYDAY=TU'],
    ['FREQ=WEEKLY;BYDAY=TU;WKST=SU;INTERVAL=2', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;WKST=SU'],
  ])('keeps what %j says beyond the start', (rule, canonical) => {
    expect(canonicalRule(rule, tuesdayEvening)).toBe(canonical)
  })

  it('writes the parts in one order and every list sorted', () => {
    const scrambled =
      'BYSETPOS=-1,1;WKST=SU;BYDAY=FR,-1MO,2TU,MO;BYMONTH=12,3;COUNT=5;INTERVAL=3;FREQ=MONTHLY;BYMONTHDAY=31,-1,15'
    expect(canonicalRule(scrambled, tuesdayEvening)).toBe(
      'FREQ=MONTHLY;INTERVAL=3;COUNT=5;BYMONTH=3,12;BYMONTHDAY=-1,15,31;BYDAY=-1MO,MO,FR,2TU;BYSETPOS=-1,1;WKST=SU',
    )
  })

  it('keeps a part it has never heard of, after the ones it knows', () => {
    expect(canonicalRule('X-VENDOR=YES;FREQ=DAILY;COUNT=3', tuesdayEvening)).toBe('FREQ=DAILY;COUNT=3;X-VENDOR=YES')
  })

  it('reads a rule with no frequency as no rule', () => {
    expect(canonicalRule('', tuesdayEvening)).toBe('')
    expect(canonicalRule('COUNT=3', tuesdayEvening)).toBe('')
    expect(canonicalRule(';;=;FREQ', tuesdayEvening)).toBe('')
  })

  it('gives one answer for a rule and for its own canonical form', () => {
    for (const rule of [
      'FREQ=WEEKLY;BYDAY=TU',
      'BYDAY=FR,MO;FREQ=WEEKLY;COUNT=4',
      'FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=6',
    ]) {
      const once = canonicalRule(rule, tuesdayEvening)
      expect(canonicalRule(once, tuesdayEvening)).toBe(once)
    }
  })
})

describe('the simple repeat rule and the canonical one', () => {
  it.each([
    ['FREQ=DAILY', { freq: 'daily' }],
    ['FREQ=WEEKLY;INTERVAL=2', { freq: 'weekly', interval: 2 }],
    ['FREQ=MONTHLY', { freq: 'monthly' }],
    ['FREQ=YEARLY;INTERVAL=4', { freq: 'yearly', interval: 4 }],
  ] as const)('reads %j as %j, and writes it back', (canonical, simple) => {
    expect(simpleRecurrenceOf(canonical)).toEqual(simple)
    expect(ruleOfSimpleRecurrence(simple)).toBe(canonical)
  })

  it.each([
    'FREQ=WEEKLY;COUNT=10',
    'FREQ=WEEKLY;UNTIL=20260630',
    'FREQ=WEEKLY;BYDAY=WE',
    'FREQ=HOURLY',
    'FREQ=WEEKLY;INTERVAL=0',
    'FREQ=WEEKLY;INTERVAL=1.5',
    '',
  ])('does not read %j as a simple rule', (canonical) => {
    expect(simpleRecurrenceOf(canonical)).toBeUndefined()
  })

  it('writes an interval of one, or less, or a fraction, as no interval', () => {
    expect(ruleOfSimpleRecurrence({ freq: 'weekly', interval: 1 })).toBe('FREQ=WEEKLY')
    expect(ruleOfSimpleRecurrence({ freq: 'weekly', interval: 0 })).toBe('FREQ=WEEKLY')
    expect(ruleOfSimpleRecurrence({ freq: 'weekly', interval: 2.9 })).toBe('FREQ=WEEKLY;INTERVAL=2')
  })
})

describe('parseRule and weekdayIndex', () => {
  it('splits a rule into upper-case parts', () => {
    expect(parseRule('freq=Weekly; byday = mo,we ;;junk')).toEqual({ FREQ: 'WEEKLY', BYDAY: 'MO,WE' })
  })

  it('numbers Monday 0 through Sunday 6, for a date or a wall time', () => {
    expect(weekdayIndex('2026-01-05')).toBe(0)
    expect(weekdayIndex('2026-01-06T18:00:00')).toBe(1)
    expect(weekdayIndex('2026-01-11')).toBe(6)
    expect(weekdayIndex('2024-02-29')).toBe(3)
  })
})

describe('text limits', () => {
  it('leaves a text within the limit alone', () => {
    expect(clipText('short', 10)).toBe('short')
    expect(clipText('x'.repeat(10), 10)).toBe('x'.repeat(10))
  })

  it('cuts by characters, never through the middle of one', () => {
    expect(clipText('ab😀cd', 3)).toBe('ab😀')
    expect(clipText('😀😀😀', 2)).toBe('😀😀')
    // Three characters in six code units: within a limit of three although longer than it counted naively.
    expect(clipText('😀😀😀', 3)).toBe('😀😀😀')
  })

  it('leaves three texts within their limits as they are, with no digest', () => {
    const within = {
      title: 't'.repeat(TEXT_LIMITS.title),
      description: 'd'.repeat(TEXT_LIMITS.description),
      location: 'l'.repeat(TEXT_LIMITS.location),
    }
    expect(clipTexts(within)).toEqual({ ...within, clipped: '' })
  })

  it.each(['title', 'description', 'location'] as const)('cuts a %s that is too long, and says so', (field) => {
    const within = { title: 'T', description: 'D', location: 'L' }
    const long = { ...within, [field]: 'x'.repeat(TEXT_LIMITS[field] + 1) }
    const clipped = clipTexts(long)
    expect(clipped[field]).toBe('x'.repeat(TEXT_LIMITS[field]))
    expect(clipped.clipped).toMatch(/^[A-Za-z0-9_-]{16}$/)
  })

  it('gives texts that differ only in the part that was cut different digests', () => {
    const head = 'x'.repeat(TEXT_LIMITS.description)
    const one = clipTexts({ title: 'T', location: 'L', description: `${head} first ending` })
    const other = clipTexts({ title: 'T', location: 'L', description: `${head} second ending` })
    expect(one.description).toBe(other.description)
    expect(one.clipped).not.toBe(other.clipped)
    // The digest covers all three texts in full, so the same cut text under another title is another digest.
    expect(clipTexts({ title: 'U', location: 'L', description: `${head} first ending` }).clipped).not.toBe(one.clipped)
  })

  it('makes a short digest that is the start of the SHA-256', () => {
    // SHA-256("abc") begins ba7816bf 8f01cfea 414140de.
    expect(shortDigest('abc')).toBe('ungWv48Bz-pBQUDe')
  })
})

describe('fingerprintOfEvent', () => {
  const base: EventModel = {
    uid: 'uid-1',
    title: 'Stand-up',
    description: 'Daily sync',
    location: 'Room 4',
    clipped: '',
    status: 'confirmed',
    start: zoned('2026-03-23T09:00:00'),
    end: zoned('2026-03-23T09:30:00'),
    rule: 'FREQ=WEEKLY;UNTIL=20260430T215959Z;BYDAY=MO,WE',
    exdates: ['2026-04-01T09:00:00', '2026-04-08T09:00:00'],
    rdates: ['2026-05-04T09:00:00'],
    overrides: [
      {
        recurrenceId: '2026-03-30T09:00:00',
        title: 'Stand-up (moved)',
        description: '',
        location: '',
        clipped: '',
        status: '',
        start: zoned('2026-03-30T11:00:00'),
        end: zoned('2026-03-30T11:30:00'),
      },
      {
        recurrenceId: '2026-04-06T09:00:00',
        title: 'Stand-up',
        description: '',
        location: '',
        clipped: '',
        status: 'cancelled',
        start: zoned('2026-04-06T09:00:00'),
      },
    ],
    guests: true,
    alarm: false,
  }

  it('is 22 characters of URL-safe base64', () => {
    expect(fingerprintOfEvent(base)).toMatch(/^[A-Za-z0-9_-]{22}$/)
  })

  it('is taken of exactly this, and has the value it had when this was written', () => {
    // A change here changes every fingerprint ever stored. That is survivable (both sides of every
    // entry move together) but it must be a decision: raise EVENT_MODEL_VERSION when it is one.
    const canonical = [
      1,
      ...['Stand-up', 'Daily sync', 'Room 4', '', 'confirmed'],
      ...['zoned', '2026-03-23T09:00:00', 'Europe/Berlin'],
      ...['zoned', '2026-03-23T09:30:00', 'Europe/Berlin'],
      'FREQ=WEEKLY;UNTIL=20260430T215959Z;BYDAY=MO,WE',
      ['2026-04-01T09:00:00', '2026-04-08T09:00:00'],
      ['2026-05-04T09:00:00'],
      [
        [
          '2026-03-30T09:00:00',
          ...['Stand-up (moved)', '', '', '', ''],
          ...['zoned', '2026-03-30T11:00:00', 'Europe/Berlin'],
          ...['zoned', '2026-03-30T11:30:00', 'Europe/Berlin'],
        ],
        [
          '2026-04-06T09:00:00',
          ...['Stand-up', '', '', '', 'cancelled'],
          ...['zoned', '2026-04-06T09:00:00', 'Europe/Berlin'],
          ...['', '', ''],
        ],
      ],
      true,
      false,
    ]
    expect(EVENT_MODEL_VERSION).toBe(1)
    expect(canonicalEvent(base)).toEqual(canonical)
    const digest = createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest()
    expect(fingerprintOfEvent(base)).toBe(digest.subarray(0, 16).toString('base64url'))
    expect(fingerprintOfEvent(base)).toBe('rzZWEjyjHE5rHxCjLw2ulw')
  })

  it('does not depend on who the entry is, only on what it says', () => {
    expect(fingerprintOfEvent({ ...base, uid: 'another-uid' })).toBe(fingerprintOfEvent(base))
  })

  it('does not depend on the order removed, added or changed occurrences are listed in', () => {
    const reordered: EventModel = {
      ...base,
      exdates: [...base.exdates].reverse(),
      overrides: [...base.overrides].reverse(),
    }
    expect(fingerprintOfEvent(reordered)).toBe(fingerprintOfEvent(base))
  })

  const changes: [what: string, changed: EventModel][] = [
    ['the title', { ...base, title: 'Stand-up!' }],
    ['the description', { ...base, description: 'Weekly sync' }],
    ['the place', { ...base, location: 'Room 5' }],
    ['the digest of a text that was cut', { ...base, clipped: 'ungWv48Bz-pBQUDe' }],
    ['the status', { ...base, status: 'tentative' }],
    ['the start time', { ...base, start: zoned('2026-03-23T09:15:00') }],
    ['the zone, with the same wall time', { ...base, start: zoned('2026-03-23T09:00:00', 'Europe/Lisbon') }],
    [
      'the kind of time, with the same wall time',
      { ...base, start: { kind: 'floating', value: '2026-03-23T09:00:00' } },
    ],
    ['the end', { ...base, end: zoned('2026-03-23T10:00:00') }],
    ['having an end at all', { ...base, end: undefined }],
    ['the repeat rule', { ...base, rule: 'FREQ=WEEKLY;UNTIL=20260430T215959Z;BYDAY=MO' }],
    ['a removed occurrence', { ...base, exdates: ['2026-04-01T09:00:00'] }],
    ['an added occurrence', { ...base, rdates: [] }],
    [
      'a changed occurrence’s title',
      { ...base, overrides: [{ ...base.overrides[0], title: 'Moved' }, base.overrides[1]] },
    ],
    [
      'which occurrence was changed',
      { ...base, overrides: [{ ...base.overrides[0], recurrenceId: '2026-03-25T09:00:00' }, base.overrides[1]] },
    ],
    [
      'a changed occurrence no longer being cancelled',
      { ...base, overrides: [base.overrides[0], { ...base.overrides[1], status: '' }] },
    ],
    ['one changed occurrence fewer', { ...base, overrides: [base.overrides[0]] }],
    ['having guests', { ...base, guests: false }],
    ['having a reminder', { ...base, alarm: true }],
  ]

  it.each(changes)('changes with %s', (_what, changed) => {
    expect(fingerprintOfEvent(changed)).not.toBe(fingerprintOfEvent(base))
  })

  it('gives every one of those changes a fingerprint of its own', () => {
    const all = new Set([base, ...changes.map(([, changed]) => changed)].map(fingerprintOfEvent))
    expect(all.size).toBe(changes.length + 1)
  })

  it('tells apart two long descriptions that differ only after the part the note keeps', () => {
    const head = 'x'.repeat(TEXT_LIMITS.description)
    const withEnding = (ending: string): EventModel => ({
      ...base,
      ...clipTexts({ title: base.title, location: base.location, description: `${head} ${ending}` }),
    })
    expect(fingerprintOfEvent(withEnding('first ending'))).not.toBe(fingerprintOfEvent(withEnding('second ending')))
    // …while the model, and so the note, holds only the part that is kept.
    expect(JSON.stringify(canonicalEvent(withEnding('first ending')))).not.toContain('first ending')
  })
})
