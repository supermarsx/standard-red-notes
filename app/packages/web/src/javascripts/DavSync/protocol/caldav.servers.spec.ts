import { existsSync } from 'node:fs'
import { DavSessionContext, davSession, recordingFile } from '../testing/davSession'
import { discover, fetchEntries, listEntries, listRepeatingEntries, readCollectionState } from './caldav'
import { parseMultistatus, pathOfHref } from './multistatus'

/**
 * The CalDAV requests, against three real servers. Every answer here is what
 * that server really gave to these very requests (`testing/davSession.ts` says
 * how the recordings are made, and how to make them again).
 *
 *  - Radicale is the strict one: it rejects sloppy requests the others forgive.
 *  - Nextcloud is the one people use; it and Baïkal are both built on sabre/dav,
 *    in different versions and with different extensions.
 *
 * Where the three differ, the difference is written down per server below
 * rather than averaged away: it is the reason to test against all of them.
 *
 * Nextcloud has not been recorded yet (see `notYetRecorded`): its sessions are
 * reported as skipped, with the reason in their name, until its recordings exist.
 */

type Server = {
  prefix: 'radicale' | 'nextcloud' | 'baikal'
  principal: string
  home: string
  /** Collections the account has before the test makes any, by path, with what the account may do. */
  alreadyThere: { path: string; canWrite: boolean }[]
  /**
   * Set only for a server whose sessions have never been recorded, saying why.
   * Its tests are skipped while none of its recordings exist, and run as soon as
   * they do. A server without this field always runs: a recording of it that
   * goes missing is a failure, not a skip.
   */
  notYetRecorded?: string
}

const SESSIONS = ['discovery', 'listing', 'series', 'missing-collection'] as const

/** Whether this run can answer the server's sessions: from its recordings, or from the server itself. */
const canRun = (server: Server): boolean =>
  !server.notYetRecorded ||
  (Boolean(process.env.DAV_RECORD_ORIGIN) && process.env.DAV_RECORD_PREFIX === server.prefix) ||
  SESSIONS.some((session) => existsSync(recordingFile(server.prefix, session)))

const SERVERS: Server[] = [
  { prefix: 'radicale', principal: '/bob/', home: '/bob/', alreadyThere: [] },
  {
    prefix: 'nextcloud',
    principal: '/remote.php/dav/principals/users/bob/',
    home: '/remote.php/dav/calendars/bob/',
    // Every Nextcloud account has these two. The birthday calendar is generated from the address
    // book and cannot be written to; the scheduling inbox and outbox and the trash bin, which are
    // also in the calendar home, are not calendars and must not be listed.
    alreadyThere: [
      { path: '/remote.php/dav/calendars/bob/contact_birthdays/', canWrite: false },
      { path: '/remote.php/dav/calendars/bob/personal/', canWrite: true },
    ],
    // `WINDOW_ANSWERS.nextcloud` below is a placeholder until then: fill it from what the server really answers.
    notYetRecorded:
      'never recorded: the test server refused MKCALENDAR (429, ten new calendars an hour per account) ' +
      'before the sessions could run',
  },
  {
    prefix: 'baikal',
    principal: '/dav.php/principals/bob/',
    home: '/dav.php/calendars/bob/',
    alreadyThere: [],
  },
]

/**
 * What each server's windowed listing got wrong, by entry: `missed` are entries
 * with an occurrence in the window that it did not return (an event that would
 * silently be absent), `extra` are entries with none that it returned
 * (harmless). Recorded from the real servers, not assumed.
 */
const WINDOW_ANSWERS: Record<Server['prefix'], { missed: string[]; extra: string[] }> = {
  radicale: { missed: [], extra: [] },
  nextcloud: { missed: [], extra: [] },
  baikal: { missed: [], extra: [] },
}

