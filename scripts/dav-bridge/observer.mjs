// The independent observer for the DAV bridge test stack.
//
// Everything in this file talks to the CalDAV servers of
// dev/compose/docker-compose.dav-test.yml DIRECTLY, on their loopback host ports, and never
// through Standard Red Notes. That is the point of it: a check that reads a
// server's state through the code under test can only ever agree with that
// code. What the bridge did is judged from here.
//
// Three views of each server:
//   - its content, read with this file's own small CalDAV client;
//   - its ACCESS LOG (docker logs), which says what the server actually
//     received, from whom, and what it answered. "The relay refused" is then
//     "the server's log has no such request", not "the relay said so";
//   - for the canary, its hit counter.
//
// Used by scripts/verify-dav-bridge.mjs and by the browser scenarios.
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const OBSERVER_USER_AGENT = 'srn-dav-observer/1'
/** The User-Agent the bridge sends. Requests carrying it came through the relay. */
export const BRIDGE_USER_AGENT = 'StandardRedNotes-DavBridge/1'

const port = (name, fallback) => Number(process.env[name] ?? fallback)

/** The test stack as dev/compose/docker-compose.dav-test.yml defines it. Every password is a published fixture. */
export const DAVTEST = Object.freeze({
  project: 'srn-davtest',
  network: 'srn-davtest-net',
  servers: Object.freeze({
    radicale: Object.freeze({
      name: 'radicale',
      kind: 'caldav',
      container: 'srn-davtest-radicale-1',
      hostUrl: `http://127.0.0.1:${port('DAVTEST_RADICALE_PORT', 3993)}`,
      /** How an SRN container on the test network reaches it. */
      bridgeOrigin: 'http://radicale:5232',
      address: '10.250.77.11',
      users: Object.freeze({
        alice: 'alice-radicale-fixture-pw-3Vt',
        bob: 'bob-radicale-fixture-pw-9Lm',
      }),
      principalPath: (user) => `/${user}/`,
      homePath: (user) => `/${user}/`,
    }),
    nextcloud: Object.freeze({
      name: 'nextcloud',
      kind: 'nextcloud',
      container: 'srn-davtest-nextcloud-1',
      hostUrl: `http://127.0.0.1:${port('DAVTEST_NEXTCLOUD_PORT', 3994)}`,
      bridgeOrigin: 'http://nextcloud',
      address: '10.250.77.12',
      users: Object.freeze({
        alice: 'alice-nextcloud-fixture-pw-5Hd',
        bob: 'bob-nextcloud-fixture-pw-6Tz',
      }),
      principalPath: (user) => `/remote.php/dav/principals/users/${user}/`,
      homePath: (user) => `/remote.php/dav/calendars/${user}/`,
      filesPath: (user) => `/remote.php/dav/files/${user}/`,
    }),
    baikal: Object.freeze({
      name: 'baikal',
      kind: 'caldav',
      container: 'srn-davtest-baikal-1',
      hostUrl: `http://127.0.0.1:${port('DAVTEST_BAIKAL_PORT', 3995)}`,
      bridgeOrigin: 'http://baikal',
      address: '10.250.77.13',
      users: Object.freeze({
        alice: 'alice-baikal-fixture-pw-8Rc',
        bob: 'bob-baikal-fixture-pw-4Jx',
      }),
      principalPath: (user) => `/dav.php/principals/${user}/`,
      homePath: (user) => `/dav.php/calendars/${user}/`,
    }),
  }),
  canary: Object.freeze({
    container: 'srn-davtest-canary-1',
    hostUrl: `http://127.0.0.1:${port('DAVTEST_CANARY_PORT', 3996)}`,
    bridgeOrigin: 'http://canary:8080',
    address: '10.250.77.10',
  }),
})

export const sha256 = (value) => createHash('sha256').update(value).digest('hex')

/**
 * An opaque marker that cannot occur by accident. A sweep searches for 20
 * character windows from its start, middle and end, so a value that leaked
 * truncated or inside a longer string is still found.
 */
export function sentinel(label) {
  const value = `Zq7${label}${randomBytes(24).toString('hex')}Kx9`
  const middle = Math.floor((value.length - 20) / 2)
  return { value, windows: [value.slice(0, 20), value.slice(middle, middle + 20), value.slice(-20)] }
}

const basic = (user, password) => `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`

/**
 * Text is XML-escaped inside a multistatus body: sabre-based servers write an
 * ETag as `&quot;abc&quot;`, and the same ETag arrives in an HTTP header as
 * `"abc"`. Comparing the two means decoding the first.
 */
