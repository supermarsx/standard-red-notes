/**
 * Standard Red Notes: calendar entries as other software writes them.
 *
 * WHERE THESE COME FROM, STATED PLAINLY. They were written by hand, each in the
 * dialect of the product named: its PRODID, the properties and parameters it
 * emits, the order it emits them in, its vendor `X-` properties and the way it
 * spells a time zone. They were NOT exported from live Google, Apple, Exchange
 * or Fastmail accounts, which nothing here has access to. Entries taken from a
 * real account belong in this list as they are found; each needs only the text
 * and the model it must produce.
 *
 * Every entry says what it is here to exercise (`contains`), and the spec first
 * checks that the text really contains it, so that an entry cannot quietly stop
 * testing what its name claims.
 *
 * A time is written `kind value [zone]`, for example
 * `zoned 2026-03-23T09:00:00 Europe/Berlin`, `utc 2026-01-15T14:00:00`,
 * `floating 2026-07-04T10:00:00` or `date 2026-06-10`.
 */

export type ExpectedOverride = {
  /** The occurrence it replaces, in the terms of the series' own start. */
  recurrenceId: string
  title: string
  start: string
  end?: string
  status?: 'tentative' | 'confirmed' | 'cancelled'
}

export type ExpectedModel = {
  uid: string
  title: string
  start: string
  end?: string
  description?: string
  location?: string
  status?: 'tentative' | 'confirmed' | 'cancelled'
  rule?: string
  exdates?: string[]
  rdates?: string[]
  overrides?: ExpectedOverride[]
  guests?: boolean
  alarm?: boolean
  /** Names of zones whose embedded definition the entry depends on, because the platform does not know them. */
  zoneDefinitions?: string[]
}

export type CorpusEntry = {
  name: string
  /** The product whose way of writing calendar data this entry follows. */
  dialect: string
  /** Text the entry must contain: what it is here to exercise. */
  contains: string[]
  /** The calendar object, one physical line per element (a line starting with a space continues the one before). */
  lines: string[]
  model: ExpectedModel
}

const vtimezone = (tzid: string, daylight: string[], standard: string[], extra: string[] = []): string[] => [
  'BEGIN:VTIMEZONE',
  `TZID:${tzid}`,
  ...extra,
  'BEGIN:DAYLIGHT',
  ...daylight,
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  ...standard,
  'END:STANDARD',
  'END:VTIMEZONE',
]