const mkcalendar = (name: string, components: string[], color?: string): string =>
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:ic="http://apple.com/ns/ical/">' +
  `<d:set><d:prop><d:displayname>${name}</d:displayname>` +
  `<c:supported-calendar-component-set>${components.map((component) => `<c:comp name="${component}"/>`).join('')}` +
  '</c:supported-calendar-component-set>' +
  (color ? `<ic:calendar-color>${color}</ic:calendar-color>` : '') +
  '</d:prop></d:set></c:mkcalendar>'

const calendarObject = (...components: string[][]): string =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SRN//dav-session//EN']
    .concat(...components, 'END:VCALENDAR', '')
    .join('\r\n')

const vevent = (uid: string, ...lines: string[]): string[] => [
  'BEGIN:VEVENT',
  `UID:${uid}`,
  'DTSTAMP:20261001T000000Z',
  ...lines,
  'END:VEVENT',
]

const event = (uid: string, ...lines: string[]): string => calendarObject(vevent(uid, ...lines))

/** A replayed session takes milliseconds. A recorded one waits for a real server, and Nextcloud is not quick. */
const SESSION_TIMEOUT_MS = 180_000

const XML = { 'content-type': 'application/xml; charset=utf-8' }
const ICS = { 'content-type': 'text/calendar; charset=utf-8' }

/** The collections these tests make. */
const TEST_COLLECTIONS = ['work/', 'tasks/', 'both%20kinds/', 'window/', 'series/']

/**
 * A collection that exists and is empty, whatever an earlier session left in it.
 *
 * It is made once and emptied after that, not deleted and made again: Nextcloud
 * lets an account create ten calendars an hour and answers 429 to the eleventh,
 * and it keeps a deleted calendar in a trash bin that blocks its name.
 */
const emptyCollection = async (
  { observer }: DavSessionContext,
  path: string,
  name: string,
  components: string[],
  color?: string,
): Promise<string> => {
  const listing = await observer.request(
    'PROPFIND',
    path,
    { depth: '1', ...XML },
    '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>',
  )
  if (listing.status === 404) {
    expect((await observer.request('MKCALENDAR', path, XML, mkcalendar(name, components, color))).status).toBe(201)
    return path
  }
  expect(listing.status).toBe(207)
  for (const response of parseMultistatus(listing.body)?.responses ?? []) {
    const entry = pathOfHref(response.href, path)
    if (entry !== null && entry !== path) {
      expect([200, 204]).toContain((await observer.request('DELETE', entry)).status)
    }
  }
  return path
}

for (const server of SERVERS.filter((candidate) => !canRun(candidate))) {
  describe.skip(`CalDAV against ${server.prefix} (skipped: ${server.notYetRecorded})`, () => {
    it.each(SESSIONS)('%s', () => undefined)
  })
}

