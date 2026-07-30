import 'reflect-metadata'

import express, { NextFunction, Request, Response } from 'express'
import * as http from 'http'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AddressInfo } from 'net'
import { SettingName } from '@standardnotes/domain-core'

import { createCaldavRouter } from './createCaldavRouter'
import { CaldavTokensController } from '../Controller/v1/CaldavTokensController'
import { CaldavService } from '../Service/Caldav/CaldavService'
import { CaldavTokenStore } from '../Service/Caldav/CaldavTokenStore'
import { PublishedCalendarStore } from '../Service/Caldav/PublishedCalendarStore'

interface Harness {
  baseUrl: string
  service: CaldavService
  tokenStore: CaldavTokenStore
  publishedStore: PublishedCalendarStore
  server: http.Server
  dir: string
  basePath: string
}

async function startHarness(enabled: boolean, basePath = '/dav'): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'caldav-router-'))
  const tokenStore = new CaldavTokenStore(path.join(dir, 'tokens.json'))
  const publishedStore = new PublishedCalendarStore(path.join(dir, 'published.json'))
  const service = new CaldavService(enabled, tokenStore, publishedStore)

  const app = express()
  app.use(basePath, createCaldavRouter(service, { basePath }))
  app.use((_error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    response.status(500).send('Internal server error')
  })
  const server = await new Promise<http.Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance))
  })
  const port = (server.address() as AddressInfo).port
  return { baseUrl: `http://127.0.0.1:${port}`, service, tokenStore, publishedStore, server, dir, basePath }
}

function basic(token: string, username = 'caldav'): string {
  return 'Basic ' + Buffer.from(`${username}:${token}`).toString('base64')
}