const EUROPE_BERLIN = vtimezone(
  'Europe/Berlin',
  [
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0200',
    'TZNAME:CEST',
    'DTSTART:19700329T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  ],
  [
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0100',
    'TZNAME:CET',
    'DTSTART:19701025T030000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  ],
)

const EUROPE_LONDON = vtimezone(
  'Europe/London',
  [
    'TZOFFSETFROM:+0000',
    'TZOFFSETTO:+0100',
    'TZNAME:BST',
    'DTSTART:19700329T010000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  ],
  [
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0000',
    'TZNAME:GMT',
    'DTSTART:19701025T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  ],
  ['X-LIC-LOCATION:Europe/London'],
)

const AMERICA_LOS_ANGELES = vtimezone(
  'America/Los_Angeles',
  [
    'TZOFFSETFROM:-0800',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
    'DTSTART:20070311T020000',
    'TZNAME:PDT',
    'TZOFFSETTO:-0700',
  ],
  [
    'TZOFFSETFROM:-0700',
    'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
    'DTSTART:20071104T020000',
    'TZNAME:PST',
    'TZOFFSETTO:-0800',
  ],
)

/** As Exchange writes a zone: a Windows name, standard time first, rules dated 1601. */
const windowsZone = (
  tzid: string,
  standardOffset: string,
  daylightOffset: string,
  toStandard: string,
  toDaylight: string,
): string[] => [
  'BEGIN:VTIMEZONE',
  `TZID:${tzid}`,
  'BEGIN:STANDARD',
  'DTSTART:16010101T030000',
  `TZOFFSETFROM:${daylightOffset}`,
  `TZOFFSETTO:${standardOffset}`,
  `RRULE:${toStandard}`,
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:16010101T020000',
  `TZOFFSETFROM:${standardOffset}`,
  `TZOFFSETTO:${daylightOffset}`,
  `RRULE:${toDaylight}`,
  'END:DAYLIGHT',
  'END:VTIMEZONE',
]

const EUROPEAN_RULES = [
  'FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10',
  'FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3',
] as const

const nextcloud = (...body: string[][]): string[] => [
  'BEGIN:VCALENDAR',
  'CALSCALE:GREGORIAN',
  'VERSION:2.0',
  'PRODID:-//IDN nextcloud.com//Calendar app 5.0.9//EN',
  ...body.flat(),
  'END:VCALENDAR',
]

const thunderbird = (...body: string[][]): string[] => [
  'BEGIN:VCALENDAR',
  'PRODID:-//Mozilla.org/NONSGML Mozilla Calendar V1.1//EN',
  'VERSION:2.0',
  ...body.flat(),
  'END:VCALENDAR',
]

const apple = (...body: string[][]): string[] => [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Apple Inc.//macOS 14.5//EN',
  'CALSCALE:GREGORIAN',
  ...body.flat(),
  'END:VCALENDAR',
]

const google = (...body: string[][]): string[] => [
  'BEGIN:VCALENDAR',
  'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
  'VERSION:2.0',
  'CALSCALE:GREGORIAN',
  'METHOD:PUBLISH',
  'X-WR-CALNAME:Work',
  'X-WR-TIMEZONE:Europe/London',
  ...body.flat(),
  'END:VCALENDAR',
]

const exchange = (...body: string[][]): string[] => [
  'BEGIN:VCALENDAR',
  'METHOD:REQUEST',
  'PRODID:Microsoft Exchange Server 2010',
  'VERSION:2.0',
  ...body.flat(),
  'END:VCALENDAR',
]

const plain = (prodid: string, ...body: string[][]): string[] => [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  `PRODID:${prodid}`,
  ...body.flat(),
  'END:VCALENDAR',
]

const vevent = (...lines: string[]): string[] => ['BEGIN:VEVENT', ...lines, 'END:VEVENT']

export const CORPUS: CorpusEntry[] = [
  // ------------------------------------------------------------------ Nextcloud
  {
    name: 'nextcloud: a weekly meeting with a reminder',
    dialect: 'Nextcloud Calendar app',
    contains: [
      'PRODID:-//IDN nextcloud.com//Calendar app',
      'RRULE:FREQ=WEEKLY;BYDAY=MO,WE',
      'BEGIN:VALARM',
      'COLOR:khaki',
    ],
    lines: nextcloud(
      vevent(
        'CREATED:20260301T101500Z',
        'DTSTAMP:20260301T101623Z',
        'LAST-MODIFIED:20260301T101623Z',
        'SEQUENCE:2',
        'UID:6f6f0c56-0b0e-4b3c-9a52-0f6a3f6d3f11',
        'DTSTART;TZID=Europe/Berlin:20260323T090000',
        'DTEND;TZID=Europe/Berlin:20260323T093000',
        'STATUS:CONFIRMED',
        'SUMMARY:Stand-up',
        'RRULE:FREQ=WEEKLY;BYDAY=MO,WE',
        'COLOR:khaki',
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        'TRIGGER;RELATED=START:-PT15M',
        'END:VALARM',
      ),
      EUROPE_BERLIN,
    ),
    model: {
      uid: '6f6f0c56-0b0e-4b3c-9a52-0f6a3f6d3f11',
      title: 'Stand-up',
      start: 'zoned 2026-03-23T09:00:00 Europe/Berlin',
      end: 'zoned 2026-03-23T09:30:00 Europe/Berlin',
      status: 'confirmed',
      rule: 'FREQ=WEEKLY;BYDAY=MO,WE',
      alarm: true,
    },
  },
  {
    name: 'nextcloud: an all-day event of three days',
    dialect: 'Nextcloud Calendar app',
    contains: ['DTSTART;VALUE=DATE:20260610', 'DTEND;VALUE=DATE:20260613'],
    lines: nextcloud(
      vevent(
        'CREATED:20260520T080000Z',
        'DTSTAMP:20260520T080010Z',
        'LAST-MODIFIED:20260520T080010Z',
        'SEQUENCE:1',
        'UID:0b1e3c5a-7d9f-4a2b-8c6d-1e3f5a7b9c0d',
        'DTSTART;VALUE=DATE:20260610',
        'DTEND;VALUE=DATE:20260613',
        'STATUS:CONFIRMED',
        'SUMMARY:Conference',
        'LOCATION:Porto',
      ),
    ),
    model: {
      uid: '0b1e3c5a-7d9f-4a2b-8c6d-1e3f5a7b9c0d',
      title: 'Conference',
      start: 'date 2026-06-10',
      end: 'date 2026-06-13',
      location: 'Porto',
      status: 'confirmed',
    },
  },
  {
    name: 'nextcloud: an all-day event of one day, with text beyond ASCII',
    dialect: 'Nextcloud Calendar app',
    contains: ['DTEND;VALUE=DATE:20260215', '💝', '„Zur Sonne“'],
    lines: nextcloud(
      vevent(
        'CREATED:20260201T080000Z',
        'DTSTAMP:20260201T080010Z',
        'LAST-MODIFIED:20260201T080010Z',
        'SEQUENCE:1',
        'UID:2c4e6a8c-0e2a-4c6e-8a0c-2e4a6c8e0a2c',
        'DTSTART;VALUE=DATE:20260214',
        'DTEND;VALUE=DATE:20260215',
        'SUMMARY:Valentinstag 💝 – Café „Zur Sonne“',
      ),
    ),
    model: {
      uid: '2c4e6a8c-0e2a-4c6e-8a0c-2e4a6c8e0a2c',
      title: 'Valentinstag 💝 – Café „Zur Sonne“',
      start: 'date 2026-02-14',
    },
  },
  {
    name: 'nextcloud: a series with one occurrence moved, one cancelled and one removed',
    dialect: 'Nextcloud Calendar app',
    contains: [
      'RECURRENCE-ID;TZID=Europe/Berlin:20260406T140000',
      'STATUS:CANCELLED',
      'EXDATE;TZID=Europe/Berlin:20260420T140000',
    ],
    lines: nextcloud(
      vevent(
        'CREATED:20260320T090000Z',
        'DTSTAMP:20260402T110000Z',
        'LAST-MODIFIED:20260402T110000Z',
        'SEQUENCE:4',
        'UID:3d5f7b9d-1f3b-4d5f-9b1d-3f5b7d9f1b3d',
        'DTSTART;TZID=Europe/Berlin:20260330T140000',
        'DTEND;TZID=Europe/Berlin:20260330T150000',
        'STATUS:CONFIRMED',
        'SUMMARY:Project review',
        'RRULE:FREQ=WEEKLY;COUNT=6',
        'EXDATE;TZID=Europe/Berlin:20260420T140000',
      ),
      vevent(
        'CREATED:20260320T090000Z',
        'DTSTAMP:20260402T110000Z',
        'LAST-MODIFIED:20260402T110000Z',
        'SEQUENCE:5',
        'UID:3d5f7b9d-1f3b-4d5f-9b1d-3f5b7d9f1b3d',
        'DTSTART;TZID=Europe/Berlin:20260407T100000',
        'DTEND;TZID=Europe/Berlin:20260407T110000',
        'STATUS:CONFIRMED',
        'SUMMARY:Project review (moved to Tuesday)',
        'RECURRENCE-ID;TZID=Europe/Berlin:20260406T140000',
      ),
      vevent(
        'CREATED:20260320T090000Z',
        'DTSTAMP:20260402T110500Z',
        'LAST-MODIFIED:20260402T110500Z',
        'SEQUENCE:5',
        'UID:3d5f7b9d-1f3b-4d5f-9b1d-3f5b7d9f1b3d',
        'DTSTART;TZID=Europe/Berlin:20260413T140000',
        'DTEND;TZID=Europe/Berlin:20260413T150000',
        'STATUS:CANCELLED',
        'SUMMARY:Project review',
        'RECURRENCE-ID;TZID=Europe/Berlin:20260413T140000',
      ),
      EUROPE_BERLIN,
    ),
    model: {
      uid: '3d5f7b9d-1f3b-4d5f-9b1d-3f5b7d9f1b3d',
      title: 'Project review',
      start: 'zoned 2026-03-30T14:00:00 Europe/Berlin',
      end: 'zoned 2026-03-30T15:00:00 Europe/Berlin',
      status: 'confirmed',
      rule: 'FREQ=WEEKLY;COUNT=6',
      exdates: ['2026-04-20T14:00:00'],
      overrides: [
        {
          recurrenceId: '2026-04-06T14:00:00',
          title: 'Project review (moved to Tuesday)',
          start: 'zoned 2026-04-07T10:00:00 Europe/Berlin',
          end: 'zoned 2026-04-07T11:00:00 Europe/Berlin',
          status: 'confirmed',
        },
        {
          recurrenceId: '2026-04-13T14:00:00',
          title: 'Project review',
          start: 'zoned 2026-04-13T14:00:00 Europe/Berlin',
          end: 'zoned 2026-04-13T15:00:00 Europe/Berlin',
          status: 'cancelled',
        },
      ],
    },
  },
  {
    name: 'nextcloud: a meeting with two guests',
    dialect: 'Nextcloud Calendar app',
    contains: ['ORGANIZER;CN=Alice', 'ATTENDEE;CN=Bob', 'ATTENDEE;CN=Carla'],
    lines: nextcloud(
      vevent(
        'CREATED:20260501T090000Z',
        'DTSTAMP:20260501T090500Z',
        'LAST-MODIFIED:20260501T090500Z',
        'SEQUENCE:2',
        'UID:4e6a8c0e-2a4c-4e6a-8c0e-4a6c8e0a2c4e',
        'DTSTART;TZID=Europe/Berlin:20260512T110000',
        'DTEND;TZID=Europe/Berlin:20260512T120000',
        'STATUS:CONFIRMED',
        'SUMMARY:Kick-off',
        'ORGANIZER;CN=Alice:mailto:alice@example.org',
        'ATTENDEE;CN=Bob;CUTYPE=INDIVIDUAL;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT;RSVP=TRUE;LANGUAGE=en:mailto:bob@example.org',
        'ATTENDEE;CN=Carla;CUTYPE=INDIVIDUAL;PARTSTAT=ACCEPTED;ROLE=OPT-PARTICIPANT;RSVP=TRUE;LANGUAGE=pt:mailto:carla@example.org',
      ),
      EUROPE_BERLIN,
    ),
    model: {
      uid: '4e6a8c0e-2a4c-4e6a-8c0e-4a6c8e0a2c4e',
      title: 'Kick-off',
      start: 'zoned 2026-05-12T11:00:00 Europe/Berlin',
      end: 'zoned 2026-05-12T12:00:00 Europe/Berlin',
      status: 'confirmed',
      guests: true,
    },
  },
  {
    name: 'nextcloud: a description folded over several lines, with every kind of escape',
    dialect: 'Nextcloud Calendar app',
    contains: ['DESCRIPTION:Agenda:\\n1. Budget\\, phase two\\n2. Hiring\\; two roles\\n3. A ', ' backslash \\\\ and'],
    lines: nextcloud(
      vevent(
        'CREATED:20260601T090000Z',
        'DTSTAMP:20260601T090500Z',
        'LAST-MODIFIED:20260601T090500Z',
        'SEQUENCE:1',
        'UID:5f7b9d1f-3b5d-4f7b-9d1f-5b7d9f1b3d5f',
        'DTSTART;TZID=Europe/Berlin:20260615T160000',
        'DTEND;TZID=Europe/Berlin:20260615T170000',
        'SUMMARY:Planning',
        'DESCRIPTION:Agenda:\\n1. Budget\\, phase two\\n2. Hiring\\; two roles\\n3. A ',
        ' backslash \\\\ and a line that is long enough that the software which wrote ',
        ' it had to continue it on a third line of the file',
      ),
      EUROPE_BERLIN,
    ),
    model: {
      uid: '5f7b9d1f-3b5d-4f7b-9d1f-5b7d9f1b3d5f',
      title: 'Planning',
      start: 'zoned 2026-06-15T16:00:00 Europe/Berlin',
      end: 'zoned 2026-06-15T17:00:00 Europe/Berlin',
      description:
        'Agenda:\n1. Budget, phase two\n2. Hiring; two roles\n3. A backslash \\ and a line that is long enough that the software which wrote it had to continue it on a third line of the file',
    },
  },

  // ---------------------------------------------------------------- Thunderbird
  {
    name: 'thunderbird: an appointment with a place and a reminder',
    dialect: 'Thunderbird',
    contains: [
      'PRODID:-//Mozilla.org/NONSGML Mozilla Calendar V1.1//EN',
      'X-MOZ-GENERATION:2',
      'DESCRIPTION:Default Mozilla Description',
    ],
    lines: thunderbird(
      vtimezone(
        'Europe/Lisbon',
        [
          'TZOFFSETFROM:+0000',
          'TZOFFSETTO:+0100',
          'TZNAME:WEST',
          'DTSTART:19700329T010000',
          'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3',
        ],
        [
          'TZOFFSETFROM:+0100',
          'TZOFFSETTO:+0000',
          'TZNAME:WET',
          'DTSTART:19701025T020000',
          'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10',
        ],
        ['X-TZINFO:Europe/Lisbon[2025b]'],
      ),
      vevent(
        'CREATED:20260110T120000Z',
        'LAST-MODIFIED:20260110T120500Z',
        'DTSTAMP:20260110T120500Z',
        'UID:1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed',
        'SUMMARY:Dentist',
        'DTSTART;TZID=Europe/Lisbon:20260115T143000',
        'DTEND;TZID=Europe/Lisbon:20260115T151500',
        'TRANSP:OPAQUE',
        'X-MOZ-GENERATION:2',
        'LOCATION:Rua Augusta 12\\, Lisboa',
        'DESCRIPTION:Bring the X-rays',
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        'TRIGGER:-PT30M',
        'DESCRIPTION:Default Mozilla Description',
        'END:VALARM',
      ),
    ),
    model: {
      uid: '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed',
      title: 'Dentist',
      start: 'zoned 2026-01-15T14:30:00 Europe/Lisbon',
      end: 'zoned 2026-01-15T15:15:00 Europe/Lisbon',
      description: 'Bring the X-rays',
      location: 'Rua Augusta 12, Lisboa',
      alarm: true,
    },
  },
  {
    name: 'thunderbird: a zone named the way old versions named it',
    dialect: 'Thunderbird (before 2011)',
    contains: ['TZID=/mozilla.org/20050126_1/Europe/Berlin'],
    lines: thunderbird(
      vevent(
        'CREATED:20100301T120000Z',
        'LAST-MODIFIED:20100301T120500Z',
        'DTSTAMP:20100301T120500Z',
        'UID:uuid:1267444800123',
        'SUMMARY:Jahrestag',
        'DTSTART;TZID=/mozilla.org/20050126_1/Europe/Berlin:20100315T190000',
        'DTEND;TZID=/mozilla.org/20050126_1/Europe/Berlin:20100315T220000',
        'RRULE:FREQ=YEARLY',
      ),
    ),
    model: {
      uid: 'uuid:1267444800123',
      title: 'Jahrestag',
      start: 'zoned 2010-03-15T19:00:00 Europe/Berlin',
      end: 'zoned 2010-03-15T22:00:00 Europe/Berlin',
      rule: 'FREQ=YEARLY',
    },
  },
  {
    name: 'thunderbird: a time tied to no zone',
    dialect: 'Thunderbird',
    contains: ['DTSTART:20260704T100000', 'DTEND:20260704T113000'],
    lines: thunderbird(
      vevent(
        'CREATED:20260620T120000Z',
        'LAST-MODIFIED:20260620T120500Z',
        'DTSTAMP:20260620T120500Z',
        'UID:7c9e6679-7425-40de-944b-e07fc1f90ae7',
        'SUMMARY:Morning run',
        'DTSTART:20260704T100000',
        'DTEND:20260704T113000',
      ),
    ),
    model: {
      uid: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      title: 'Morning run',
      start: 'floating 2026-07-04T10:00:00',
      end: 'floating 2026-07-04T11:30:00',
    },
  },
  {
    name: 'thunderbird: the last Friday of every month',
    dialect: 'Thunderbird',
    contains: ['RRULE:FREQ=MONTHLY;BYDAY=-1FR'],
    lines: thunderbird(
      EUROPE_BERLIN,
      vevent(
        'CREATED:20260120T120000Z',
        'LAST-MODIFIED:20260120T120500Z',
        'DTSTAMP:20260120T120500Z',
        'UID:9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f',
        'SUMMARY:Monthly review',
        'RRULE:FREQ=MONTHLY;BYDAY=-1FR',
        'DTSTART;TZID=Europe/Berlin:20260130T100000',
        'DTEND;TZID=Europe/Berlin:20260130T110000',
      ),
    ),
    model: {
      uid: '9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f',
      title: 'Monthly review',
      start: 'zoned 2026-01-30T10:00:00 Europe/Berlin',
      end: 'zoned 2026-01-30T11:00:00 Europe/Berlin',
      rule: 'FREQ=MONTHLY;BYDAY=-1FR',
    },
  },

  // ---------------------------------------------------------------------- Apple
  {
    name: 'apple: a meeting with a place on a map and a sound',
    dialect: 'Apple Calendar (macOS)',
    contains: [
      'X-APPLE-STRUCTURED-LOCATION;VALUE=URI',
      'ACTION:AUDIO',
      'ATTACH;VALUE=URI:Chord',
      'LOCATION:Apple Park\\nCupertino\\, CA',
    ],
    lines: apple(
      AMERICA_LOS_ANGELES,
      vevent(
        'CREATED:20260201T180000Z',
        'UID:4A8B5F3E-7C1D-4E2A-9B6F-0D3C2E1F4A5B',
        'DTEND;TZID=America/Los_Angeles:20260210T110000',
        'TRANSP:OPAQUE',
        'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC',
        'SUMMARY:Design review',
        'LAST-MODIFIED:20260201T180500Z',
        'DTSTAMP:20260201T180500Z',
        'DTSTART;TZID=America/Los_Angeles:20260210T100000',
        'SEQUENCE:1',
        'X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-APPLE-RADIUS=70;X-TITLE="Apple Park":geo:37.334900,-122.009020',
        'LOCATION:Apple Park\\nCupertino\\, CA',
        'BEGIN:VALARM',
        'X-WR-ALARMUID:9C1D2E3F-4A5B-4C6D-8E7F-0A1B2C3D4E5F',
        'UID:9C1D2E3F-4A5B-4C6D-8E7F-0A1B2C3D4E5F',
        'TRIGGER:-PT15M',
        'ATTACH;VALUE=URI:Chord',
        'ACTION:AUDIO',
        'END:VALARM',
      ),
    ),
    model: {
      uid: '4A8B5F3E-7C1D-4E2A-9B6F-0D3C2E1F4A5B',
      title: 'Design review',
      start: 'zoned 2026-02-10T10:00:00 America/Los_Angeles',
      end: 'zoned 2026-02-10T11:00:00 America/Los_Angeles',
      location: 'Apple Park\nCupertino, CA',
      alarm: true,
    },
  },
  {
    name: 'apple: an all-day event whose only alarm is the marker for "no alert"',
    dialect: 'Apple Calendar (iOS)',
    contains: ['X-APPLE-DEFAULT-ALARM:TRUE', 'ACTION:NONE', 'TRIGGER;VALUE=DATE-TIME:19760401T005545Z'],
    lines: apple(
      vevent(
        'CREATED:20260301T180000Z',
        'UID:6B7C8D9E-0F1A-4B2C-9D3E-4F5A6B7C8D9E',
        'DTEND;VALUE=DATE:20260322',
        'TRANSP:TRANSPARENT',
        'SUMMARY:Spring cleaning',
        'LAST-MODIFIED:20260301T180500Z',
        'DTSTAMP:20260301T180500Z',
        'DTSTART;VALUE=DATE:20260321',
        'SEQUENCE:0',
        'BEGIN:VALARM',
        'X-WR-ALARMUID:1D2E3F4A-5B6C-4D7E-8F9A-0B1C2D3E4F5A',
        'UID:1D2E3F4A-5B6C-4D7E-8F9A-0B1C2D3E4F5A',
        'TRIGGER;VALUE=DATE-TIME:19760401T005545Z',
        'X-APPLE-DEFAULT-ALARM:TRUE',
        'ACTION:NONE',
        'END:VALARM',
      ),
    ),
    model: {
      uid: '6B7C8D9E-0F1A-4B2C-9D3E-4F5A6B7C8D9E',
      title: 'Spring cleaning',
      start: 'date 2026-03-21',
    },
  },
  {
    name: 'apple: a birthday, every year',
    dialect: 'Apple Calendar (macOS)',
    contains: ['RRULE:FREQ=YEARLY', 'DTSTART;VALUE=DATE:19900817'],
    lines: apple(
      vevent(
        'CREATED:20240101T100000Z',
        'UID:8D9E0F1A-2B3C-4D5E-8F6A-7B8C9D0E1F2A',
        'DTEND;VALUE=DATE:19900818',
        'TRANSP:TRANSPARENT',
        'SUMMARY:Marta’s birthday',
        'LAST-MODIFIED:20240101T100500Z',
        'DTSTAMP:20240101T100500Z',
        'DTSTART;VALUE=DATE:19900817',
        'SEQUENCE:0',
        'RRULE:FREQ=YEARLY',
      ),
    ),
    model: {
      uid: '8D9E0F1A-2B3C-4D5E-8F6A-7B8C9D0E1F2A',
      title: 'Marta’s birthday',
      start: 'date 1990-08-17',
      rule: 'FREQ=YEARLY',
    },
  },
  {
    name: 'apple: a flight that leaves in one zone and lands in another',
    dialect: 'Apple Calendar (macOS)',
    contains: ['DTSTART;TZID=Europe/Lisbon:20260905T103000', 'DTEND;TZID=America/New_York:20260905T132000'],
    lines: apple(
      vevent(
        'CREATED:20260801T180000Z',
        'UID:0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D',
        'DTEND;TZID=America/New_York:20260905T132000',
        'TRANSP:OPAQUE',
        'SUMMARY:TP 201 LIS–EWR',
        'LAST-MODIFIED:20260801T180500Z',
        'DTSTAMP:20260801T180500Z',
        'DTSTART;TZID=Europe/Lisbon:20260905T103000',
        'SEQUENCE:0',
      ),
    ),
    model: {
      uid: '0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D',
      title: 'TP 201 LIS–EWR',
      start: 'zoned 2026-09-05T10:30:00 Europe/Lisbon',
      end: 'zoned 2026-09-05T13:20:00 America/New_York',
    },
  },

  // --------------------------------------------------------------------- Google
  {
    name: 'google: a weekly meeting with an end date, a removed week and a guest',
    dialect: 'Google Calendar (exported)',
    contains: [
      'RRULE:FREQ=WEEKLY;WKST=SU;UNTIL=20260629T225959Z;BYDAY=MO',
      'EXDATE;TZID=Europe/London:20260406T100000',
      'X-NUM-GUESTS=0',
      'X-GOOGLE-CONFERENCE:',
    ],
    lines: google(
      EUROPE_LONDON,
      vevent(
        'DTSTART;TZID=Europe/London:20260112T100000',
        'DTEND;TZID=Europe/London:20260112T110000',
        'RRULE:FREQ=WEEKLY;WKST=SU;UNTIL=20260629T225959Z;BYDAY=MO',
        'EXDATE;TZID=Europe/London:20260406T100000',
        'DTSTAMP:20261001T120000Z',
        'ORGANIZER;CN=Work:mailto:c_0123456789abcdef@group.calendar.google.com',
        'UID:5k3j2h1g0f9e8d7c6b5a4@google.com',
        'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Ana;X-NUM-GUESTS=0:mailto:ana@example.com',
        'X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij',
        'CREATED:20260105T090000Z',
        'DESCRIPTION:Weekly sync<br>Agenda: <a href="https://example.com/doc">doc</a>',
        'LAST-MODIFIED:20260410T080000Z',
        'LOCATION:',
        'SEQUENCE:3',
        'STATUS:CONFIRMED',
        'SUMMARY:Team sync',
        'TRANSP:OPAQUE',
      ),
    ),
    model: {
      uid: '5k3j2h1g0f9e8d7c6b5a4@google.com',
      title: 'Team sync',
      start: 'zoned 2026-01-12T10:00:00 Europe/London',
      end: 'zoned 2026-01-12T11:00:00 Europe/London',
      description: 'Weekly sync<br>Agenda: <a href="https://example.com/doc">doc</a>',
      status: 'confirmed',
      rule: 'FREQ=WEEKLY;UNTIL=20260629T225959Z;BYDAY=MO;WKST=SU',
      exdates: ['2026-04-06T10:00:00'],
      guests: true,
    },
  },
  {
    name: 'google: a single event, stated in UTC',
    dialect: 'Google Calendar (exported)',
    contains: ['DTSTART:20260115T140000Z', 'DTEND:20260115T150000Z'],
    lines: google(
      vevent(
        'DTSTART:20260115T140000Z',
        'DTEND:20260115T150000Z',
        'DTSTAMP:20261001T120000Z',
        'UID:0a1b2c3d4e5f6g7h8i9j0k1l2m@google.com',
        'CREATED:20260110T090000Z',
        'LAST-MODIFIED:20260110T090000Z',
        'SEQUENCE:0',
        'STATUS:CONFIRMED',
        'SUMMARY:Call with supplier',
        'TRANSP:OPAQUE',
      ),
    ),
    model: {
      uid: '0a1b2c3d4e5f6g7h8i9j0k1l2m@google.com',
      title: 'Call with supplier',
      start: 'utc 2026-01-15T14:00:00',
      end: 'utc 2026-01-15T15:00:00',
      status: 'confirmed',
    },
  },
  {
    name: 'google: an all-day event',
    dialect: 'Google Calendar (exported)',
    contains: ['DTSTART;VALUE=DATE:20261225', 'DTEND;VALUE=DATE:20261227', 'TRANSP:TRANSPARENT'],
    lines: google(
      vevent(
        'DTSTART;VALUE=DATE:20261225',
        'DTEND;VALUE=DATE:20261227',
        'DTSTAMP:20261001T120000Z',
        'UID:1b2c3d4e5f6g7h8i9j0k1l2m3n@google.com',
        'CREATED:20260110T090000Z',
        'LAST-MODIFIED:20260110T090000Z',
        'SEQUENCE:0',
        'STATUS:CONFIRMED',
        'SUMMARY:Christmas',
        'TRANSP:TRANSPARENT',
      ),
    ),
    model: {
      uid: '1b2c3d4e5f6g7h8i9j0k1l2m3n@google.com',
      title: 'Christmas',
      start: 'date 2026-12-25',
      end: 'date 2026-12-27',
      status: 'confirmed',
    },
  },
  {
    name: 'google: a series with one occurrence given another time',
    dialect: 'Google Calendar (exported)',
    contains: ['RECURRENCE-ID;TZID=Europe/London:20260309T100000', 'RRULE:FREQ=WEEKLY;BYDAY=MO'],
    lines: google(
      EUROPE_LONDON,
      vevent(
        'DTSTART;TZID=Europe/London:20260302T100000',
        'DTEND;TZID=Europe/London:20260302T103000',
        'RRULE:FREQ=WEEKLY;BYDAY=MO',
        'DTSTAMP:20261001T120000Z',
        'UID:2c3d4e5f6g7h8i9j0k1l2m3n4o@google.com',
        'CREATED:20260220T090000Z',
        'LAST-MODIFIED:20260305T090000Z',
        'SEQUENCE:0',
        'STATUS:CONFIRMED',
        'SUMMARY:One to one',
        'TRANSP:OPAQUE',
      ),
      vevent(
        'DTSTART;TZID=Europe/London:20260309T153000',
        'DTEND;TZID=Europe/London:20260309T160000',
        'DTSTAMP:20261001T120000Z',
        'UID:2c3d4e5f6g7h8i9j0k1l2m3n4o@google.com',
        'RECURRENCE-ID;TZID=Europe/London:20260309T100000',
        'CREATED:20260220T090000Z',
        'LAST-MODIFIED:20260305T090000Z',
        'SEQUENCE:1',
        'STATUS:CONFIRMED',
        'SUMMARY:One to one',
        'TRANSP:OPAQUE',
      ),
    ),
    model: {
      uid: '2c3d4e5f6g7h8i9j0k1l2m3n4o@google.com',
      title: 'One to one',
      start: 'zoned 2026-03-02T10:00:00 Europe/London',
      end: 'zoned 2026-03-02T10:30:00 Europe/London',
      status: 'confirmed',
      // 2 March 2026 is a Monday, so "on Mondays" says nothing the start does not. With an occurrence
      // changed the series is still not one the simple editor can hold, but the rule itself is plain.
      rule: 'FREQ=WEEKLY',
      overrides: [
        {
          recurrenceId: '2026-03-09T10:00:00',
          title: 'One to one',
          start: 'zoned 2026-03-09T15:30:00 Europe/London',
          end: 'zoned 2026-03-09T16:00:00 Europe/London',
          status: 'confirmed',
        },
      ],
    },
  },
  {
    name: 'google: ten days in a row',
    dialect: 'Google Calendar (exported)',
    contains: ['RRULE:FREQ=DAILY;COUNT=10'],
    lines: google(
      vevent(
        'DTSTART:20260504T063000Z',
        'DTEND:20260504T070000Z',
        'RRULE:FREQ=DAILY;COUNT=10',
        'DTSTAMP:20261001T120000Z',
        'UID:3d4e5f6g7h8i9j0k1l2m3n4o5p@google.com',
        'CREATED:20260420T090000Z',
        'LAST-MODIFIED:20260420T090000Z',
        'SEQUENCE:0',
        'STATUS:TENTATIVE',
        'SUMMARY:Physio exercises',
        'TRANSP:OPAQUE',
      ),
    ),
    model: {
      uid: '3d4e5f6g7h8i9j0k1l2m3n4o5p@google.com',
      title: 'Physio exercises',
      start: 'utc 2026-05-04T06:30:00',
      end: 'utc 2026-05-04T07:00:00',
      status: 'tentative',
      rule: 'FREQ=DAILY;COUNT=10',
    },
  },

  // ------------------------------------------------------- Exchange and Outlook
  {
    name: 'exchange: a meeting request in a zone with a Windows name',
    dialect: 'Microsoft Exchange',
    contains: [
      'TZID:W. Europe Standard Time',
      'DTSTART;TZID=W. Europe Standard Time:20260318T140000',
      'SUMMARY;LANGUAGE=en-US:Quarterly review',
      'X-MICROSOFT-CDO-BUSYSTATUS:TENTATIVE',
    ],
    lines: exchange(
      windowsZone('W. Europe Standard Time', '+0100', '+0200', EUROPEAN_RULES[0], EUROPEAN_RULES[1]),
      vevent(
        'ORGANIZER;CN=Carla Dias:mailto:carla@example.com',
        'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Bob:mailto:bob@example.org',
        'DESCRIPTION;LANGUAGE=en-US:Quarterly review\\n\\n________________________________\\nMicrosoft Teams meeting\\n',
        'UID:040000008200E00074C5B7101A82E00800000000B0A3C1E1D2F4DB01000000000000000010000000A1B2C3D4E5F60718293A4B5C6D7E8F90',
        'SUMMARY;LANGUAGE=en-US:Quarterly review',
        'DTSTART;TZID=W. Europe Standard Time:20260318T140000',
        'DTEND;TZID=W. Europe Standard Time:20260318T150000',
        'CLASS:PUBLIC',
        'PRIORITY:5',
        'DTSTAMP:20260301T090000Z',
        'TRANSP:OPAQUE',
        'STATUS:CONFIRMED',
        'SEQUENCE:0',
        'LOCATION;LANGUAGE=en-US:Microsoft Teams Meeting',
        'X-MICROSOFT-CDO-APPT-SEQUENCE:0',
        'X-MICROSOFT-CDO-OWNERAPPTID:2119876543',
        'X-MICROSOFT-CDO-BUSYSTATUS:TENTATIVE',
        'X-MICROSOFT-CDO-INTENDEDSTATUS:BUSY',
        'X-MICROSOFT-CDO-ALLDAYEVENT:FALSE',
        'X-MICROSOFT-CDO-IMPORTANCE:1',
        'X-MICROSOFT-CDO-INSTTYPE:0',
        'X-MICROSOFT-DONOTFORWARDMEETING:FALSE',
        'X-MICROSOFT-DISALLOW-COUNTER:FALSE',
        'BEGIN:VALARM',
        'DESCRIPTION:REMINDER',
        'TRIGGER;RELATED=START:-PT15M',
        'ACTION:DISPLAY',
        'END:VALARM',
      ),
    ),
    model: {
      uid: '040000008200E00074C5B7101A82E00800000000B0A3C1E1D2F4DB01000000000000000010000000A1B2C3D4E5F60718293A4B5C6D7E8F90',
      title: 'Quarterly review',
      // The Windows name is the zone Europe/Berlin; the embedded definition is not needed for it.
      start: 'zoned 2026-03-18T14:00:00 Europe/Berlin',
      end: 'zoned 2026-03-18T15:00:00 Europe/Berlin',
      description: 'Quarterly review\n\n________________________________\nMicrosoft Teams meeting\n',
      location: 'Microsoft Teams Meeting',
      status: 'confirmed',
      guests: true,
      alarm: true,
    },
  },
  {
    name: 'outlook: a zone with a made-up name, known only by its embedded definition',
    dialect: 'Microsoft Outlook',
    contains: ['TZID:Customized Time Zone', 'DTSTART;TZID=Customized Time Zone:20260323T090000'],
    lines: plain(
      '-//Microsoft Corporation//Outlook 16.0 MIMEDIR//EN',
      windowsZone('Customized Time Zone', '+0100', '+0200', EUROPEAN_RULES[0], EUROPEAN_RULES[1]),
      vevent(
        'CLASS:PUBLIC',
        'CREATED:20260310T090000Z',
        'DTEND;TZID=Customized Time Zone:20260323T100000',
        'DTSTAMP:20260310T090000Z',
        'DTSTART;TZID=Customized Time Zone:20260323T090000',
        'LAST-MODIFIED:20260310T090000Z',
        'PRIORITY:5',
        'SEQUENCE:0',
        'SUMMARY;LANGUAGE=en-gb:Site visit',
        'TRANSP:OPAQUE',
        'UID:040000008200E00074C5B7101A82E0080000000010D2A5C4E1F3DB01000000000000000010000000B2C3D4E5F6071829',
        'X-MICROSOFT-CDO-BUSYSTATUS:BUSY',
        'X-MICROSOFT-CDO-IMPORTANCE:1',
      ),
    ),
    model: {
      uid: '040000008200E00074C5B7101A82E0080000000010D2A5C4E1F3DB01000000000000000010000000B2C3D4E5F6071829',
      title: 'Site visit',
      start: 'zoned 2026-03-23T09:00:00 Customized Time Zone',
      end: 'zoned 2026-03-23T10:00:00 Customized Time Zone',
      zoneDefinitions: ['Customized Time Zone'],
    },
  },
  {
    name: 'exchange: the second Tuesday of every month, in a North American zone',
    dialect: 'Microsoft Exchange',
    contains: ['RRULE:FREQ=MONTHLY;INTERVAL=1;BYDAY=2TU', 'TZID:Eastern Standard Time'],
    lines: exchange(
      windowsZone(
        'Eastern Standard Time',
        '-0500',
        '-0400',
        'FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11',
        'FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3',
      ),
      vevent(
        'ORGANIZER;CN=Dan:mailto:dan@example.com',
        'UID:040000008200E00074C5B7101A82E00800000000C0E4B6D5F2A4DB01000000000000000010000000C3D4E5F607182930',
        'RRULE:FREQ=MONTHLY;INTERVAL=1;BYDAY=2TU',
        'SUMMARY;LANGUAGE=en-US:Board meeting',
        'DTSTART;TZID=Eastern Standard Time:20260113T160000',
        'DTEND;TZID=Eastern Standard Time:20260113T173000',
        'CLASS:PUBLIC',
        'PRIORITY:5',
        'DTSTAMP:20260105T090000Z',
        'TRANSP:OPAQUE',
        'STATUS:CONFIRMED',
        'SEQUENCE:0',
        'X-MICROSOFT-CDO-INSTTYPE:1',
      ),
    ),
    model: {
      uid: '040000008200E00074C5B7101A82E00800000000C0E4B6D5F2A4DB01000000000000000010000000C3D4E5F607182930',
      title: 'Board meeting',
      start: 'zoned 2026-01-13T16:00:00 America/New_York',
      end: 'zoned 2026-01-13T17:30:00 America/New_York',
      status: 'confirmed',
      rule: 'FREQ=MONTHLY;BYDAY=2TU',
      // An organizer alone is not a guest list; nobody else was invited.
    },
  },
  {
    name: 'exchange: a cancelled meeting',
    dialect: 'Microsoft Exchange',
    contains: ['STATUS:CANCELLED', 'METHOD:REQUEST', 'SUMMARY;LANGUAGE=en-US:Canceled: Budget review'],
    lines: exchange(
      windowsZone('GMT Standard Time', '+0000', '+0100', EUROPEAN_RULES[0], EUROPEAN_RULES[1]),
      vevent(
        'ORGANIZER;CN=Eve:mailto:eve@example.com',
        'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Bob:mailto:bob@example.org',
        'UID:040000008200E00074C5B7101A82E00800000000D0F5C7E6A3B5DB01000000000000000010000000D4E5F60718293041',
        'SUMMARY;LANGUAGE=en-US:Canceled: Budget review',
        'DTSTART;TZID=GMT Standard Time:20260520T093000',
        'DTEND;TZID=GMT Standard Time:20260520T103000',
        'CLASS:PUBLIC',
        'PRIORITY:1',
        'DTSTAMP:20260518T090000Z',
        'TRANSP:TRANSPARENT',
        'STATUS:CANCELLED',
        'SEQUENCE:1',
        'X-MICROSOFT-CDO-BUSYSTATUS:FREE',
      ),
    ),
    model: {
      uid: '040000008200E00074C5B7101A82E00800000000D0F5C7E6A3B5DB01000000000000000010000000D4E5F60718293041',
      title: 'Canceled: Budget review',
      start: 'zoned 2026-05-20T09:30:00 Europe/London',
      end: 'zoned 2026-05-20T10:30:00 Europe/London',
      status: 'cancelled',
      guests: true,
    },
  },
  {
    name: 'outlook: an all-day event',
    dialect: 'Microsoft Outlook',
    contains: ['X-MICROSOFT-CDO-ALLDAYEVENT:TRUE', 'DTSTART;VALUE=DATE:20260501'],
    lines: plain(
      '-//Microsoft Corporation//Outlook 16.0 MIMEDIR//EN',
      vevent(
        'CLASS:PUBLIC',
        'CREATED:20260410T090000Z',
        'DTEND;VALUE=DATE:20260502',
        'DTSTAMP:20260410T090000Z',
        'DTSTART;VALUE=DATE:20260501',
        'LAST-MODIFIED:20260410T090000Z',
        'PRIORITY:5',
        'SEQUENCE:0',
        'SUMMARY;LANGUAGE=en-gb:Dia do Trabalhador',
        'TRANSP:TRANSPARENT',
        'UID:040000008200E00074C5B7101A82E00800000000E0A6D8F7B4C6DB01000000000000000010000000E5F6071829304152',
        'X-MICROSOFT-CDO-ALLDAYEVENT:TRUE',
        'X-MICROSOFT-CDO-BUSYSTATUS:FREE',
      ),
    ),
    model: {
      uid: '040000008200E00074C5B7101A82E00800000000E0A6D8F7B4C6DB01000000000000000010000000E5F6071829304152',
      title: 'Dia do Trabalhador',
      start: 'date 2026-05-01',
    },
  },

  // ------------------------------------------------- Fastmail, DAVx5 and others
  {
    name: 'fastmail: a length given as a duration, in a southern zone',
    dialect: 'Fastmail',
    contains: ['DURATION:PT1H30M', 'DTSTART;TZID=Australia/Melbourne:20261006T180000'],
    lines: plain(
      '-//Fastmail/2020.5/EN',
      vevent(
        'UID:e2b0c7d4-3f1a-4b6e-9c8d-5a7f0e1b2c3d',
        'SEQUENCE:1',
        'DTSTAMP:20260901T000000Z',
        'CREATED:20260901T000000Z',
        'DTSTART;TZID=Australia/Melbourne:20261006T180000',
        'DURATION:PT1H30M',
        'SUMMARY:Choir',
        'RRULE:FREQ=WEEKLY;BYDAY=TU',
        'TRANSP:OPAQUE',
      ),
    ),
    model: {
      uid: 'e2b0c7d4-3f1a-4b6e-9c8d-5a7f0e1b2c3d',
      title: 'Choir',
      start: 'zoned 2026-10-06T18:00:00 Australia/Melbourne',
      end: 'zoned 2026-10-06T19:30:00 Australia/Melbourne',
      // 6 October 2026 is a Tuesday.
      rule: 'FREQ=WEEKLY',
    },
  },
  {
    name: 'davx5: an event made on a phone, with two extra dates',
    dialect: 'DAVx5 (Android)',
    contains: ['PRODID:DAVx5/4.3.16-ose ical4j/3.2.14', 'RDATE;TZID=Asia/Kolkata:20260820T173000,20260827T173000'],
    lines: plain(
      'DAVx5/4.3.16-ose ical4j/3.2.14',
      vevent(
        'DTSTAMP:20260801T120000Z',
        'UID:f3c1d8e5-4a2b-4c7f-8d9e-6b8a1f2c3d4e',
        'SUMMARY:Tabla class',
        'DTSTART;TZID=Asia/Kolkata:20260813T173000',
        'DTEND;TZID=Asia/Kolkata:20260813T183000',
        'RDATE;TZID=Asia/Kolkata:20260820T173000,20260827T173000',
        'STATUS:CONFIRMED',
      ),
      vtimezone(
        'Asia/Kolkata',
        ['TZOFFSETFROM:+0530', 'TZOFFSETTO:+0630', 'TZNAME:+0630', 'DTSTART:19420901T000000'],
        ['TZOFFSETFROM:+0630', 'TZOFFSETTO:+0530', 'TZNAME:IST', 'DTSTART:19451015T000000'],
      ),
    ),
    model: {
      uid: 'f3c1d8e5-4a2b-4c7f-8d9e-6b8a1f2c3d4e',
      title: 'Tabla class',
      start: 'zoned 2026-08-13T17:30:00 Asia/Kolkata',
      end: 'zoned 2026-08-13T18:30:00 Asia/Kolkata',
      status: 'confirmed',
      rdates: ['2026-08-20T17:30:00', '2026-08-27T17:30:00'],
    },
  },
  {
    name: 'a zone named UTC is a time in UTC',
    dialect: 'various',
    contains: ['DTSTART;TZID=UTC:20260115T140000'],
    lines: plain(
      '-//Example Corp//Scheduler 2.1//EN',
      vevent(
        'UID:utc-by-name@example.com',
        'DTSTAMP:20260101T000000Z',
        'DTSTART;TZID=UTC:20260115T140000',
        'DTEND;TZID=UTC:20260115T150000',
        'SUMMARY:Release window',
      ),
    ),
    model: {
      uid: 'utc-by-name@example.com',
      title: 'Release window',
      start: 'utc 2026-01-15T14:00:00',
      end: 'utc 2026-01-15T15:00:00',
    },
  },
  {
    name: 'an all-day event whose length is a duration',
    dialect: 'various',
    contains: ['DURATION:P3D', 'DTSTART;VALUE=DATE:20260803'],
    lines: plain(
      '-//Example Corp//Scheduler 2.1//EN',
      vevent(
        'UID:all-day-duration@example.com',
        'DTSTAMP:20260101T000000Z',
        'DTSTART;VALUE=DATE:20260803',
        'DURATION:P3D',
        'SUMMARY:Festival',
      ),
    ),
    model: {
      uid: 'all-day-duration@example.com',
      title: 'Festival',
      start: 'date 2026-08-03',
      end: 'date 2026-08-06',
    },
  },
  {
    name: 'a leap day, every year, spelled out in full',
    dialect: 'various',
    contains: ['RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29'],
    lines: plain(
      '-//Example Corp//Scheduler 2.1//EN',
      vevent(
        'UID:leap-day@example.com',
        'DTSTAMP:20240101T000000Z',
        'DTSTART;VALUE=DATE:20240229',
        'RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29',
        'SUMMARY:Leap day',
      ),
    ),
    model: {
      uid: 'leap-day@example.com',
      title: 'Leap day',
      start: 'date 2024-02-29',
      rule: 'FREQ=YEARLY',
    },
  },
  {
    name: 'a removed occurrence named by its day alone, and one named in UTC',
    dialect: 'various',
    contains: ['EXDATE;VALUE=DATE:20260406', 'EXDATE:20260413T080000Z'],
    lines: plain(
      '-//Example Corp//Scheduler 2.1//EN',
      vevent(
        'UID:exdate-forms@example.com',
        'DTSTAMP:20260101T000000Z',
        'DTSTART;TZID=Europe/Berlin:20260330T100000',
        'DTEND;TZID=Europe/Berlin:20260330T110000',
        'RRULE:FREQ=WEEKLY;COUNT=5',
        'EXDATE;VALUE=DATE:20260406',
        'EXDATE:20260413T080000Z',
        'SUMMARY:Seminar',
      ),
    ),
    model: {
      uid: 'exdate-forms@example.com',
      title: 'Seminar',
      start: 'zoned 2026-03-30T10:00:00 Europe/Berlin',
      end: 'zoned 2026-03-30T11:00:00 Europe/Berlin',
      rule: 'FREQ=WEEKLY;COUNT=5',
      // 08:00 UTC on 13 April is 10:00 in Berlin, which is on summer time by then.
      exdates: ['2026-04-06', '2026-04-13T10:00:00'],
    },
  },
  {
    name: 'a zone nobody can explain leaves only the wall time',
    dialect: 'various',
    contains: ['DTSTART;TZID=Mars/Olympus_Mons:20260601T120000'],
    lines: plain(
      '-//Example Corp//Scheduler 2.1//EN',
      vevent(
        'UID:unknown-zone@example.com',
        'DTSTAMP:20260101T000000Z',
        'DTSTART;TZID=Mars/Olympus_Mons:20260601T120000',
        'DTEND;TZID=Mars/Olympus_Mons:20260601T130000',
        'SUMMARY:Lunch on Mars',
      ),
    ),
    model: {
      uid: 'unknown-zone@example.com',
      title: 'Lunch on Mars',
      start: 'floating 2026-06-01T12:00:00',
      end: 'floating 2026-06-01T13:00:00',
    },
  },
  {
    name: 'an end that is not after the start is no end',
    dialect: 'various',
    contains: ['DTSTART:20260323T090000Z', 'DTEND:20260323T090000Z'],
    lines: plain(
      '-//Example Corp//Scheduler 2.1//EN',
      vevent(
        'UID:zero-length@example.com',
        'DTSTAMP:20260101T000000Z',
        'DTSTART:20260323T090000Z',
        'DTEND:20260323T090000Z',
        'SUMMARY:Deadline',
      ),
    ),
    model: {
      uid: 'zero-length@example.com',
      title: 'Deadline',
      start: 'utc 2026-03-23T09:00:00',
    },
  },
  {
    name: 'an occurrence the person was invited to on its own, with no series around it',
    dialect: 'various',
    contains: ['RECURRENCE-ID:20260112T100000Z', 'RECURRENCE-ID:20260105T100000Z'],
    lines: plain(
      '-//Example Corp//Scheduler 2.1//EN',
      vevent(
        'UID:only-occurrences@example.com',
        'DTSTAMP:20260101T000000Z',
        'RECURRENCE-ID:20260112T100000Z',
        'DTSTART:20260112T110000Z',
        'SUMMARY:Second session',
      ),
      vevent(
        'UID:only-occurrences@example.com',
        'DTSTAMP:20260101T000000Z',
        'RECURRENCE-ID:20260105T100000Z',
        'DTSTART:20260105T110000Z',
        'SUMMARY:First session',
      ),
    ),
    model: {
      uid: 'only-occurrences@example.com',
      title: 'First session',
      start: 'utc 2026-01-05T11:00:00',
      overrides: [{ recurrenceId: '2026-01-12T10:00:00', title: 'Second session', start: 'utc 2026-01-12T11:00:00' }],
    },
  },
]