describe.each(SERVERS.filter(canRun))('CalDAV against $prefix', (server) => {
  const { prefix, home } = server

  it(
    'finds the calendars of an account from its bare address, and nothing that is not a calendar',
    () =>
      davSession(prefix, 'discovery', async (session) => {
        const { transport } = session
        await emptyCollection(session, `${home}work/`, 'Work', ['VEVENT'], '#3b82f6ff')
        await emptyCollection(session, `${home}tasks/`, 'Tasks', ['VTODO'])
        await emptyCollection(session, `${home}both%20kinds/`, 'Both kinds', ['VEVENT', 'VTODO'])

        const discovery = await discover(transport, '/')

        expect(discovery.ok).toBe(true)
        if (!discovery.ok) {
          return
        }
        expect(discovery.value.principalPath).toBe(server.principal)
        expect(discovery.value.calendarHomePath).toBe(home)

        const found = new Map(discovery.value.collections.map((collection) => [collection.path, collection]))
        expect(found.get(`${home}work/`)).toMatchObject({
          name: 'Work',
          components: ['VEVENT'],
          canWrite: true,
          color: '#3b82f6',
        })
        expect(found.get(`${home}tasks/`)).toMatchObject({ name: 'Tasks', components: ['VTODO'], canWrite: true })
        expect(found.get(`${home}both%20kinds/`)).toMatchObject({
          name: 'Both kinds',
          components: ['VEVENT', 'VTODO'],
          canWrite: true,
        })
        // Everything else that came back is something the account had already, and exactly that.
        const others = discovery.value.collections
          .filter((collection) => !TEST_COLLECTIONS.some((name) => collection.path === `${home}${name}`))
          .map((collection) => ({ path: collection.path, canWrite: collection.canWrite }))
          .sort((a, b) => a.path.localeCompare(b.path))
        expect(others).toEqual(server.alreadyThere)
        // Every collection carries the tag that says whether anything in it changed.
        expect(discovery.value.collections.every((collection) => typeof collection.ctag === 'string')).toBe(true)
        // Discovery is PROPFIND and nothing else: that is all the relay forwards before the pin is set.
        expect(new Set(session.sent.map((request) => request.method))).toEqual(new Set(['PROPFIND']))
      }),
    SESSION_TIMEOUT_MS,
  )

  it(
    'lists what is in a window, fetches entries, and sees what another app then changed',
    () =>
      davSession(prefix, 'listing', async (session) => {
        const { observer, transport } = session
        const calendar = await emptyCollection(session, `${home}window/`, 'Window', ['VEVENT'])
        const put = (name: string, body: string, headers: Record<string, string> = { 'if-none-match': '*' }) =>
          observer.request('PUT', `${calendar}${name}`, { ...ICS, ...headers }, body)

        const inside = await put(
          'inside.ics',
          event('inside@srn', 'DTSTART:20261020T090000Z', 'SUMMARY:Inside the window'),
        )
        await put('long%20past.ics', event('past@srn', 'DTSTART:20200110T090000Z', 'SUMMARY:Long past'))
        await put('far%20future.ics', event('future@srn', 'DTSTART:20310110T090000Z', 'SUMMARY:Far future'))
        expect(inside.status).toBe(201)

        const window = { startMs: Date.UTC(2026, 8, 12), endMs: Date.UTC(2027, 9, 12) }
        const everything = await listEntries(transport, calendar, 'VEVENT')
        const inWindow = await listEntries(transport, calendar, 'VEVENT', window)
        expect(everything.ok && [...everything.value.keys()].sort()).toEqual([
          `${calendar}far%20future.ics`,
          `${calendar}inside.ics`,
          `${calendar}long%20past.ics`,
        ])
        expect(inWindow.ok && [...inWindow.value.keys()]).toEqual([`${calendar}inside.ics`])
        if (!everything.ok || !inWindow.ok) {
          return
        }
        // The listing carries the same ETag the server gave when the entry was written.
        expect(typeof inside.etag).toBe('string')
        expect(inWindow.value.get(`${calendar}inside.ics`)).toBe(inside.etag)

        const before = await readCollectionState(transport, calendar)
        expect(before.ok && typeof before.value.ctag).toBe('string')

        const fetched = await fetchEntries(transport, calendar, [
          `${calendar}inside.ics`,
          `${calendar}far%20future.ics`,
          `${calendar}never%20existed.ics`,
        ])
        expect(fetched.ok).toBe(true)
        if (!fetched.ok) {
          return
        }
        expect(fetched.value.get(`${calendar}never%20existed.ics`)).toEqual({ state: 'gone' })
        const fetchedInside = fetched.value.get(`${calendar}inside.ics`)
        expect(fetchedInside).toMatchObject({ state: 'found', etag: inside.etag })
        expect(fetchedInside?.state === 'found' && fetchedInside.data).toContain('SUMMARY:Inside the window')
        const fetchedFuture = fetched.value.get(`${calendar}far%20future.ics`)
        expect(fetchedFuture?.state === 'found' && fetchedFuture.data).toContain('SUMMARY:Far future')

        // Another app now edits one entry, deletes one and adds one.
        const edited = await put(
          'inside.ics',
          event('inside@srn', 'DTSTART:20261020T100000Z', 'SUMMARY:Inside the window, an hour later'),
          { 'if-match': inside.etag ?? '' },
        )
        expect(edited.status).toBe(204)
        const deleted = await observer.request('DELETE', `${calendar}far%20future.ics`)
        expect([200, 204]).toContain(deleted.status)
        const added = await put('added.ics', event('added@srn', 'DTSTART:20261101T090000Z', 'SUMMARY:Added'))

        const after = await readCollectionState(transport, calendar)
        const nowInWindow = await listEntries(transport, calendar, 'VEVENT', window)
        const nowEverything = await listEntries(transport, calendar, 'VEVENT')
        expect(after.ok && before.ok && after.value.ctag).not.toBe(before.ok && before.value.ctag)
        expect(nowInWindow.ok && [...nowInWindow.value].sort()).toEqual([
          [`${calendar}added.ics`, added.etag],
          [`${calendar}inside.ics`, edited.etag],
        ])
        expect(nowEverything.ok && [...nowEverything.value.keys()].sort()).toEqual([
          `${calendar}added.ics`,
          `${calendar}inside.ics`,
          `${calendar}long%20past.ics`,
        ])
        expect(edited.etag).not.toBe(inside.etag)
      }),
    SESSION_TIMEOUT_MS,
  )

  /**
   * Repeating series are where servers differ in deciding what is "in a window".
   * Each entry below is in or out of the window 12 September 2026 to 12 October
   * 2027 for a stated reason; `listedBy` records what each server answered.
   */
  it(
    'says which repeating series reach into a window, and which entries repeat at all',
    () =>
      davSession(prefix, 'series', async (session) => {
        const { observer, transport } = session
        const calendar = await emptyCollection(session, `${home}series/`, 'Series', ['VEVENT'])
        const put = (name: string, body: string) =>
          observer.request('PUT', `${calendar}${name}`, { ...ICS, 'if-none-match': '*' }, body)

        const entries: { name: string; inWindow: boolean; repeats: boolean; body: string }[] = [
          {
            name: 'still-going.ics',
            inWindow: true,
            repeats: true,
            body: event(
              'still-going@srn',
              'DTSTART;VALUE=DATE:20200106',
              'RRULE:FREQ=WEEKLY',
              'SUMMARY:All-day, weekly since 2020',
            ),
          },
          {
            name: 'ended-by-count.ics',
            inWindow: false,
            repeats: true,
            body: event(
              'ended-by-count@srn',
              'DTSTART;VALUE=DATE:20200106',
              'RRULE:FREQ=WEEKLY;COUNT=5',
              'SUMMARY:Ended in 2020',
            ),
          },
          {
            // Weekly, Tuesdays 18:00 New York. The last one is 8 September 2026 (22:00 UTC), four days before the window.
            name: 'until-before.ics',
            inWindow: false,
            repeats: true,
            body: event(
              'until-before@srn',
              'DTSTART;TZID=America/New_York:20260804T180000',
              'DTEND;TZID=America/New_York:20260804T190000',
              'RRULE:FREQ=WEEKLY;UNTIL=20260908T220000Z',
              'SUMMARY:Ends just before the window',
            ),
          },
          {
            // The same series with one more week: its last occurrence, 15 September 2026, is inside.
            name: 'until-inside.ics',
            inWindow: true,
            repeats: true,
            body: event(
              'until-inside@srn',
              'DTSTART;TZID=America/New_York:20260804T180000',
              'DTEND;TZID=America/New_York:20260804T190000',
              'RRULE:FREQ=WEEKLY;UNTIL=20260915T220000Z',
              'SUMMARY:Ends just inside the window',
            ),
          },
          {
            // Three occurrences in January 2020. One of them was moved to 5 November 2026: that is all that is inside.
            name: 'only-an-exception.ics',
            inWindow: true,
            repeats: true,
            body: calendarObject(
              vevent(
                'only-an-exception@srn',
                'DTSTART:20200106T090000Z',
                'DTEND:20200106T100000Z',
                'RRULE:FREQ=WEEKLY;COUNT=3',
                'SUMMARY:Three in 2020',
              ),
              vevent(
                'only-an-exception@srn',
                'RECURRENCE-ID:20200113T090000Z',
                'DTSTART:20261105T090000Z',
                'DTEND:20261105T100000Z',
                'SUMMARY:Three in 2020 (one moved to 2026)',
              ),
            ),
          },
          {
            // Weekly through the window, but every occurrence inside it was removed: nothing is inside.
            name: 'all-inside-removed.ics',
            inWindow: false,
            repeats: true,
            body: event(
              'all-inside-removed@srn',
              'DTSTART:20260901T090000Z',
              'DTEND:20260901T100000Z',
              'RRULE:FREQ=WEEKLY;COUNT=4',
              'EXDATE:20260915T090000Z,20260922T090000Z',
              'SUMMARY:Its two occurrences inside the window are removed',
            ),
          },
          {
            name: 'single-inside.ics',
            inWindow: true,
            repeats: false,
            body: event('single-inside@srn', 'DTSTART:20261020T090000Z', 'SUMMARY:One event, inside'),
          },
          {
            name: 'single-outside.ics',
            inWindow: false,
            repeats: false,
            body: event('single-outside@srn', 'DTSTART:20200110T090000Z', 'SUMMARY:One event, outside'),
          },
        ]
        for (const entry of entries) {
          expect((await put(entry.name, entry.body)).status).toBe(201)
        }

        const window = { startMs: Date.UTC(2026, 8, 12), endMs: Date.UTC(2027, 9, 12) }
        const listed = await listEntries(transport, calendar, 'VEVENT', window)
        const repeating = await listRepeatingEntries(transport, calendar, 'VEVENT')
        expect(listed.ok && repeating.ok).toBe(true)
        if (!listed.ok || !repeating.ok) {
          return
        }
        const names = (paths: Iterable<string>): string[] =>
          [...paths].map((path) => path.slice(calendar.length)).sort()

        // Which entries repeat is not a matter of judgement, and every server must get it right:
        // it is the list the engine checks a windowed listing against.
        expect(names(repeating.value.keys())).toEqual(
          names(entries.filter((entry) => entry.repeats).map((e) => calendar + e.name)),
        )

        const shouldBeListed = names(entries.filter((entry) => entry.inWindow).map((entry) => calendar + entry.name))
        const wasListed = names(listed.value.keys())
        const missed = shouldBeListed.filter((name) => !wasListed.includes(name))
        const extra = wasListed.filter((name) => !shouldBeListed.includes(name))
        expect({ missed, extra }).toEqual(WINDOW_ANSWERS[prefix])
      }),
    SESSION_TIMEOUT_MS,
  )

  it(
    'reports a collection that is not there as the status the server gave, not as an empty one',
    () =>
      davSession(prefix, 'missing-collection', async (session) => {
        const missing = `${home}no-such-calendar/`
        const listing = await listEntries(session.transport, missing, 'VEVENT')
        expect(listing).toEqual({ ok: false, failure: { kind: 'remote-status', status: 404, path: missing } })
        const state = await readCollectionState(session.transport, missing)
        expect(state).toMatchObject({ ok: false, failure: { kind: 'remote-status', status: 404 } })
        const fetched = await fetchEntries(session.transport, missing, [`${missing}a.ics`])
        expect(fetched).toMatchObject({ ok: false, failure: { kind: 'remote-status', status: 404 } })
      }),
    SESSION_TIMEOUT_MS,
  )
})