const decodeXmlText = (text) =>
  text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

const xmlText = (source, tag) => {
  const match = new RegExp(`<(?:[A-Za-z0-9]+:)?${tag}[^>]*>([^<]*)</(?:[A-Za-z0-9]+:)?${tag}>`, 'i').exec(source)
  return match ? decodeXmlText(match[1]) : undefined
}

/** Splits a multistatus body into its <response> elements, as text. */
export function multistatusResponses(body) {
  return [...body.matchAll(/<(?:[A-Za-z0-9]+:)?response[\s>][\s\S]*?<\/(?:[A-Za-z0-9]+:)?response>/gi)].map(
    (match) => match[0],
  )
}

export const hrefOf = (response) => xmlText(response, 'href')
export const etagOf = (response) => xmlText(response, 'getetag')

/** A direct CalDAV client for ONE user on ONE server. It never goes near SRN. */
export class DavObserver {
  constructor(server, user, password = server.users[user]) {
    this.server = server
    this.user = user
    this.authorization = basic(user, password)
    this.homePath = server.homePath(user)
    this.principalPath = server.principalPath(user)
  }

  async request(method, path, { headers = {}, body } = {}) {
    const response = await fetch(`${this.server.hostUrl}${path}`, {
      method,
      redirect: 'manual',
      headers: { 'user-agent': OBSERVER_USER_AGENT, authorization: this.authorization, ...headers },
      body,
    })
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.text(),
    }
  }

  async mkcalendar(path, displayName, components = ['VEVENT']) {
    const answer = await this.request('MKCALENDAR', path, {
      headers: { 'content-type': 'application/xml; charset=utf-8' },
      body:
        '<?xml version="1.0" encoding="utf-8"?>' +
        '<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop>' +
        `<d:displayname>${displayName}</d:displayname>` +
        `<c:supported-calendar-component-set>${components.map((name) => `<c:comp name="${name}"/>`).join('')}</c:supported-calendar-component-set>` +
        '</d:prop></d:set></c:mkcalendar>',
    })
    if (answer.status !== 201) {
      throw new Error(`observer: MKCALENDAR ${path} on ${this.server.name} answered ${answer.status}`)
    }
  }

  async put(path, ics, headers = {}) {
    const answer = await this.request('PUT', path, {
      headers: { 'content-type': 'text/calendar; charset=utf-8', ...headers },
      body: ics,
    })
    if (answer.status !== 201 && answer.status !== 204) {
      throw new Error(`observer: PUT ${path} on ${this.server.name} answered ${answer.status}`)
    }
    return answer
  }

  /** hrefs of the calendar collections directly under the user's home. */
  async listCollections() {
    const answer = await this.request('PROPFIND', this.homePath, {
      headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
      body:
        '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:displayname/></d:prop></d:propfind>',
    })
    if (answer.status !== 207) {
      throw new Error(`observer: PROPFIND ${this.homePath} on ${this.server.name} answered ${answer.status}`)
    }
    return multistatusResponses(answer.body)
      .filter((response) => /<(?:[A-Za-z0-9]+:)?calendar[\s/>]/i.test(response))
      .map((response) => ({ href: hrefOf(response), displayName: xmlText(response, 'displayname') }))
      .filter((entry) => entry.href !== undefined)
  }

  /** `[{ href, etag }]` of every object in a collection, sorted by href. */
  async listObjects(collectionPath) {
    const answer = await this.request('PROPFIND', collectionPath, {
      headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
      body:
        '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:resourcetype/></d:prop></d:propfind>',
    })
    if (answer.status !== 207) {
      throw new Error(`observer: PROPFIND ${collectionPath} on ${this.server.name} answered ${answer.status}`)
    }
    return multistatusResponses(answer.body)
      .map((response) => ({ href: hrefOf(response), etag: etagOf(response) }))
      .filter((entry) => entry.href !== undefined && entry.href.endsWith('.ics'))
      .sort((left, right) => left.href.localeCompare(right.href))
  }

  /** The exact state of a collection: every object's href, ETag and a digest of its bytes. */
  async snapshot(collectionPath) {
    const objects = await this.listObjects(collectionPath)
    const snapshot = []
    for (const object of objects) {
      const answer = await this.request('GET', object.href)
      if (answer.status !== 200) {
        throw new Error(`observer: GET ${object.href} on ${this.server.name} answered ${answer.status}`)
      }
      snapshot.push({ href: object.href, etag: object.etag, digest: sha256(answer.body), body: answer.body })
    }
    return snapshot
  }

  /** Removes every collection whose last segment starts with `prefix`. Returns how many. */
  async removeCollections(prefix) {
    let removed = 0
    for (const { href } of await this.listCollections()) {
      const name = href.replace(/\/$/, '').split('/').pop() ?? ''
      if (name.startsWith(prefix)) {
        const answer = await this.request('DELETE', href)
        if (answer.status !== 204 && answer.status !== 200 && answer.status !== 404) {
          throw new Error(`observer: DELETE ${href} on ${this.server.name} answered ${answer.status}`)
        }
        removed += 1
      }
    }
    return removed
  }
}

