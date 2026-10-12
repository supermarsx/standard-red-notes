import { EventEmitter } from 'events'
import { promises as fs } from 'fs'
import { ClientRequest } from 'http'
import * as path from 'path'
import { inspect } from 'util'

import { Request, Response } from 'express'
import { RoleName, SettingName } from '@standardnotes/domain-core'

import { AdminDavBridgeController, DavBridgeController } from '../../Controller/v1/DavBridgeController'
import { DAV_RELAY_LIMITS } from './DavRelay'
import { BridgeHarness, buildBridge, newUserUuid, sentinel } from './DavBridgeTestKit.spec'

/**
 * Where an external account's secrets may and may not appear.
 *
 * A secrecy test passes trivially when the secret never entered the system,
 * when the sweep looked at nothing, or when the leak was in a place nobody
 * collected. So this one is built the other way round:
 *
 *   1. PLANT opaque sentinels as the password, a bearer token, a password
 *      inside a typed address, the username, a calendar path, a calendar name
 *      and an event title.
 *   2. EXERCISE them through every path that could spill: create, replace, a
 *      successful request, a 401, a timeout, a TLS failure, a redirect, an
 *      oversize answer and a policy refusal, plus malformed input.
 *   3. PROVE THE SECRET ARRIVED: the remote really received the password, the
 *      store really holds something that decrypts to it, the answer really
 *      carried the event title. Without this the rest proves nothing.
 *   4. PROVE THE SWEEP SAW SOMETHING: each collected surface is non-empty and
 *      contains a value that is supposed to be there.
 *   5. Only then assert, per sentinel, the surfaces it must be absent from.
 *
 * The API is driven through the real controllers with a recording response, so
 * "every response body" means every byte a client would have been sent.
 */

interface SentResponse {
  status: number
  body: unknown
  headers: Record<string, string>
}

function recordingResponse(locals: Record<string, unknown>): Response & { sent: SentResponse } {
  const sent: SentResponse = { status: 200, body: undefined, headers: {} }
  const emitter = new EventEmitter()
  const response = {
    locals,
    sent,
    headersSent: false,
    writableEnded: false,
    setHeader(name: string, value: string) {
      sent.headers[name.toLowerCase()] = String(value)
      return response
    },
    status(code: number) {
      sent.status = code
      return response
    },
    json(body: unknown) {
      // What a client receives is the serialised form, so that is what is kept.
      sent.body = JSON.parse(JSON.stringify(body)) as unknown
      response.headersSent = true
      response.writableEnded = true
      return response
    },
    end() {
      response.headersSent = true
      response.writableEnded = true
      return response
    },
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
  }
  return response as unknown as Response & { sent: SentResponse }
}

const containsAny = (haystack: string, windows: string[]): boolean =>
  windows.some((window) => haystack.includes(window))

