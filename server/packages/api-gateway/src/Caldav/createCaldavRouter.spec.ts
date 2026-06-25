import 'reflect-metadata'

import express from 'express'
import * as http from 'http'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AddressInfo } from 'net'

import { createCaldavRouter } from './createCaldavRouter'
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
}

async function startHarness(enabled: boolean): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'caldav-router-'))
  const tokenStore = new CaldavTokenStore(path.join(dir, 'tokens.json'))
  const publishedStore = new PublishedCalendarStore(path.join(dir, 'published.json'))
  const service = new CaldavService(enabled, tokenStore, publishedStore)

  const app = express()
  app.use('/dav', createCaldavRouter(service, { basePath: '/dav' }))
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  const port = (server.address() as AddressInfo).port
  return { baseUrl: `http://127.0.0.1:${port}`, service, tokenStore, publishedStore, server, dir }
}

function basic(token: string): string {
  return 'Basic ' + Buffer.from(`caldav:${token}`).toString('base64')
}

describe('createCaldavRouter', () => {
  let h: Harness

  afterEach(async () => {
    await new Promise<void>((resolve) => h.server.close(() => resolve()))
    await fs.rm(h.dir, { recursive: true, force: true })
  })

  describe('feature gating', () => {
    it('404s every request when the master switch is off', async () => {
      h = await startHarness(false)
      const created = await h.tokenStore.create('user-1', 'x')
      const res = await fetch(`${h.baseUrl}/dav/`, {
        method: 'OPTIONS',
        headers: { authorization: basic(created.token) },
      })
      expect(res.status).toBe(404)
    })
  })

  describe('authentication', () => {
    beforeEach(async () => {
      h = await startHarness(true)
    })

    it('challenges with 401 + WWW-Authenticate when no credentials are sent', async () => {
      const res = await fetch(`${h.baseUrl}/dav/`, { method: 'OPTIONS' })
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toMatch(/Basic/)
    })

    it('rejects an invalid token with 401', async () => {
      const res = await fetch(`${h.baseUrl}/dav/`, {
        method: 'OPTIONS',
        headers: { authorization: basic('bogus.token') },
      })
      expect(res.status).toBe(401)
    })

    it('accepts a valid scoped token', async () => {
      const created = await h.tokenStore.create('user-1', 'Apple')
      const res = await fetch(`${h.baseUrl}/dav/`, {
        method: 'OPTIONS',
        headers: { authorization: basic(created.token) },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('dav')).toMatch(/calendar-access/)
      expect(res.headers.get('allow')).toMatch(/PROPFIND/)
    })
  })

  describe('PROPFIND', () => {
    it('returns principal info with a calendar-home-set at the service root', async () => {
      h = await startHarness(true)
      const created = await h.tokenStore.create('user-1', 'Apple')
      const res = await fetch(`${h.baseUrl}/dav/`, {
        method: 'PROPFIND',
        headers: { authorization: basic(created.token), depth: '0' },
      })
      const body = await res.text()
      expect(res.status).toBe(207)
      expect(body).toContain('calendar-home-set')
      expect(body).toContain('/dav/calendars/user-1/')
    })

    it('advertises VTODO supported-calendar-component-set on the calendar collection', async () => {
      h = await startHarness(true)
      const created = await h.tokenStore.create('user-1', 'Apple')
      const res = await fetch(`${h.baseUrl}/dav/calendars/user-1/todos/`, {
        method: 'PROPFIND',
        headers: { authorization: basic(created.token), depth: '0' },
      })
      const body = await res.text()
      expect(res.status).toBe(207)
      expect(body).toContain('supported-calendar-component-set')
      expect(body).toContain('VTODO')
      expect(body).toContain('sync-token')
    })

    it('lists published object hrefs with Depth: 1', async () => {
      h = await startHarness(true)
      const created = await h.tokenStore.create('user-1', 'Apple')
      await h.publishedStore.publish('user-1', { uid: 'todo-1', summary: 'Buy milk' })
      const res = await fetch(`${h.baseUrl}/dav/calendars/user-1/todos/`, {
        method: 'PROPFIND',
        headers: { authorization: basic(created.token), depth: '1' },
      })
      const body = await res.text()
      expect(body).toContain('/dav/calendars/user-1/todos/todo-1.ics')
      expect(body).toContain('getetag')
    })

    it('forbids addressing another user calendar', async () => {
      h = await startHarness(true)
      const created = await h.tokenStore.create('user-1', 'Apple')
      const res = await fetch(`${h.baseUrl}/dav/calendars/someone-else/todos/`, {
        method: 'PROPFIND',
        headers: { authorization: basic(created.token), depth: '0' },
      })
      expect(res.status).toBe(403)
    })
  })

  describe('REPORT', () => {
    it('returns published VTODOs as calendar-data via calendar-query', async () => {
      h = await startHarness(true)
      const created = await h.tokenStore.create('user-1', 'Apple')
      await h.publishedStore.publish('user-1', { uid: 'todo-1', summary: 'Buy milk', due: '2026-06-30T00:00:00Z' })
      const res = await fetch(`${h.baseUrl}/dav/calendars/user-1/todos/`, {
        method: 'REPORT',
        headers: { authorization: basic(created.token), 'content-type': 'application/xml', depth: '1' },
        body:
          '<?xml version="1.0"?><C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav"><C:filter><C:comp-filter name="VCALENDAR"/></C:filter></C:calendar-query>',
      })
      const body = await res.text()
      expect(res.status).toBe(207)
      expect(body).toContain('calendar-data')
      // XML-escaped iCalendar content.
      expect(body).toContain('BEGIN:VCALENDAR')
      expect(body).toContain('Buy milk')
    })

    it('filters to requested hrefs via calendar-multiget', async () => {
      h = await startHarness(true)
      const created = await h.tokenStore.create('user-1', 'Apple')
      await h.publishedStore.publish('user-1', { uid: 'todo-1', summary: 'One' })
      await h.publishedStore.publish('user-1', { uid: 'todo-2', summary: 'Two' })
      const res = await fetch(`${h.baseUrl}/dav/calendars/user-1/todos/`, {
        method: 'REPORT',
        headers: { authorization: basic(created.token), 'content-type': 'application/xml' },
        body:
          '<?xml version="1.0"?><C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
          '<D:href>/dav/calendars/user-1/todos/todo-2.ics</D:href></C:calendar-multiget>',
      })
      const body = await res.text()
      expect(body).toContain('Two')
      expect(body).not.toContain('One')
    })
  })

  describe('GET', () => {
    it('returns a single VTODO object with an ETag', async () => {
      h = await startHarness(true)
      const created = await h.tokenStore.create('user-1', 'Apple')
      await h.publishedStore.publish('user-1', { uid: 'todo-1', summary: 'Buy milk' })
      const res = await fetch(`${h.baseUrl}/dav/calendars/user-1/todos/todo-1.ics`, {
        headers: { authorization: basic(created.token) },
      })
      const body = await res.text()
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toMatch(/text\/calendar/)
      expect(res.headers.get('etag')).toBeTruthy()
      expect(body).toContain('BEGIN:VTODO')
      expect(body).toContain('SUMMARY:Buy milk')
    })

    it('404s an unknown object', async () => {
      h = await startHarness(true)
      const created = await h.tokenStore.create('user-1', 'Apple')
      const res = await fetch(`${h.baseUrl}/dav/calendars/user-1/todos/missing.ics`, {
        headers: { authorization: basic(created.token) },
      })
      expect(res.status).toBe(404)
    })
  })
})
