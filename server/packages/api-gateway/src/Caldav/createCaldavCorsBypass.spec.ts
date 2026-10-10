import 'reflect-metadata'

import cors from 'cors'
import express, { NextFunction, Request, Response } from 'express'
import * as http from 'http'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AddressInfo } from 'net'

import { createCaldavCorsBypass } from './createCaldavCorsBypass'
import { createCaldavRouter } from './createCaldavRouter'
import { CaldavService } from '../Service/Caldav/CaldavService'
import { CaldavTokenStore } from '../Service/Caldav/CaldavTokenStore'
import { CalendarProjectionStore } from '../Service/Caldav/CalendarProjectionStore'
import { PublishedCalendarStore } from '../Service/Caldav/PublishedCalendarStore'

/**
 * The CalDAV router's OPTIONS response, with the REAL app-wide `cors()`
 * middleware in front of it.
 *
 * The existing router spec mounts the router on a bare Express app, where
 * OPTIONS answers correctly. On a real deployment `cors()` sits in front with
 * the package default `preflightContinue: false`, answers every OPTIONS with a
 * 204 and ends the request — so the `DAV:` and `Allow` headers a calendar client
 * reads during account setup never reach it, and the client refuses to add the
 * account. This file is the harness that can see that: the "without the bypass"
 * case below asserts the broken behaviour explicitly so the fix cannot be
 * removed silently.
 */

interface Harness {
  baseUrl: string
  token: string
  server: http.Server
  dir: string
}

const BASE = '/dav'
const USER = 'user-1'

async function startHarness(options: { bypass: boolean; basePath?: string }): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'caldav-cors-'))
  const tokenStore = new CaldavTokenStore(path.join(dir, 'tokens.json'))
  const projectionStore = new CalendarProjectionStore(path.join(dir, 'projection.json'))
  const service = new CaldavService(
    true,
    tokenStore,
    new PublishedCalendarStore(path.join(dir, 'published.json')),
    projectionStore,
  )
  await projectionStore.setForUser(USER, { enabled: true })
  const created = await tokenStore.create(USER, 'Phone')

  // `origin: true` reflects the request Origin. A callback-style origin
  // function would have to invoke its callback; one that merely returns a value
  // leaves the request hanging, which reads as a timeout rather than a verdict.
  const corsMiddleware = cors({ credentials: true, origin: true }) as never
  const app = express()
  app.use(options.bypass ? createCaldavCorsBypass(corsMiddleware, options.basePath ?? BASE) : corsMiddleware)
  app.use(BASE, createCaldavRouter(service, { basePath: BASE }))
  app.use((_error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    response.status(500).send('Internal server error')
  })
  const server = await new Promise<http.Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance))
  })
  const port = (server.address() as AddressInfo).port
  return { baseUrl: `http://127.0.0.1:${port}`, token: created.token, server, dir }
}

function basic(token: string): string {
  return 'Basic ' + Buffer.from(`caldav:${token}`).toString('base64')
}

describe('createCaldavCorsBypass', () => {
  let h: Harness | undefined

  afterEach(async () => {
    if (h) {
      await new Promise<void>((resolve) => h?.server.close(() => resolve()))
      await fs.rm(h.dir, { recursive: true, force: true })
      h = undefined
    }
  })

  const optionsOn = async (harness: Harness, pathname: string) => {
    const response = await fetch(`${harness.baseUrl}${pathname}`, {
      method: 'OPTIONS',
      headers: { authorization: basic(harness.token) },
    })
    return { status: response.status, dav: response.headers.get('dav'), allow: response.headers.get('allow') }
  }

  it('WITHOUT the bypass, cors() swallows the CalDAV OPTIONS response', async () => {
    h = await startHarness({ bypass: false })
    const result = await optionsOn(h, `${BASE}/calendars/${USER}/events/`)
    expect(result.status).toBe(204)
    // This is the whole bug: no DAV compliance class, so a client concludes the
    // URL is not a CalDAV server.
    expect(result.dav).toBeNull()
    expect(result.allow).not.toBe('OPTIONS, GET, HEAD, PROPFIND, REPORT')
  })

  it('WITH the bypass, the router answers with its DAV and Allow headers', async () => {
    h = await startHarness({ bypass: true })
    for (const pathname of [
      `${BASE}/`,
      `${BASE}/calendars/${USER}/`,
      `${BASE}/calendars/${USER}/todos/`,
      `${BASE}/calendars/${USER}/events/`,
    ]) {
      const result = await optionsOn(h, pathname)
      expect(result.status).toBe(200)
      expect(result.dav).toBe('1, calendar-access')
      expect(result.allow).not.toBeNull()
    }
  })

  it('answers the exact base path too, not only paths beneath it', async () => {
    h = await startHarness({ bypass: true })
    const response = await fetch(`${h.baseUrl}${BASE}`, {
      method: 'OPTIONS',
      headers: { authorization: basic(h.token) },
    })
    // Express redirects the exact mount path to its trailing-slash form; either
    // way the request must not have been answered as a CORS preflight.
    expect([200, 301, 308]).toContain(response.status)
    expect(response.headers.get('access-control-allow-credentials')).toBeNull()
  })

  it('still challenges an unauthenticated OPTIONS rather than letting CORS answer it', async () => {
    h = await startHarness({ bypass: true })
    const response = await fetch(`${h.baseUrl}${BASE}/calendars/${USER}/events/`, { method: 'OPTIONS' })
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain('Basic')
  })

  it('does NOT sweep in a path that merely starts with the same letters', async () => {
    h = await startHarness({ bypass: true })
    const response = await fetch(`${h.baseUrl}/davsomething`, {
      method: 'OPTIONS',
      headers: { authorization: basic(h.token), origin: 'http://example.test' },
    })
    // Handled by cors(), which is correct for anything outside the mount.
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-credentials')).toBe('true')
  })

  it('leaves every non-CalDAV request to cors()', async () => {
    h = await startHarness({ bypass: true })
    const response = await fetch(`${h.baseUrl}/v1/anything`, {
      method: 'OPTIONS',
      headers: { origin: 'http://example.test' },
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('http://example.test')
  })

  it('follows a custom base path', async () => {
    h = await startHarness({ bypass: true, basePath: '/dav/' })
    const result = await optionsOn(h, `${BASE}/calendars/${USER}/events/`)
    expect(result.dav).toBe('1, calendar-access')
  })

  it('refuses an unsafe base path at construction rather than bypassing everything', () => {
    const corsMiddleware = cors() as never
    for (const unsafe of ['/', '', 'dav', '/dav/../etc', '/da v']) {
      expect(() => createCaldavCorsBypass(corsMiddleware, unsafe)).toThrow()
    }
  })
})