const pad = (value) => String(value).padStart(2, '0')

/**
 * One event that exercises what a careless relay or parser gets wrong: a long
 * line that must be folded, non-ASCII text, an alarm, and a property this app
 * has never heard of.
 */
export function fixtureEvent(index, title) {
  const uid = `srnfx-${index}-${randomBytes(6).toString('hex')}@davtest.invalid`
  const day = pad((index % 27) + 1)
  const long = `A deliberately long description so that this line has to be folded by the server: ${'lorem ipsum dolor sit amet '.repeat(6)}`
  const fold = (line) => line.match(/.{1,73}/gu).join('\r\n ')
  return {
    uid,
    fileName: `srnfx-${index}.ics`,
    ics: [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Standard Red Notes//dav-test observer//EN',
      'BEGIN:VEVENT',
      `UID:${uid}`,
      'DTSTAMP:20261001T080000Z',
      `DTSTART:202611${day}T${pad(8 + (index % 9))}0000Z`,
      `DTEND:202611${day}T${pad(9 + (index % 9))}0000Z`,
      `SUMMARY:${title}`,
      fold(`DESCRIPTION:${long}`),
      'LOCATION:Café 会议室 — Zimmer 3',
      `X-SRN-FIXTURE:${index}`,
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'DESCRIPTION:Reminder',
      'TRIGGER:-PT15M',
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n'),
  }
}

export function fixtureTask(index, title) {
  const uid = `srnfx-task-${index}-${randomBytes(6).toString('hex')}@davtest.invalid`
  return {
    uid,
    fileName: `srnfx-task-${index}.ics`,
    ics: [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Standard Red Notes//dav-test observer//EN',
      'BEGIN:VTODO',
      `UID:${uid}`,
      'DTSTAMP:20261001T080000Z',
      `SUMMARY:${title}`,
      `DUE;VALUE=DATE:202611${pad((index % 27) + 1)}`,
      'STATUS:NEEDS-ACTION',
      'PRIORITY:5',
      'END:VTODO',
      'END:VCALENDAR',
      '',
    ].join('\r\n'),
  }
}

/**
 * What a server's access log says it received since `since`: one entry per
 * request, `{ method, path, status, userAgent }`. Radicale logs the request and
 * its answer on two lines, which are paired here in order.
 */
export async function accessLog(server, since) {
  const { stdout, stderr } = await run(
    'docker',
    ['logs', '--since', new Date(since.getTime() - 1000).toISOString(), server.container],
    { maxBuffer: 64 * 1024 * 1024 },
  )
  const lines = `${stdout}\n${stderr}`.split('\n')
  const entries = []

  if (server.name === 'radicale') {
    const pending = []
    for (const line of lines) {
      const request = /\] ([A-Z]+) request for '([^']*)'(?: with depth '[^']*')? received from \S+(?: using '([^']*)')?/.exec(line)
      if (request) {
        const entry = { method: request[1], path: request[2], status: undefined, userAgent: request[3] ?? '' }
        pending.push(entry)
        entries.push(entry)
        continue
      }
      const answer = /\] ([A-Z]+) response status for '([^']*)'.*: (\d{3}) /.exec(line)
      if (answer) {
        const index = pending.findIndex((entry) => entry.method === answer[1] && entry.path === answer[2])
        if (index >= 0) {
          pending[index].status = Number(answer[3])
          pending.splice(index, 1)
        }
      }
    }
    return entries
  }

  // Apache (Nextcloud) and nginx (Baikal) both write the combined format.
  for (const line of lines) {
    const match = /"([A-Z]+) (\S+) HTTP\/[0-9.]+" (\d{3}) \S+ "[^"]*" "([^"]*)"/.exec(line)
    if (match) {
      entries.push({
        method: match[1],
        path: match[2].split('?')[0],
        status: Number(match[3]),
        userAgent: match[4],
      })
    }
  }
  return entries
}