describe('DAV bridge secrecy', () => {
  const password = sentinel('password')
  const replacement = sentinel('replacement')
  const bearer = sentinel('bearer')
  const urlPassword = sentinel('urlpassword')
  const username = sentinel('username')
  const calendarPath = sentinel('calendarpath')
  const calendarName = sentinel('calendarname')
  const eventTitle = sentinel('eventtitle')
  const redirectToken = sentinel('redirecttoken')
  const remoteHeader = sentinel('remoteheader')
  const certificateText = sentinel('certificate')
  const junkSecret = sentinel('junk')

  const user = newUserUuid()
  const admin = newUserUuid()
  const userLocals = {
    user: { uuid: user },
    settings: { [SettingName.NAMES.DavBridgeAllowed]: 'true' },
    readOnlyAccess: false,
  }
  const adminLocals = { user: { uuid: admin }, roles: [{ name: RoleName.NAMES.AdminUser }] }

  let bridge: BridgeHarness
  let controller: DavBridgeController
  let adminController: AdminDavBridgeController
  const responses: SentResponse[] = []
  const errors: unknown[] = []
  let adminBody = ''
  let storeBytes = ''
  let accountId = ''
  let bearerAccountId = ''

  const HOME = `/remote.php/dav/calendars/${username.value}/`
  const PRINCIPAL = `/remote.php/dav/principals/users/${username.value}/`
  const CALENDAR = `${HOME}${calendarPath.value}/`

  const call = async (
    action: (request: Request, response: Response) => Promise<void>,
    options: { body?: unknown; params?: Record<string, string>; locals?: Record<string, unknown> } = {},
  ): Promise<SentResponse> => {
    const response = recordingResponse(options.locals ?? userLocals)
    await action({ body: options.body, params: options.params ?? {} } as unknown as Request, response)
    responses.push(response.sent)
    return response.sent
  }

  const relay = (id: string, envelope: Record<string, unknown>): Promise<SentResponse> =>
    call((request, response) => controller.relay(request, response), { body: envelope, params: { accountId: id } })

  beforeAll(async () => {
    bridge = await buildBridge({
      // Long enough for eight megabytes to cross loopback on a busy machine,
      // so the oversize case ends on the size ceiling and not on the deadline.
      relayTimeoutMs: 2_500,
      dns: {
        'tls.example.org': ['93.184.216.40'],
        'lan.example.org': ['10.0.0.5'],
      },
      wrapFactory: (inner) => (protocol, options, onResponse) => {
        if (options.hostname === '93.184.216.40') {
          // A certificate failure whose text quotes the certificate, as Node's does.
          const request = new EventEmitter() as EventEmitter & {
            destroyed: boolean
            write(): void
            end(): void
            destroy(): void
          }
          request.destroyed = false
          request.write = (): void => undefined
          request.destroy = (): void => undefined
          request.end = (): void => {
            queueMicrotask(() =>
              request.emit(
                'error',
                Object.assign(new Error(`self-signed certificate; subject CN=${certificateText.value}`), {
                  code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
                }),
              ),
            )
          }
          return request as unknown as ClientRequest
        }
        return inner(protocol, options, onResponse)
      },
    })
    controller = new DavBridgeController(bridge.service, bridge.logger)
    adminController = new AdminDavBridgeController(bridge.service, bridge.logger)

    // --- create: Basic account whose password and username are sentinels
    const created = await call((request, response) => controller.createAccount(request, response), {
      body: { kind: 'nextcloud', url: 'https://cloud.example.org/', username: username.value, secret: password.value },
    })
    accountId = (created.body as { account: { id: string } }).account.id

    // --- create: a bearer account
    const bearerCreated = await call((request, response) => controller.createAccount(request, response), {
      body: {
        kind: 'caldav',
        url: 'https://cloud.example.org/',
        username: '',
        credentialKind: 'bearer',
        secret: bearer.value,
      },
    })
    bearerAccountId = (bearerCreated.body as { account: { id: string } }).account.id

    // --- create: a password inside the typed address (refused)
    await call((request, response) => controller.createAccount(request, response), {
      body: {
        kind: 'nextcloud',
        url: `https://someone:${urlPassword.value}@cloud.example.org/`,
        username: 'someone',
        secret: 'unused',
      },
    })

    // --- create: illegal secrets (a non-string, an object, a ten-megabyte string)
    for (const secret of [
      1234567890123,
      { password: junkSecret.value },
      [junkSecret.value],
      junkSecret.value.repeat(150_000),
    ]) {
      await call((request, response) => controller.createAccount(request, response), {
        body: { kind: 'nextcloud', url: 'https://cloud.example.org/', username: 'x', secret },
      })
    }

    // --- create: a policy refusal, with a sentinel in the path and the password
    await call((request, response) => controller.createAccount(request, response), {
      body: {
        kind: 'caldav',
        url: `http://lan.example.org/${calendarPath.value}/`,
        username: username.value,
        secret: password.value,
      },
    })

    // --- discovery, then pin
    bridge.remote.respond(() => ({ status: 207, body: '<d:multistatus/>' }))
    await relay(accountId, { method: 'PROPFIND', path: '/.well-known/caldav', headers: { depth: '0' } })
    await call((request, response) => controller.setPin(request, response), {
      body: { principalPath: PRINCIPAL, calendarHomePath: HOME },
      params: { accountId },
    })

    // --- a successful request whose answer carries a calendar name and an event title
    bridge.remote.respond(() => ({
      status: 207,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        ETag: '"etag-1"',
        'Set-Cookie': `nc_session=${remoteHeader.value}`,
        'WWW-Authenticate': `Basic realm="${remoteHeader.value}"`,
        'X-Debug-Token': remoteHeader.value,
      },
      body: `<d:multistatus><d:response><d:href>${CALENDAR}</d:href><d:displayname>${calendarName.value}</d:displayname><c:calendar-data>BEGIN:VEVENT\r\nSUMMARY:${eventTitle.value}\r\nEND:VEVENT</c:calendar-data></d:response></d:multistatus>`,
    }))
    await relay(accountId, {
      method: 'REPORT',
      path: CALENDAR,
      headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
      body: `<c:calendar-query><d:displayname>${calendarName.value}</d:displayname></c:calendar-query>`,
    })
    await relay(bearerAccountId, { method: 'PROPFIND', path: '/dav/', headers: { depth: '0' } })

    // --- a redirect inside the origin, then one to another origin carrying a token
    bridge.remote.respond((received) =>
      received.url === CALENDAR
        ? { status: 301, headers: { Location: `${CALENDAR}moved/` } }
        : { status: 207, body: '<ok/>' },
    )
    await relay(accountId, { method: 'PROPFIND', path: CALENDAR, headers: { depth: '0' } })
    bridge.remote.respond(() => ({
      status: 302,
      headers: {
        Location: `https://someone:${redirectToken.value}@elsewhere.example.net/dav/?token=${redirectToken.value}`,
      },
    }))
    await relay(accountId, { method: 'PROPFIND', path: CALENDAR, headers: { depth: '0' } })

    // --- refusals: outside the pin, a write, a bad path, a bad header
    await relay(accountId, { method: 'GET', path: `/remote.php/dav/files/${username.value}/${calendarPath.value}.txt` })
    await relay(accountId, {
      method: 'PUT',
      path: `${CALENDAR}x.ics`,
      headers: { 'content-type': 'text/calendar', 'if-none-match': '*' },
      body: `BEGIN:VEVENT\r\nSUMMARY:${eventTitle.value}\r\nEND:VEVENT`,
    })
    await relay(accountId, { method: 'GET', path: `${CALENDAR}../${calendarPath.value}` })
    await relay(accountId, { method: 'GET', path: CALENDAR, headers: { authorization: `Basic ${password.value}` } })

    // --- an oversize answer
    bridge.remote.respond(() => ({ status: 200, streamBytes: DAV_RELAY_LIMITS.responseBodyBytes + 128 * 1024 }))
    await relay(accountId, { method: 'GET', path: `${CALENDAR}big.ics` })

    // --- a timeout
    bridge.remote.respond(() => ({ hang: true }))
    await relay(accountId, { method: 'GET', path: `${CALENDAR}slow.ics` })

    // --- a TLS failure whose error text quotes a certificate
    const tls = await call((request, response) => controller.createAccount(request, response), {
      body: { kind: 'caldav', url: 'https://tls.example.org/', username: username.value, secret: password.value },
    })
    await relay((tls.body as { account: { id: string } }).account.id, {
      method: 'PROPFIND',
      path: `/${calendarPath.value}/`,
    })

    // --- a 401, with the remote echoing the credentials it was sent
    bridge.remote.respond((received) => ({
      status: 401,
      headers: { 'WWW-Authenticate': `Basic realm="${remoteHeader.value}"` },
      body: `rejected: ${String(received.headers.authorization)} ${password.value}`,
    }))
    await relay(accountId, { method: 'PROPFIND', path: CALENDAR, headers: { depth: '0' } })
    await relay(accountId, { method: 'PROPFIND', path: CALENDAR, headers: { depth: '0' } })

    // --- replace the secret, then use the new one
    await call((request, response) => controller.replaceSecret(request, response), {
      body: { secret: replacement.value },
      params: { accountId },
    })
    bridge.remote.respond(() => ({ status: 207, body: '<ok/>' }))
    await relay(accountId, { method: 'PROPFIND', path: CALENDAR, headers: { depth: '0' } })

    // --- the list, the config, and the administrator's view of all of it
    await call((request, response) => controller.listAccounts(request, response))
    await call((request, response) => controller.config(request, response))
    const adminView = await call((request, response) => adminController.view(request, response), {
      locals: adminLocals,
    })
    adminBody = JSON.stringify(adminView.body)

    // --- error objects, as thrown by the service
    for (const action of [
      () =>
        bridge.service.createAccount(
          { userUuid: user, permitted: true, readOnlySession: false, mcpScoped: false },
          {
            kind: 'nextcloud',
            url: `https://x:${urlPassword.value}@cloud.example.org/`,
            username: username.value,
            secret: password.value,
          },
        ),
      () =>
        bridge.service.relay({ userUuid: user, permitted: true, readOnlySession: false, mcpScoped: false }, accountId, {
          method: 'GET',
          path: `/outside/${calendarPath.value}`,
        }),
    ]) {
      try {
        await action()
      } catch (error) {
        errors.push(error)
      }
    }

    storeBytes = (
      await Promise.all(
        (await fs.readdir(path.join(bridge.dataPath, 'accounts'), { recursive: true, withFileTypes: true }))
          .filter((entry) => entry.isFile())
          .map((entry) => fs.readFile(path.join(entry.parentPath, entry.name), 'utf8')),
      )
    ).join('\n')
  }, 60_000)

  afterAll(async () => {
    await bridge.close()
  })

  const logText = (): string => bridge.logger.text()
  const responseText = (): string => JSON.stringify(responses)
  const errorText = (): string =>
    errors
      .map((error) => `${String(error)} ${JSON.stringify(error)} ${inspect(error, { depth: 10, showHidden: true })}`)
      .join('\n')

  describe('the secrets really were in play (without this the sweep proves nothing)', () => {
    it('the remote received the password, the replacement and the bearer token in Authorization', () => {
      const authorizations = bridge.remote.received.map((request) => String(request.headers.authorization))
      const decoded = authorizations
        .filter((header) => header.startsWith('Basic '))
        .map((header) => Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8'))

      expect(decoded).toContain(`${username.value}:${password.value}`)
      expect(decoded).toContain(`${username.value}:${replacement.value}`)
      expect(authorizations).toContain(`Bearer ${bearer.value}`)
    })

    it('the store holds envelopes that decrypt to the current secrets', async () => {
      const stored = await bridge.store.list(user)
      const main = stored.find((account) => account.id === accountId)
      const token = stored.find((account) => account.id === bearerAccountId)

      expect(main && bridge.cipher.open(main.secret, user, main.id).reveal()).toBe(replacement.value)
      expect(token && bridge.cipher.open(token.secret, user, token.id).reveal()).toBe(bearer.value)
    })

    it('the relay answer carried the calendar name and the event title to the owner', () => {
      const answers = responses.filter((sent) => sent.status === 200 && (sent.body as { remote?: unknown }).remote)

      expect(answers.length).toBeGreaterThanOrEqual(5)
      expect(JSON.stringify(answers)).toContain(eventTitle.value)
      expect(JSON.stringify(answers)).toContain(calendarName.value)
    })

    it('every kind of outcome the test set out to provoke actually happened', () => {
      const tags = responses.map((sent) => (sent.body as { error?: { tag?: string } } | undefined)?.error?.tag)

      for (const tag of [
        'dav-invalid-input',
        'dav-address-not-allowed',
        'dav-redirect-other-origin',
        'dav-path-not-allowed',
        'dav-writes-disabled',
        'dav-invalid-path',
        'dav-header-not-allowed',
        'dav-response-too-large',
        'dav-remote-timeout',
        'dav-tls-failed',
        'dav-password-rejected',
      ]) {
        expect(tags).toContain(tag)
      }
      expect(responses.filter((sent) => sent.status === 201)).toHaveLength(3)
    })
  })

  describe('the sweep looked at something (denominators)', () => {
    it('there are log lines at every level the bridge uses, including a debug line per relayed request', () => {
      const lines = bridge.logger.lines

      expect(lines.length).toBeGreaterThan(20)
      expect(
        lines.filter((line) => line.level === 'debug' && line.message === 'dav bridge request relayed').length,
      ).toBeGreaterThanOrEqual(5)
      expect(lines.filter((line) => line.message === 'dav bridge request refused').length).toBeGreaterThanOrEqual(8)
      expect(
        lines.some((line) => line.level === 'warn' && line.message === 'dav bridge account password rejected'),
      ).toBe(true)
      // A value that IS supposed to be logged is there, so the capture works.
      expect(logText()).toContain(user)
      expect(logText()).toContain(accountId)
    })

    it('there are response bodies, an administrator view, error objects and store bytes', () => {
      expect(responses.length).toBeGreaterThan(25)
      expect(adminBody).toContain(accountId)
      expect(adminBody).toContain('https://cloud.example.org')
      expect(errors).toHaveLength(2)
      expect(storeBytes.length).toBeGreaterThan(500)
      expect(storeBytes).toContain(accountId)
      expect(storeBytes).toContain('"ciphertext"')
    })
  })

  describe('a password or token appears nowhere outside the Authorization header and the ciphertext', () => {
    it.each([
      ['the password', password],
      ['the replacement password', replacement],
      ['the bearer token', bearer],
    ])('%s', (_label, marker) => {
      const base64 = [
        Buffer.from(marker.value).toString('base64').slice(0, 24),
        Buffer.from(`${username.value}:${marker.value}`).toString('base64').slice(0, 40),
        Buffer.from(marker.value).toString('hex').slice(0, 24),
      ]

      for (const [surface, text] of [
        ['logs', logText()],
        ['API response bodies', responseText()],
        ['the administrator view', adminBody],
        ['error objects', errorText()],
        ['the raw store bytes', storeBytes],
      ] as Array<[string, string]>) {
        expect([surface, containsAny(text, marker.windows)]).toEqual([surface, false])
        expect([surface, containsAny(text, base64)]).toEqual([surface, false])
      }
    })

    it.each([
      ['a password typed into the address', urlPassword],
      ['a secret sent in a shape that is not a secret', junkSecret],
      ['a token in a redirect the remote issued', redirectToken],
      ['text from a remote response header that is not passed on', remoteHeader],
      ['text from a certificate error', certificateText],
    ])('%s appears on no surface at all, the store included', (_label, marker) => {
      for (const [surface, text] of [
        ['logs', logText()],
        ['API response bodies', responseText()],
        ['the administrator view', adminBody],
        ['error objects', errorText()],
        ['the raw store bytes', storeBytes],
      ] as Array<[string, string]>) {
        expect([surface, containsAny(text, marker.windows)]).toEqual([surface, false])
      }
    })
  })

  describe('what identifies the external account stays with its owner', () => {
    it('the username is in the owner’s own views and the store, and in no log, no administrator view and no error', () => {
      // Where it is supposed to be.
      expect(responseText()).toContain(username.value)
      expect(storeBytes).toContain(username.value)

      expect(containsAny(logText(), username.windows)).toBe(false)
      expect(containsAny(adminBody, username.windows)).toBe(false)
      expect(containsAny(errorText(), username.windows)).toBe(false)
    })

    it('a calendar path is in the owner’s relay answers and in no log, administrator view, error or store file', () => {
      expect(responseText()).toContain(calendarPath.value)

      expect(containsAny(logText(), calendarPath.windows)).toBe(false)
      expect(containsAny(adminBody, calendarPath.windows)).toBe(false)
      expect(containsAny(errorText(), calendarPath.windows)).toBe(false)
      expect(containsAny(storeBytes, calendarPath.windows)).toBe(false)
    })

    it.each([
      ['a calendar name', calendarName],
      ['an event title', eventTitle],
    ])(
      '%s is in the owner’s relay answers and nowhere else: no log, administrator view, error or store file',
      (_label, marker) => {
        expect(responseText()).toContain(marker.value)

        expect(containsAny(logText(), marker.windows)).toBe(false)
        expect(containsAny(adminBody, marker.windows)).toBe(false)
        expect(containsAny(errorText(), marker.windows)).toBe(false)
        expect(containsAny(storeBytes, marker.windows)).toBe(false)
      },
    )

    it('content only ever leaves in a `remote` answer, never in a refusal', () => {
      const refusals = JSON.stringify(responses.filter((sent) => sent.status !== 200 && sent.status !== 201))

      expect(refusals.length).toBeGreaterThan(500)
      for (const marker of [calendarName, eventTitle, calendarPath, username]) {
        expect(containsAny(refusals, marker.windows)).toBe(false)
      }
    })
  })

  describe('log lines carry only the fields the design allows', () => {
    const ALLOWED = new Set([
      'userId',
      'accountId',
      'method',
      'status',
      'durationMs',
      'requestBytes',
      'responseBytes',
      'tag',
      'reason',
      'accounts',
    ])

    it('no line has a field outside the closed list, and every value is a short scalar', () => {
      const lines = bridge.logger.lines.filter((line) => line.message.startsWith('dav bridge'))
      expect(lines.length).toBeGreaterThan(20)

      for (const line of lines) {
        for (const [key, value] of Object.entries(line.meta ?? {})) {
          expect([line.message, key, ALLOWED.has(key)]).toEqual([line.message, key, true])
          expect(['string', 'number']).toContain(typeof value)
          expect(String(value).length).toBeLessThanOrEqual(64)
        }
      }
    })

    it('no line contains a path, a URL or a host name', () => {
      const text = logText()

      expect(text).not.toMatch(/remote\.php|\.well-known|\/dav\//)
      expect(text).not.toMatch(/https?:\/\//)
      expect(text).not.toContain('example.org')
      expect(text).not.toContain('Authorization')
      expect(text).not.toContain('Basic ')
      expect(text).not.toContain('Bearer ')
    })

    it('messages come from a fixed set', () => {
      expect([...new Set(bridge.logger.lines.map((line) => line.message))].sort()).toEqual(
        [
          'dav bridge account created',
          'dav bridge account password rejected',
          'dav bridge account pinned',
          'dav bridge account secret replaced',
          'dav bridge request refused',
          'dav bridge request relayed',
        ].sort(),
      )
    })
  })

  describe('an account view', () => {
    it('never has a key that could hold a secret, in any response that returned one', () => {
      const views = responses.flatMap((sent) => {
        const body = sent.body as
          { account?: Record<string, unknown>; accounts?: Array<Record<string, unknown>> } | undefined
        return [...(body?.account ? [body.account] : []), ...(body?.accounts ?? [])]
      })
      expect(views.length).toBeGreaterThanOrEqual(6)

      for (const view of views) {
        expect(Object.keys(view).sort()).toEqual(
          [
            'createdAt',
            'credentialKind',
            'discoveryOpenUntil',
            'entryPath',
            'id',
            'kind',
            'origin',
            'pin',
            'secretConfigured',
            'status',
            'updatedAt',
            'username',
          ].sort(),
        )
        expect(view.secretConfigured).toBe(true)
      }
    })
  })
})
