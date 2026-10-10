import 'reflect-metadata'

import express, { NextFunction, Request, Response } from 'express'
import * as http from 'http'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AddressInfo } from 'net'

import { createCaldavRouter } from './createCaldavRouter'
import { CaldavService } from '../Service/Caldav/CaldavService'
import { CaldavTokenStore } from '../Service/Caldav/CaldavTokenStore'
import { CalendarProjectionStore } from '../Service/Caldav/CalendarProjectionStore'
import { PublishedCalendarStore } from '../Service/Caldav/PublishedCalendarStore'
import { CalendarProjectionSettings } from '../Service/Caldav/CalendarProjection'

/**
 * The due-date EVENT collection, exercised over real HTTP.
 *
 * Every assertion here reads the SERVED BODY. A setting that compiles and does
 * nothing is the failure mode this suite exists to rule out, so each axis is
 * flipped against the SAME stored records and the body is required to change in
 * a named, specific way — never merely "did not error".
 */

interface Harness {
  baseUrl: string
  service: CaldavService
  tokenStore: CaldavTokenStore
  publishedStore: PublishedCalendarStore
  projectionStore: CalendarProjectionStore
  server: http.Server
  dir: string
}

const BASE = '/dav'

async function startHarness(): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'caldav-events-'))
  const tokenStore = new CaldavTokenStore(path.join(dir, 'tokens.json'))
  const publishedStore = new PublishedCalendarStore(path.join(dir, 'published.json'))
  const projectionStore = new CalendarProjectionStore(path.join(dir, 'projection.json'))
  const service = new CaldavService(true, tokenStore, publishedStore, projectionStore)

  const app = express()
  app.use(BASE, createCaldavRouter(service, { basePath: BASE }))
  app.use((_error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    response.status(500).send('Internal server error')
  })
  const server = await new Promise<http.Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance))
  })
  const port = (server.address() as AddressInfo).port
  return { baseUrl: `http://127.0.0.1:${port}`, service, tokenStore, publishedStore, projectionStore, server, dir }
}

function basic(token: string): string {
  return 'Basic ' + Buffer.from(`caldav:${token}`).toString('base64')
}

const USER = 'user-1'