/** Only the requests that came through the bridge. */
export const fromBridge = (entries) => entries.filter((entry) => entry.userAgent.includes(BRIDGE_USER_AGENT))

export async function canaryHits() {
  const response = await fetch(`${DAVTEST.canary.hostUrl}/__hits`, { headers: { 'user-agent': OBSERVER_USER_AGENT } })
  return (await response.json()).hits
}

export async function canaryReset() {
  await fetch(`${DAVTEST.canary.hostUrl}/__reset`, { method: 'POST', headers: { 'user-agent': OBSERVER_USER_AGENT } })
}

/**
 * A Nextcloud app password for a fixture user, minted the way a person without
 * a browser would: the OCS endpoint that trades a login password for one.
 * (`occ user:auth-tokens:add` exists for this and is broken in 33.0.9.)
 */
export async function mintNextcloudAppPassword(user) {
  const server = DAVTEST.servers.nextcloud
  const response = await fetch(`${server.hostUrl}/ocs/v2.php/core/getapppassword`, {
    headers: {
      'user-agent': OBSERVER_USER_AGENT,
      authorization: basic(user, server.users[user]),
      'ocs-apirequest': 'true',
      accept: 'application/json',
    },
  })
  const payload = await response.json().catch(() => undefined)
  const password = payload?.ocs?.data?.apppassword
  if (response.status !== 200 || typeof password !== 'string' || password.length < 20) {
    throw new Error(`observer: Nextcloud did not mint an app password for ${user} (HTTP ${response.status})`)
  }
  return password
}

/** Runs `occ` inside the Nextcloud fixture. */
export async function nextcloudOcc(...args) {
  const { stdout } = await run('docker', ['exec', '-u', 'www-data', DAVTEST.servers.nextcloud.container, 'php', 'occ', ...args])
  return stdout
}

/**
 * Brings the Nextcloud fixture to the state the suites expect. Safe to repeat.
 *
 * The image installs an empty server with one administrator. The fixture users
 * and two settings are added here, through `occ`, so that a container created
 * from nothing ends up the same as the one the suites were written against.
 * (Radicale and Baikal get their users from files under e2e/dav-fixtures.)
 *
 * The two settings lift Nextcloud's own limit on creating calendars, ten an
 * hour for each user by default. A suite that creates collections meets that
 * limit as a 429 on MKCALENDAR, which says nothing about the bridge.
 *
 * `container` is only for trying this against a throwaway container.
 */
export async function prepareNextcloudFixture({ container = DAVTEST.servers.nextcloud.container } = {}) {
  const occ = (args, environment = []) =>
    run('docker', ['exec', '-u', 'www-data', ...environment.flatMap((pair) => ['-e', pair]), container, 'php', 'occ', ...args])
  const created = []
  for (const [user, password] of Object.entries(DAVTEST.servers.nextcloud.users)) {
    const known = await occ(['user:info', user]).then(
      () => true,
      () => false,
    )
    if (!known) {
      // A fixture password, published in this repository; `occ` takes it from
      // the environment and from nowhere else.
      await occ(['user:add', '--password-from-env', user], [`OC_PASS=${password}`])
      created.push(user)
    }
  }
  await occ(['config:app:set', 'dav', 'rateLimitCalendarCreation', '--value=100000'])
  await occ(['config:app:set', 'dav', 'rateLimitPeriodCalendarCreation', '--value=1'])
  return { created }
}

/**
 * Nextcloud slows down an ADDRESS after failed sign-ins. A suite that provokes
 * failures on purpose clears the record for the addresses it used, so that one
 * scenario's rejected password does not become the next scenario's timeout.
 */
export async function nextcloudForgetFailedSignIns(addresses) {
  for (const address of addresses) {
    await nextcloudOcc('security:bruteforce:reset', address).catch(() => undefined)
  }
}

/** The addresses a container has, one per network it is attached to. */
export async function containerAddresses(container) {
  const { stdout } = await run('docker', [
    'inspect',
    '--format',
    '{{range $name, $network := .NetworkSettings.Networks}}{{$name}}={{$network.IPAddress}} {{end}}',
    container,
  ])
  return Object.fromEntries(
    stdout
      .trim()
      .split(/\s+/)
      .filter((entry) => entry.includes('='))
      .map((entry) => entry.split('=')),
  )
}