describe('createCaldavRouter', () => {
  let h: Harness | undefined

  afterEach(async () => {
    if (h) {
      await new Promise<void>((resolve) => h?.server.close(() => resolve()))
      await fs.rm(h.dir, { recursive: true, force: true })
      h = undefined
    }
  })

  describe('feature gating and authentication', () => {
    it('404s every request when the master switch is off', async () => {
      h = await startHarness(false)
      const created = await h.tokenStore.create('user-1', 'x')
      const response = await fetch(`${h.baseUrl}/dav/`, {
        method: 'OPTIONS',
        headers: { authorization: basic(created.token) },
      })
      expect(response.status).toBe(404)

      const oversized = await fetch(`${h.baseUrl}/dav/calendars/user-1/todos/`, {
        method: 'REPORT',
        headers: { authorization: basic(created.token), 'content-type': 'application/xml' },
        body: 'x'.repeat(300 * 1024),
      })
      expect(oversized.status).toBe(404)
    })

    it('challenges missing or invalid credentials', async () => {
      h = await startHarness(true)
      const missing = await fetch(`${h.baseUrl}/dav/`, { method: 'OPTIONS' })
      expect(missing.status).toBe(401)
      expect(missing.headers.get('www-authenticate')).toMatch(/Basic/)

      const invalid = await fetch(`${h.baseUrl}/dav/`, {
        method: 'OPTIONS',
        headers: { authorization: basic('bogus.token') },
      })
      expect(invalid.status).toBe(401)
    })

    it('rejects lenient base64 and username-less Basic forms', async () => {
      h = await startHarness(true)
      const created = await h.tokenStore.create('user-1', 'Apple')
      const usernameLess = Buffer.from(created.token).toString('base64')
      const responses = await Promise.all([
        fetch(`${h.baseUrl}/dav/`, { method: 'OPTIONS', headers: { authorization: `Basic ${usernameLess}` } }),
        fetch(`${h.baseUrl}/dav/`, { method: 'OPTIONS', headers: { authorization: 'Basic !!!!' } }),
        fetch(`${h.baseUrl}/dav/`, {
          method: 'OPTIONS',
          headers: { authorization: basic(created.token, '') },
        }),
      ])
      expect(responses.map((response) => response.status)).toEqual([401, 401, 401])
    })

    it('advertises only the implemented DAV class and accepts a valid scoped token', async () => {
      h = await startHarness(true)
      const created = await h.tokenStore.create('user-1', 'Apple')
      const response = await fetch(`${h.baseUrl}/dav/`, {
        method: 'OPTIONS',
        headers: { authorization: basic(created.token) },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('dav')).toBe('1, calendar-access')
      expect(response.headers.get('allow')).toBe('OPTIONS, PROPFIND')
      expect(response.headers.get('ms-author-via')).toBe('DAV')
    })

    it('advertises only methods implemented by each exact DAV resource', async () => {
      h = await startHarness(true)
      const created = await h.tokenStore.create('user-1', 'Apple')
      const expected = new Map([
        ['/dav/', 'OPTIONS, PROPFIND'],
        ['/dav/principals/', 'OPTIONS, PROPFIND'],
        ['/dav/principals/user-1/', 'OPTIONS, PROPFIND'],
        ['/dav/calendars/user-1/', 'OPTIONS, PROPFIND'],
        ['/dav/calendars/user-1/todos/', 'OPTIONS, GET, HEAD, PROPFIND, REPORT'],
        ['/dav/calendars/user-1/todos/item.ics', 'OPTIONS, GET, HEAD, PROPFIND'],
      ])

      for (const [pathname, allow] of expected) {
        const response = await fetch(`${h.baseUrl}${pathname}`, {
          method: 'OPTIONS',
          headers: { authorization: basic(created.token) },
        })
        expect(response.status).toBe(200)
        expect(response.headers.get('allow')).toBe(allow)
      }

      const reportAtRoot = await fetch(`${h.baseUrl}/dav/`, {
        method: 'REPORT',
        headers: {
          authorization: basic(created.token),
          'content-type': 'application/xml',
        },
        body: '<C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav"></C:calendar-query>',
      })
      expect(reportAtRoot.status).toBe(405)
      expect(reportAtRoot.headers.get('allow')).toBe('OPTIONS, PROPFIND')
    })
  })

  describe('resource paths and PROPFIND', () => {
    it('discovers the principal and calendar home through exact resources', async () => {
      h = await startHarness(true)
      const created = await h.tokenStore.create('user-1', 'Apple')
      const root = await fetch(`${h.baseUrl}/dav/`, {
        method: 'PROPFIND',
        headers: { authorization: basic(created.token), depth: '0' },
      })
      expect(root.status).toBe(207)
      expect(await root.text()).toContain('/dav/principals/user-1/')

      const principalCollectionDepthZero = await fetch(`${h.baseUrl}/dav/principals/`, {
        method: 'PROPFIND',
        headers: { authorization: basic(created.token), depth: '0' },
      })
      const depthZeroBody = await principalCollectionDepthZero.text()
      expect(principalCollectionDepthZero.status).toBe(207)
      expect(depthZeroBody).toContain('<displayname>Principals</displayname>')
      expect(depthZeroBody).not.toContain('/dav/principals/user-1/')

      const principalCollection = await fetch(`${h.baseUrl}/dav/principals/`, {
        method: 'PROPFIND',
        headers: { authorization: basic(created.token), depth: '1' },
      })
      const principalCollectionBody = await principalCollection.text()
      expect(principalCollection.status).toBe(207)
      expect(principalCollectionBody).toContain('<displayname>Principals</displayname>')
      expect(principalCollectionBody).toContain('/dav/principals/user-1/')

      const principal = await fetch(`${h.baseUrl}/dav/principals/user-1/`, {
        method: 'PROPFIND',
        headers: { authorization: basic(created.token), depth: '0' },
      })
      const body = await principal.text()
      expect(body).toContain('calendar-home-set')
      expect(body).toContain('/dav/calendars/user-1/')
    })

    it('uses a non-default mounted base path in every advertised href', async () => {
      h = await startHarness(true, '/calendar-api')
      const created = await h.tokenStore.create('user-1', 'Apple')
      const response = await fetch(`${h.baseUrl}/calendar-api/principals/user-1/`, {
        method: 'PROPFIND',
        headers: { authorization: basic(created.token), depth: '0' },
      })
      const body = await response.text()
      expect(response.status).toBe(207)
      expect(body).toContain('/calendar-api/calendars/user-1/')
      expect(body).not.toContain('/dav/')
    })

    it('returns a config base path that reaches the same non-default mounted router', async () => {
      h = await startHarness(true, '/calendar-api')
      const created = await h.tokenStore.create('user-1', 'Apple')
      let config: { basePath: string } | undefined
      const response = {
        locals: {
          user: { uuid: 'user-1' },
          settings: { [SettingName.NAMES.CaldavEnabled]: 'true' },
        },
        json: (value: { basePath: string }) => {
          config = value
        },
      } as unknown as Response
      await new CaldavTokensController(h.service, h.basePath).config({} as Request, response)
      expect(config?.basePath).toBe('/calendar-api')

      const reached = await fetch(`${h.baseUrl}${config?.basePath}/calendars/user-1/todos/`, {
        method: 'PROPFIND',
        headers: { authorization: basic(created.token), depth: '0' },
      })
      expect(reached.status).toBe(207)
      const defaultPath = await fetch(`${h.baseUrl}/dav/calendars/user-1/todos/`, {
        method: 'PROPFIND',
        headers: { authorization: basic(created.token), depth: '0' },
      })
      expect(defaultPath.status).toBe(404)
    })

    it('lists object hrefs at Depth 1 without advertising unsupported sync tokens', async () => {
      h = await startHarness(true)
      const created = await h.tokenStore.create('user-1', 'Apple')
      await h.publishedStore.publish('user-1', { uid: 'todo-1', summary: 'Buy milk' })
      const response = await fetch(`${h.baseUrl}/dav/calendars/user-1/todos/`, {
        method: 'PROPFIND',
        headers: { authorization: basic(created.token), depth: '1' },
      })
      const body = await response.text()
      expect(response.status).toBe(207)
      expect(body).toContain('/dav/calendars/user-1/todos/todo-1.ics')
      expect(body).toContain('calendar-query')
      expect(body).toContain('calendar-multiget')
      expect(body).not.toContain('sync-token')
    })

    it('returns object properties for an existing object and 404 for a missing one', async () => {
      h = await startHarness(true)
      const created = await h.tokenStore.create('user-1', 'Apple')
      await h.publishedStore.publish('user-1', { uid: 'todo-1', summary: 'Buy milk' })
      const found = await fetch(`${h.baseUrl}/dav/calendars/user-1/todos/todo-1.ics`, {
        method: 'PROPFIND',
        headers: { authorization: basic(created.token), depth: '0' },
      })
      expect(found.status).toBe(207)
      expect(await found.text()).toContain('getetag')
      const missing = await fetch(`${h.baseUrl}/dav/calendars/user-1/todos/missing.ics`, {
        method: 'PROPFIND',
        headers: { authorization: basic(created.token), depth: '0' },
      })
      expect(missing.status).toBe(404)
    })

    it('rejects cross-user, malformed descendant, and invalid-depth requests', async () => {
      h = await startHarness(true)
      const created = await h.tokenStore.create('user-1', 'Apple')
      const crossUser = await fetch(`${h.baseUrl}/dav/calendars/someone-else/todos/`, {
        method: 'PROPFIND',
        headers: { authorization: basic(created.token), depth: '0' },
      })
      const malformed = await fetch(`${h.baseUrl}/dav/principals-evil/user-1/`, {
        method: 'PROPFIND',
        headers: { authorization: basic(created.token), depth: '0' },
      })
      const invalidDepth = await fetch(`${h.baseUrl}/dav/calendars/user-1/todos/`, {
        method: 'PROPFIND',
        headers: { authorization: basic(created.token), depth: 'infinity' },
      })
      expect(crossUser.status).toBe(403)
      expect(malformed.status).toBe(404)
      expect(invalidDepth.status).toBe(403)
      expect(await invalidDepth.text()).toContain('propfind-finite-depth')
    })
  })

  describe('REPORT', () => {
    it('returns published VTODOs through a component calendar-query', async () => {
      h = await startHarness(true)
      const created = await h.tokenStore.create('user-1', 'Apple')
      await h.publishedStore.publish('user-1', {
        uid: 'todo-1',
        summary: 'Milk & bread',
        due: '2026-06-30T00:00:00Z',
      })
      const response = await fetch(`${h.baseUrl}/dav/calendars/user-1/todos/`, {
        method: 'REPORT',
        headers: { authorization: basic(created.token), 'content-type': 'application/xml', depth: '1' },
        body: '<?xml version="1.0"?><C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav"><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VTODO"/></C:comp-filter></C:filter></C:calendar-query>',
      })
      const body = await response.text()
      expect(response.status).toBe(207)
      expect(body).toContain('calendar-data')
      expect(body).toContain('Milk &amp; bread')
      expect(body).not.toContain('Milk & bread')
    })

    it('returns only requested multiget hrefs and reports missing or foreign hrefs as 404', async () => {
      h = await startHarness(true)
      const created = await h.tokenStore.create('user-1', 'Apple')
      await h.publishedStore.publish('user-1', { uid: 'todo-1', summary: 'One' })
      await h.publishedStore.publish('user-1', { uid: 'todo-2', summary: 'Two' })
      const response = await fetch(`${h.baseUrl}/dav/calendars/user-1/todos/`, {
        method: 'REPORT',
        headers: { authorization: basic(created.token), 'content-type': 'application/xml' },
        body:
          '<?xml version="1.0"?><C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
          '<D:href>/dav/calendars/user-1/todos/todo-2.ics</D:href>' +
          '<D:href>/dav/calendars/user-1/todos/missing.ics</D:href>' +
          '<D:href>/dav/calendars/other/todos/todo-1.ics</D:href></C:calendar-multiget>',
      })
      const body = await response.text()
      expect(response.status).toBe(207)
      expect(body).toContain('Two')
      expect(body).not.toContain('SUMMARY:One')
      expect(body.match(/404 Not Found/g)).toHaveLength(2)
    })

    it('deduplicates equivalent multiget hrefs so one item cannot amplify the response', async () => {
      h = await startHarness(true)
      const created = await h.tokenStore.create('user-1', 'Apple')
      await h.publishedStore.publish('user-1', { uid: 'todo-1', summary: 'One' })
      const response = await fetch(`${h.baseUrl}/dav/calendars/user-1/todos/`, {
        method: 'REPORT',
        headers: { authorization: basic(created.token), 'content-type': 'application/xml' },
        body:
          '<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
          '<D:href>/dav/calendars/user-1/todos/todo-1.ics</D:href>' +
          '<D:href>/dav/calendars/user-1/todos/%74odo-1.ics</D:href>' +
          '<D:href>/dav/calendars/user-1/todos/todo-1.ics</D:href></C:calendar-multiget>',
      })
      const body = await response.text()
      expect(response.status).toBe(207)
      expect(body.match(/SUMMARY:One/g)).toHaveLength(1)
    })

    it('never turns malformed, empty, or unrelated REPORT requests into a full-feed response', async () => {
      h = await startHarness(true)
      const created = await h.tokenStore.create('user-1', 'Apple')
      await h.publishedStore.publish('user-1', { uid: 'secret', summary: 'Must not leak' })
      const headers = { authorization: basic(created.token), 'content-type': 'application/xml' }
      const emptyMultiget = await fetch(`${h.baseUrl}/dav/calendars/user-1/todos/`, {
        method: 'REPORT',
        headers,
        body: '<C:calendar-multiget xmlns:C="urn:ietf:params:xml:ns:caldav"></C:calendar-multiget>',
      })
      const unrelatedPath = await fetch(`${h.baseUrl}/dav/not-a-calendar`, {
        method: 'REPORT',
        headers,
        body: '<C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav"></C:calendar-query>',
      })
      const unknownReport = await fetch(`${h.baseUrl}/dav/calendars/user-1/todos/`, {
        method: 'REPORT',
        headers,
        body: '<D:sync-collection xmlns:D="DAV:"></D:sync-collection>',
      })
      const malformedNesting = await fetch(`${h.baseUrl}/dav/calendars/user-1/todos/`, {
        method: 'REPORT',
        headers,
        body:
          '<C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav">' +
          '<C:filter><C:comp-filter name="VTODO"></C:filter></C:comp-filter></C:calendar-query>',
      })
      expect(emptyMultiget.status).toBe(400)
      expect(await emptyMultiget.text()).not.toContain('Must not leak')
      expect(unrelatedPath.status).toBe(404)
      expect(await unrelatedPath.text()).not.toContain('Must not leak')
      expect(unknownReport.status).toBe(400)
      expect(malformedNesting.status).toBe(400)
      expect(await malformedNesting.text()).not.toContain('Must not leak')
    })

    it('rejects XML entity declarations and unsupported time-range filters', async () => {
      h = await startHarness(true)
      const created = await h.tokenStore.create('user-1', 'Apple')
      const headers = { authorization: basic(created.token), 'content-type': 'application/xml' }
      const entity = await fetch(`${h.baseUrl}/dav/calendars/user-1/todos/`, {
        method: 'REPORT',
        headers,
        body: '<!DOCTYPE x [<!ENTITY y SYSTEM "file:///etc/passwd">]><C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav"></C:calendar-query>',
      })
      const timeRange = await fetch(`${h.baseUrl}/dav/calendars/user-1/todos/`, {
        method: 'REPORT',
        headers,
        body: '<C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav"><C:filter><C:time-range start="20260101T000000Z"/></C:filter></C:calendar-query>',
      })
      expect(entity.status).toBe(400)
      expect(timeRange.status).toBe(403)
      expect(await timeRange.text()).toContain('supported-filter')
    })
  })

  describe('GET and HEAD validators', () => {
    it('returns the same headers for GET and explicit HEAD, with no HEAD body', async () => {
      h = await startHarness(true)
      const created = await h.tokenStore.create('user-1', 'Apple')
      await h.publishedStore.publish('user-1', { uid: 'todo-1', summary: 'Buy milk' })
      const url = `${h.baseUrl}/dav/calendars/user-1/todos/todo-1.ics`
      const get = await fetch(url, { headers: { authorization: basic(created.token) } })
      const head = await fetch(url, { method: 'HEAD', headers: { authorization: basic(created.token) } })
      const body = await get.text()
      expect(get.status).toBe(200)
      expect(head.status).toBe(200)
      expect(head.headers.get('etag')).toBe(get.headers.get('etag'))
      expect(head.headers.get('content-length')).toBe(String(Buffer.byteLength(body, 'utf8')))
      expect(await head.text()).toBe('')
    })

    it('honors If-None-Match and If-Match and changes the strong ETag when content changes', async () => {
      h = await startHarness(true)
      const created = await h.tokenStore.create('user-1', 'Apple')
      await h.publishedStore.publish('user-1', { uid: 'todo-1', summary: 'Before' })
      const url = `${h.baseUrl}/dav/calendars/user-1/todos/todo-1.ics`
      const first = await fetch(url, { headers: { authorization: basic(created.token) } })
      const firstEtag = first.headers.get('etag') as string
      const notModified = await fetch(url, {
        headers: { authorization: basic(created.token), 'if-none-match': `W/${firstEtag}` },
      })
      const preconditionFailed = await fetch(url, {
        headers: { authorization: basic(created.token), 'if-match': '"not-current"' },
      })
      expect(notModified.status).toBe(304)
      expect(await notModified.text()).toBe('')
      expect(preconditionFailed.status).toBe(412)

      await h.publishedStore.publish('user-1', { uid: 'todo-1', summary: 'After' })
      const changed = await fetch(url, { headers: { authorization: basic(created.token) } })
      expect(changed.headers.get('etag')).not.toBe(firstEtag)
    })

    it('serves a deterministic whole-calendar representation with a collection ETag', async () => {
      h = await startHarness(true)
      const created = await h.tokenStore.create('user-1', 'Apple')
      await h.publishedStore.publish('user-1', { uid: 'z', summary: 'Z' })
      await h.publishedStore.publish('user-1', { uid: 'a', summary: 'A' })
      const response = await fetch(`${h.baseUrl}/dav/calendars/user-1/todos/`, {
        headers: { authorization: basic(created.token) },
      })
      const body = await response.text()
      expect(response.headers.get('etag')).toBeTruthy()
      expect(body.indexOf('UID:a')).toBeLessThan(body.indexOf('UID:z'))
    })

    it('returns 400 rather than throwing for a malformed encoded object path', async () => {
      h = await startHarness(true)
      const created = await h.tokenStore.create('user-1', 'Apple')
      const response = await fetch(`${h.baseUrl}/dav/calendars/user-1/todos/%E0%A4%A.ics`, {
        headers: { authorization: basic(created.token) },
      })
      expect([400, 404]).toContain(response.status)
      expect(response.status).not.toBe(500)
    })

    it('forwards async store failures to the error boundary', async () => {
      h = await startHarness(true)
      const created = await h.tokenStore.create('user-1', 'Apple')
      jest.spyOn(h.service, 'listTodos').mockRejectedValueOnce(new Error('store unavailable'))
      const response = await fetch(`${h.baseUrl}/dav/calendars/user-1/todos/`, {
        headers: { authorization: basic(created.token) },
      })
      expect(response.status).toBe(500)
      expect(await response.text()).toBe('Internal server error')
    })

    it('returns 413 for an oversized XML body instead of surfacing a parser failure as 500', async () => {
      h = await startHarness(true)
      const created = await h.tokenStore.create('user-1', 'Apple')
      const response = await fetch(`${h.baseUrl}/dav/calendars/user-1/todos/`, {
        method: 'REPORT',
        headers: { authorization: basic(created.token), 'content-type': 'application/xml' },
        body: `<C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav">${'x'.repeat(300 * 1024)}</C:calendar-query>`,
      })
      expect(response.status).toBe(413)
    })

    it('returns 405 plus an accurate Allow header for write attempts', async () => {
      h = await startHarness(true)
      const created = await h.tokenStore.create('user-1', 'Apple')
      const response = await fetch(`${h.baseUrl}/dav/calendars/user-1/todos/anything.ics`, {
        method: 'PUT',
        headers: { authorization: basic(created.token), 'content-type': 'text/calendar' },
        body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
      })
      expect(response.status).toBe(405)
      expect(response.headers.get('allow')).toBe('OPTIONS, GET, HEAD, PROPFIND')
    })
  })
})