describe('createCaldavRouter: due-date events collection', () => {
  let h: Harness | undefined
  let auth: string
  let eventsUrl: string
  let todosUrl: string

  const configure = async (overrides: Partial<CalendarProjectionSettings>): Promise<void> => {
    await (h as Harness).projectionStore.setForUser(USER, { enabled: true, ...overrides })
  }

  const getEvents = async (): Promise<{ status: number; body: string; etag: string | null }> => {
    const response = await fetch(eventsUrl, { headers: { authorization: auth } })
    return { status: response.status, body: await response.text(), etag: response.headers.get('etag') }
  }

  beforeEach(async () => {
    h = await startHarness()
    const created = await h.tokenStore.create(USER, 'Phone')
    auth = basic(created.token)
    eventsUrl = `${h.baseUrl}${BASE}/calendars/${USER}/events/`
    todosUrl = `${h.baseUrl}${BASE}/calendars/${USER}/todos/`
    await h.publishedStore.publish(USER, {
      uid: 'task-timed',
      summary: 'File taxes',
      due: '2026-03-14T17:00:00.000Z',
      categories: ['Finance'],
    })
    await h.publishedStore.publish(USER, { uid: 'task-dated', summary: 'Renew passport', due: '2026-04-01' })
    await h.publishedStore.publish(USER, { uid: 'task-undated', summary: 'Someday' })
  })

  afterEach(async () => {
    if (h) {
      await new Promise<void>((resolve) => h?.server.close(() => resolve()))
      await fs.rm(h.dir, { recursive: true, force: true })
      h = undefined
    }
  })

  describe('the master switch', () => {
    it('404s the collection, its objects, OPTIONS and REPORT while off', async () => {
      await expect(getEvents().then((result) => result.status)).resolves.toBe(404)
      const object = await fetch(`${eventsUrl}task-timed.ics`, { headers: { authorization: auth } })
      expect(object.status).toBe(404)
      const options = await fetch(eventsUrl, { method: 'OPTIONS', headers: { authorization: auth } })
      expect(options.status).toBe(404)
      const report = await fetch(eventsUrl, {
        method: 'REPORT',
        headers: { authorization: auth, 'content-type': 'application/xml' },
        body: '<C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav"/>',
      })
      expect(report.status).toBe(404)
      const propfind = await fetch(eventsUrl, { method: 'PROPFIND', headers: { authorization: auth, depth: '0' } })
      expect(propfind.status).toBe(404)
    })

    it('leaves the todos collection completely untouched while off', async () => {
      const todos = await fetch(todosUrl, { headers: { authorization: auth } })
      expect(todos.status).toBe(200)
      const body = await todos.text()
      expect(body).toContain('BEGIN:VTODO')
      expect(body).not.toContain('BEGIN:VEVENT')
    })

    it('serves the collection once on, and only the DATED tasks', async () => {
      await configure({})
      const { status, body } = await getEvents()
      expect(status).toBe(200)
      expect(body).toContain('UID:srn-due-task-timed')
      expect(body).toContain('UID:srn-due-task-dated')
      expect(body).not.toContain('task-undated')
    })

    it('never puts a VEVENT in the todos collection, which RFC 4791 forbids', async () => {
      await configure({})
      const todos = await (await fetch(todosUrl, { headers: { authorization: auth } })).text()
      expect(todos).not.toContain('BEGIN:VEVENT')
      const events = (await getEvents()).body
      expect(events).not.toContain('BEGIN:VTODO')
    })

    it('gives the event a uid distinct from the task resource it was projected from', async () => {
      await configure({})
      const events = (await getEvents()).body
      expect(events).toContain('UID:srn-due-task-timed')
      expect(events).not.toContain('UID:task-timed\r\n')
    })
  })

  describe('discovery', () => {
    it('omits the events collection from the calendar home while off and lists it once on', async () => {
      const home = `${h?.baseUrl}${BASE}/calendars/${USER}/`
      const off = await (await fetch(home, { method: 'PROPFIND', headers: { authorization: auth, depth: '1' } })).text()
      expect(off).toContain('/dav/calendars/user-1/todos/')
      expect(off).not.toContain('/dav/calendars/user-1/events/')

      await configure({})
      const on = await (await fetch(home, { method: 'PROPFIND', headers: { authorization: auth, depth: '1' } })).text()
      expect(on).toContain('/dav/calendars/user-1/events/')
    })

    it('advertises VEVENT on the events collection and VTODO on the todos one', async () => {
      await configure({})
      const events = await (
        await fetch(eventsUrl, { method: 'PROPFIND', headers: { authorization: auth, depth: '0' } })
      ).text()
      expect(events).toContain('<C:comp name="VEVENT"/>')
      expect(events).toContain('component=VEVENT')
      expect(events).toContain('<displayname>Task Due Dates</displayname>')

      const todos = await (
        await fetch(todosUrl, { method: 'PROPFIND', headers: { authorization: auth, depth: '0' } })
      ).text()
      expect(todos).toContain('<C:comp name="VTODO"/>')
      expect(todos).not.toContain('<C:comp name="VEVENT"/>')
    })

    it('lists one object href per projected event at Depth: 1', async () => {
      await configure({})
      const body = await (
        await fetch(eventsUrl, { method: 'PROPFIND', headers: { authorization: auth, depth: '1' } })
      ).text()
      expect(body).toContain('/dav/calendars/user-1/events/task-timed.ics')
      expect(body).toContain('/dav/calendars/user-1/events/task-dated.ics')
      expect(body).not.toContain('/dav/calendars/user-1/events/task-undated.ics')
    })

    it('allows only read methods on the collection', async () => {
      await configure({})
      const options = await fetch(eventsUrl, { method: 'OPTIONS', headers: { authorization: auth } })
      expect(options.status).toBe(200)
      expect(options.headers.get('allow')).toBe('OPTIONS, GET, HEAD, PROPFIND, REPORT')
      const put = await fetch(`${eventsUrl}task-timed.ics`, { method: 'PUT', headers: { authorization: auth } })
      expect(put.status).toBe(405)
    })
  })

  describe('REPORT', () => {
    it('answers a VEVENT comp-filter from the events collection', async () => {
      await configure({})
      const response = await fetch(eventsUrl, {
        method: 'REPORT',
        headers: { authorization: auth, 'content-type': 'application/xml', depth: '1' },
        body:
          '<C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav"><C:filter>' +
          '<C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/></C:comp-filter>' +
          '</C:filter></C:calendar-query>',
      })
      expect(response.status).toBe(207)
      const body = await response.text()
      expect(body).toContain('BEGIN:VEVENT')
      expect(body).toContain('srn-due-task-timed')
    })

    it('answers a VTODO comp-filter on the EVENTS collection with nothing, not with the wrong component', async () => {
      await configure({})
      const body = await (
        await fetch(eventsUrl, {
          method: 'REPORT',
          headers: { authorization: auth, 'content-type': 'application/xml', depth: '1' },
          body:
            '<C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav"><C:filter>' +
            '<C:comp-filter name="VCALENDAR"><C:comp-filter name="VTODO"/></C:comp-filter>' +
            '</C:filter></C:calendar-query>',
        })
      ).text()
      expect(body).not.toContain('BEGIN:VEVENT')
      expect(body).not.toContain('BEGIN:VTODO')
    })

    it('still answers a VTODO comp-filter on the TODOS collection, unchanged', async () => {
      await configure({})
      const body = await (
        await fetch(todosUrl, {
          method: 'REPORT',
          headers: { authorization: auth, 'content-type': 'application/xml', depth: '1' },
          body:
            '<C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav"><C:filter>' +
            '<C:comp-filter name="VCALENDAR"><C:comp-filter name="VTODO"/></C:comp-filter>' +
            '</C:filter></C:calendar-query>',
        })
      ).text()
      expect(body).toContain('BEGIN:VTODO')
    })

    it('resolves a calendar-multiget against the events collection and 404s an unknown href', async () => {
      await configure({})
      const body = await (
        await fetch(eventsUrl, {
          method: 'REPORT',
          headers: { authorization: auth, 'content-type': 'application/xml', depth: '1' },
          body:
            '<C:calendar-multiget xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:D="DAV:">' +
            '<D:href>/dav/calendars/user-1/events/task-timed.ics</D:href>' +
            '<D:href>/dav/calendars/user-1/events/task-undated.ics</D:href>' +
            '<D:href>/dav/calendars/user-1/todos/task-timed.ics</D:href>' +
            '</C:calendar-multiget>',
        })
      ).text()
      expect(body).toContain('srn-due-task-timed')
      expect(body).toContain('404 Not Found')
      // A todos href asked for inside the events collection is not a match.
      expect((body.match(/404 Not Found/g) ?? []).length).toBe(2)
    })
  })

  describe('each configuration axis measurably changes the served body', () => {
    it('allDay: auto vs always vs never', async () => {
      await configure({ allDay: 'auto' })
      const auto = (await getEvents()).body
      expect(auto).toContain('DTSTART:20260314T160000Z')
      expect(auto).toContain('DTSTART;VALUE=DATE:20260401')

      await configure({ allDay: 'always' })
      const always = (await getEvents()).body
      expect(always).toContain('DTSTART;VALUE=DATE:20260314')
      expect(always).not.toContain('DTSTART:2026')

      // `never` is TOTAL: even a record published as a plain date becomes a
      // block, ending (anchor=end) at the first instant of that day.
      await configure({ allDay: 'never' })
      const never = (await getEvents()).body
      expect(never).toContain('DTEND:20260401T000000Z')
      expect(never).toContain('DTSTART:20260331T230000Z')
      expect(never).not.toContain('VALUE=DATE')
    })

    it('durationMinutes', async () => {
      await configure({ durationMinutes: 60 })
      expect((await getEvents()).body).toContain('DTSTART:20260314T160000Z')
      await configure({ durationMinutes: 15 })
      expect((await getEvents()).body).toContain('DTSTART:20260314T164500Z')
      await configure({ durationMinutes: 480 })
      expect((await getEvents()).body).toContain('DTSTART:20260314T090000Z')
    })

    it('anchor: the deadline is the end or the start', async () => {
      await configure({ anchor: 'end' })
      expect((await getEvents()).body).toContain('DTEND:20260314T170000Z')
      await configure({ anchor: 'start' })
      const started = (await getEvents()).body
      expect(started).toContain('DTSTART:20260314T170000Z')
      expect(started).toContain('DTEND:20260314T180000Z')
    })

    it('timeZone: the same instant is a date in one zone and a time in another', async () => {
      await h?.publishedStore.publish(USER, {
        uid: 'task-midnight',
        summary: 'Midnight UTC',
        due: '2026-05-01T00:00:00.000Z',
      })
      await configure({ timeZone: '' })
      expect((await getEvents()).body).toContain('DTSTART;VALUE=DATE:20260501')
      await configure({ timeZone: 'Europe/Berlin' })
      const berlin = (await getEvents()).body
      expect(berlin).not.toContain('DTSTART;VALUE=DATE:20260501')
      expect(berlin).toContain('DTSTART:20260430T230000Z')
    })

    it('timeZone also moves the all-day DATE an instant lands on', async () => {
      await h?.publishedStore.publish(USER, {
        uid: 'task-evening',
        summary: 'Evening UTC',
        due: '2026-05-01T20:00:00.000Z',
      })
      await configure({ allDay: 'always', timeZone: 'Europe/Berlin' })
      expect((await getEvents()).body).toContain('DTSTART;VALUE=DATE:20260501')
      await configure({ allDay: 'always', timeZone: 'Pacific/Auckland' })
      expect((await getEvents()).body).toContain('DTSTART;VALUE=DATE:20260502')
    })

    it('completed: hide, show, mark', async () => {
      await h?.publishedStore.publish(USER, {
        uid: 'task-done',
        summary: 'Finished',
        due: '2026-02-02T09:00:00.000Z',
        completed: true,
      })
      await configure({ completed: 'hide' })
      expect((await getEvents()).body).not.toContain('srn-due-task-done')
      await configure({ completed: 'show' })
      const shown = (await getEvents()).body
      expect(shown).toContain('srn-due-task-done')
      expect(shown).not.toContain('STATUS:CANCELLED')
      await configure({ completed: 'mark' })
      const marked = (await getEvents()).body
      expect(marked).toContain('srn-due-task-done')
      expect(marked).toContain('STATUS:CANCELLED')
      expect(marked).toContain('TRANSP:TRANSPARENT')
    })

    it('alarm: none, at-time, lead', async () => {
      await configure({ alarm: 'none' })
      expect((await getEvents()).body).not.toContain('VALARM')
      await configure({ alarm: 'at-time' })
      const atTime = (await getEvents()).body
      expect(atTime).toContain('BEGIN:VALARM')
      expect(atTime).toContain('TRIGGER;RELATED=END:PT0S')
      await configure({ alarm: 'lead', alarmLeadMinutes: 90 })
      expect((await getEvents()).body).toContain('TRIGGER;RELATED=END:-PT1H30M')
    })

    it('alarmLeadMinutes on its own', async () => {
      await configure({ alarm: 'lead', alarmLeadMinutes: 10 })
      expect((await getEvents()).body).toContain('-PT10M')
      await configure({ alarm: 'lead', alarmLeadMinutes: 1_440 })
      expect((await getEvents()).body).toContain('-P1D')
    })

    it('recurrence: rrule, first-only, ignore', async () => {
      await h?.publishedStore.publish(USER, {
        uid: 'task-standup',
        summary: 'Standup',
        due: '2026-03-16T09:30:00.000Z',
        recurrence: { frequency: 'weekdays', timeZone: 'Europe/Berlin' },
      })
      await configure({ recurrence: 'rrule' })
      const withRule = (await getEvents()).body
      expect(withRule).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')
      expect(withRule).toContain('X-SRN-TZID:Europe/Berlin')

      await configure({ recurrence: 'first-only' })
      const firstOnly = (await getEvents()).body
      expect(firstOnly).toContain('srn-due-task-standup')
      expect(firstOnly).not.toContain('RRULE')

      await configure({ recurrence: 'ignore' })
      const ignored = (await getEvents()).body
      expect(ignored).not.toContain('srn-due-task-standup')
      // A one-off task is unaffected by the recurrence axis.
      expect(ignored).toContain('srn-due-task-timed')
    })

    it('summaryPrefix', async () => {
      await configure({ summaryPrefix: '' })
      expect((await getEvents()).body).toContain('SUMMARY:File taxes')
      await configure({ summaryPrefix: 'Due: ' })
      const prefixed = (await getEvents()).body
      expect(prefixed).toContain('SUMMARY:Due: File taxes')
      expect(prefixed).not.toContain('SUMMARY:File taxes')
    })

    it('categories travel from the published record into the event', async () => {
      await configure({})
      expect((await getEvents()).body).toContain('CATEGORIES:Finance')
    })

    it('moves the strong ETag whenever any axis changes the body', async () => {
      await configure({ durationMinutes: 60 })
      const first = await getEvents()
      await configure({ durationMinutes: 61 })
      const second = await getEvents()
      expect(second.etag).not.toBe(first.etag)
      expect(second.body).not.toBe(first.body)

      // ...and leaves it alone when nothing changed, so a polling client is not
      // made to re-download on every poll.
      const third = await getEvents()
      expect(third.etag).toBe(second.etag)
    })
  })

  describe('the deadline moving and the task completing', () => {
    it('moves the event when the due date is republished', async () => {
      await configure({})
      expect((await getEvents()).body).toContain('DTEND:20260314T170000Z')
      await h?.publishedStore.publish(USER, {
        uid: 'task-timed',
        summary: 'File taxes',
        due: '2026-03-20T12:00:00.000Z',
        categories: ['Finance'],
      })
      const moved = (await getEvents()).body
      expect(moved).toContain('DTEND:20260320T120000Z')
      expect(moved).not.toContain('DTEND:20260314T170000Z')
    })

    it('applies the configured completed behaviour when the task is checked off', async () => {
      await configure({ completed: 'mark' })
      expect((await getEvents()).body).not.toContain('STATUS:CANCELLED')
      await h?.publishedStore.publish(USER, {
        uid: 'task-timed',
        summary: 'File taxes',
        due: '2026-03-14T17:00:00.000Z',
        completed: true,
        categories: ['Finance'],
      })
      expect((await getEvents()).body).toContain('STATUS:CANCELLED')

      await configure({ completed: 'hide' })
      const hidden = (await getEvents()).body
      expect(hidden).not.toContain('srn-due-task-timed')
      // The event's own resource disappears too, which is what makes a client
      // drop its copy rather than keep a stale one.
      const object = await fetch(`${eventsUrl}task-timed.ics`, { headers: { authorization: auth } })
      expect(object.status).toBe(404)
    })

    it('removes the event when the record is unpublished', async () => {
      await configure({})
      expect((await getEvents()).body).toContain('srn-due-task-timed')
      await h?.publishedStore.unpublish(USER, 'task-timed')
      expect((await getEvents()).body).not.toContain('srn-due-task-timed')
    })
  })

  describe('ownership', () => {
    it('refuses another user’s events collection', async () => {
      await configure({})
      await h?.projectionStore.setForUser('user-2', { enabled: true })
      const response = await fetch(`${h?.baseUrl}${BASE}/calendars/user-2/events/`, {
        headers: { authorization: auth },
      })
      expect(response.status).toBe(403)
    })

    it('still challenges an unauthenticated request before the projection is consulted', async () => {
      await configure({})
      const response = await fetch(eventsUrl)
      expect(response.status).toBe(401)
      expect(response.headers.get('www-authenticate')).toContain('Basic')
    })
  })
})
