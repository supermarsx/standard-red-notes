import 'reflect-metadata'

import { EventEmitter } from 'events'
import { Request, Response } from 'express'
import { RoleName, SettingName } from '@standardnotes/domain-core'

import { davRefusal } from '../../Service/DavBridge/DavBridgeRefusal'
import { DavBridgeCaller, DavBridgeService } from '../../Service/DavBridge/DavBridgeService'
import { DavRelayAbortedError } from '../../Service/DavBridge/DavRelay'
import { AdminDavBridgeController, DavBridgeController } from './DavBridgeController'

const USER = '11111111-1111-4111-8111-111111111111'
const OTHER_USER = '22222222-2222-4222-8222-222222222222'
const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

type FakeResponse = Response & {
  sentStatus: number
  sentBody: unknown
  sentHeaders: Record<string, string>
  ended: boolean
  jsonCalls: number
  emitter: EventEmitter
}

function fakeResponse(locals: Record<string, unknown>): FakeResponse {
  const emitter = new EventEmitter()
  const response = {
    locals,
    sentStatus: 200,
    sentBody: undefined as unknown,
    sentHeaders: {} as Record<string, string>,
    ended: false,
    jsonCalls: 0,
    headersSent: false,
    writableEnded: false,
    emitter,
    setHeader(name: string, value: string) {
      response.sentHeaders[name.toLowerCase()] = String(value)
      return response
    },
    status(code: number) {
      response.sentStatus = code
      return response
    },
    json(body: unknown) {
      response.sentBody = body
      response.jsonCalls += 1
      response.headersSent = true
      response.writableEnded = true
      return response
    },
    end() {
      response.ended = true
      response.headersSent = true
      response.writableEnded = true
      return response
    },
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
  }
  return response as unknown as FakeResponse
}

const request = (body?: unknown, params: Record<string, string> = {}): Request =>
  ({ body, params }) as unknown as Request

const userLocals = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  user: { uuid: USER },
  settings: { [SettingName.NAMES.DavBridgeAllowed]: 'true' },
  readOnlyAccess: false,
  ...overrides,
})

const serviceMock = (): jest.Mocked<
  Pick<
    DavBridgeService,
    | 'config'
    | 'listAccounts'
    | 'createAccount'
    | 'replaceSecret'
    | 'setPin'
    | 'deleteAccount'
    | 'deleteAllAccounts'
    | 'relay'
    | 'adminView'
    | 'adminUpdate'
    | 'purgeUser'
    | 'purgeAll'
  >
> => ({
  config: jest.fn().mockResolvedValue({ enabled: true }),
  listAccounts: jest.fn().mockResolvedValue([{ id: ACCOUNT }]),
  createAccount: jest.fn().mockResolvedValue({ id: ACCOUNT }),
  replaceSecret: jest.fn().mockResolvedValue({ id: ACCOUNT, status: 'unverified' }),
  setPin: jest.fn().mockResolvedValue({ id: ACCOUNT, pin: {} }),
  deleteAccount: jest.fn().mockResolvedValue(undefined),
  deleteAllAccounts: jest.fn().mockResolvedValue(2),
  relay: jest.fn().mockResolvedValue({ remote: { status: 207 } }),
  adminView: jest.fn().mockResolvedValue({ settings: { enabled: true }, users: [] }),
  adminUpdate: jest.fn().mockResolvedValue(['davBridge.enabled']),
  purgeUser: jest.fn().mockResolvedValue({ purgedUsers: 1, purgedAccounts: 2 }),
  purgeAll: jest.fn().mockResolvedValue({ purgedUsers: 3, purgedAccounts: 4 }),
})

describe('DavBridgeController', () => {
  let service: ReturnType<typeof serviceMock>
  let logger: { error: jest.Mock; info: jest.Mock }
  let controller: DavBridgeController

  const expectedCaller: DavBridgeCaller = { userUuid: USER, permitted: true, readOnlySession: false, mcpScoped: false }

  beforeEach(() => {
    service = serviceMock()
    logger = { error: jest.fn(), info: jest.fn() }
    controller = new DavBridgeController(service as unknown as DavBridgeService, logger)
  })

  describe('who is asking comes from the session and from nothing else', () => {
    it('passes the session user, and ignores a user id in the body or the path', async () => {
      const response = fakeResponse(userLocals())

      await controller.createAccount(
        request({ userUuid: OTHER_USER, user: { uuid: OTHER_USER }, kind: 'nextcloud' }, { userUuid: OTHER_USER }),
        response,
      )

      expect(service.createAccount).toHaveBeenCalledWith(expectedCaller, expect.objectContaining({ kind: 'nextcloud' }))
      expect(service.createAccount.mock.calls[0][0].userUuid).toBe(USER)
    })

    it.each([
      ['the literal string true', 'true', true],
      ['absent', undefined, false],
      ['false', 'false', false],
      ['a boolean true', true, false],
      ['upper case', 'TRUE', false],
      ['1', '1', false],
    ])('reads the permission as %s', async (_label, value, permitted) => {
      const settings = value === undefined ? {} : { [SettingName.NAMES.DavBridgeAllowed]: value }

      await controller.config(request(), fakeResponse(userLocals({ settings })))

      expect(service.config.mock.calls[0][0].permitted).toBe(permitted)
    })

    it('does not read the permission from another opt-in flag or from no settings at all', async () => {
      await controller.config(
        request(),
        fakeResponse(
          userLocals({ settings: { [SettingName.NAMES.CaldavEnabled]: 'true', WORKFLOWS_ENABLED: 'true' } }),
        ),
      )
      await controller.config(request(), fakeResponse({ user: { uuid: USER } }))

      expect(service.config.mock.calls.map((call) => call[0].permitted)).toEqual([false, false])
    })

    it('marks read-only and automation sessions', async () => {
      await controller.config(request(), fakeResponse(userLocals({ readOnlyAccess: true })))
      await controller.config(request(), fakeResponse(userLocals({ mcpScope: { access: 'write', tagUuids: [] } })))
      await controller.config(request(), fakeResponse(userLocals({ mcpScope: undefined })))

      expect(service.config.mock.calls.map((call) => [call[0].readOnlySession, call[0].mcpScoped])).toEqual([
        [true, false],
        [false, true],
        [false, false],
      ])
    })

    it.each([[{}], [{ user: {} }], [{ user: { uuid: '' } }], [{ user: { uuid: 7 } }]])(
      'refuses a request with no session user (%p) and calls nothing',
      async (locals) => {
        const response = fakeResponse(locals as Record<string, unknown>)

        await controller.listAccounts(request(), response)

        expect(response.sentStatus).toBe(403)
        expect(response.sentBody).toMatchObject({ error: { tag: 'dav-session-not-permitted' } })
        expect(service.listAccounts).not.toHaveBeenCalled()
      },
    )
  })

  describe('answers', () => {
    const run = async (action: (response: FakeResponse) => Promise<void>): Promise<FakeResponse> => {
      const response = fakeResponse(userLocals())
      await action(response)
      return response
    }

    it('sends each result with its status', async () => {
      const cases: Array<[string, () => Promise<FakeResponse>, number, unknown]> = [
        ['config', async () => run((response) => controller.config(request(), response)), 200, { enabled: true }],
        [
          'list',
          async () => run((response) => controller.listAccounts(request(), response)),
          200,
          { accounts: [{ id: ACCOUNT }] },
        ],
        [
          'create',
          async () => run((response) => controller.createAccount(request({ kind: 'caldav' }), response)),
          201,
          { account: { id: ACCOUNT } },
        ],
        [
          'delete all',
          async () => run((response) => controller.deleteAllAccounts(request(), response)),
          200,
          { deleted: 2 },
        ],
        [
          'delete one',
          async () => run((response) => controller.deleteAccount(request(undefined, { accountId: ACCOUNT }), response)),
          200,
          { deleted: true },
        ],
        [
          'replace secret',
          async () =>
            run((response) => controller.replaceSecret(request({ secret: 's' }, { accountId: ACCOUNT }), response)),
          200,
          { account: { id: ACCOUNT, status: 'unverified' } },
        ],
        [
          'pin',
          async () => run((response) => controller.setPin(request({}, { accountId: ACCOUNT }), response)),
          200,
          { account: { id: ACCOUNT, pin: {} } },
        ],
        [
          'relay',
          async () => run((response) => controller.relay(request({}, { accountId: ACCOUNT }), response)),
          200,
          { remote: { status: 207 } },
        ],
      ]

      for (const [label, action, status, body] of cases) {
        const response = await action()
        expect([label, response.sentStatus, response.sentBody]).toEqual([label, status, body])
        expect([label, response.sentHeaders['cache-control']]).toEqual([label, 'no-store'])
      }
    })

    it('passes the account id from the path and the body as it came', async () => {
      const body = { method: 'PROPFIND', path: '/dav/' }

      await controller.relay(request(body, { accountId: ACCOUNT }), fakeResponse(userLocals()))
      await controller.replaceSecret(request({ secret: 's' }, { accountId: ACCOUNT }), fakeResponse(userLocals()))
      await controller.setPin(request({ principalPath: '/p/' }, { accountId: ACCOUNT }), fakeResponse(userLocals()))
      await controller.deleteAccount(request(undefined, { accountId: ACCOUNT }), fakeResponse(userLocals()))

      expect(service.relay).toHaveBeenCalledWith(expectedCaller, ACCOUNT, body, expect.any(AbortSignal))
      expect(service.replaceSecret).toHaveBeenCalledWith(expectedCaller, ACCOUNT, { secret: 's' })
      expect(service.setPin).toHaveBeenCalledWith(expectedCaller, ACCOUNT, { principalPath: '/p/' })
      expect(service.deleteAccount).toHaveBeenCalledWith(expectedCaller, ACCOUNT)
    })

    it('sends a refusal with its own status, its tag, its extras, and never as 200', async () => {
      service.relay.mockRejectedValue(davRefusal.addressNotAllowed('http://nextcloud.lan', 'blocked-address'))
      const response = fakeResponse(userLocals())

      await controller.relay(request({}, { accountId: ACCOUNT }), response)

      expect(response.sentStatus).toBe(403)
      expect(response.sentBody).toEqual({
        error: {
          tag: 'dav-address-not-allowed',
          message:
            "This address is not allowed by this server's network policy. Ask the administrator to allow http://nextcloud.lan.",
          origin: 'http://nextcloud.lan',
        },
      })
      // The reason is for the server log only.
      expect(JSON.stringify(response.sentBody)).not.toContain('blocked-address')
    })

    it.each([
      ['a spent budget', davRefusal.rateLimited('requests', 417), '417'],
      ['a busy relay', davRefusal.busy('account'), '1'],
      ['an open breaker', davRefusal.circuitOpen(300), '300'],
    ])('mirrors the wait of %s into Retry-After', async (_label, refusal, retryAfter) => {
      service.relay.mockRejectedValue(refusal)
      const response = fakeResponse(userLocals())

      await controller.relay(request({}, { accountId: ACCOUNT }), response)

      expect(response.sentHeaders['retry-after']).toBe(retryAfter)
      expect(response.sentStatus).toBe(refusal.httpStatus)
    })

    it('sends no Retry-After for a refusal that names no wait', async () => {
      service.relay.mockRejectedValue(davRefusal.accountNotFound())
      const response = fakeResponse(userLocals())

      await controller.relay(request({}, { accountId: ACCOUNT }), response)

      expect(response.sentHeaders['retry-after']).toBeUndefined()
      expect(response.sentStatus).toBe(404)
    })

    it('answers a defect in this server with a bare 500 that has NO dav- tag, and logs only the class of the error', async () => {
      service.listAccounts.mockRejectedValue(
        new TypeError('Cannot read /data/dav-bridge/accounts/11111111-1111-4111-8111-111111111111.json: alice hunter2'),
      )
      const response = fakeResponse(userLocals())

      await controller.listAccounts(request(), response)

      expect(response.sentStatus).toBe(500)
      expect(response.sentBody).toEqual({ error: { message: 'Calendar sync failed on this server.' } })
      expect(JSON.stringify(response.sentBody)).not.toContain('dav-')
      expect(logger.error).toHaveBeenCalledTimes(1)
      expect(logger.error).toHaveBeenCalledWith('dav bridge request failed', {
        reason: 'internal',
        errorType: 'TypeError',
      })
      expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/hunter2|alice|accounts\//)
    })

    it('logs a thrown value that is not an Error by its type', async () => {
      service.listAccounts.mockRejectedValue('a string was thrown')

      await controller.listAccounts(request(), fakeResponse(userLocals()))

      expect(logger.error).toHaveBeenCalledWith('dav bridge request failed', {
        reason: 'internal',
        errorType: 'string',
      })
    })

    it('does not log a refusal as an error', async () => {
      service.relay.mockRejectedValue(davRefusal.passwordRejected())

      await controller.relay(request({}, { accountId: ACCOUNT }), fakeResponse(userLocals()))

      expect(logger.error).not.toHaveBeenCalled()
    })

    it('works without a logger', async () => {
      const quiet = new DavBridgeController(service as unknown as DavBridgeService)
      service.listAccounts.mockRejectedValue(new Error('x'))
      const response = fakeResponse(userLocals())

      await quiet.listAccounts(request(), response)

      expect(response.sentStatus).toBe(500)
    })
  })

  describe('relay and a caller who leaves', () => {
    it('aborts the outbound request when the connection closes before an answer was sent', async () => {
      let received: AbortSignal | undefined
      let release: (() => void) | undefined
      service.relay.mockImplementation(async (_caller, _accountId, _envelope, signal) => {
        received = signal
        await new Promise<void>((resolve) => {
          release = resolve
        })
        throw new DavRelayAbortedError()
      })
      const response = fakeResponse(userLocals())

      const pending = controller.relay(request({}, { accountId: ACCOUNT }), response)
      await new Promise((resolve) => setImmediate(resolve))
      expect(received?.aborted).toBe(false)

      response.emitter.emit('close')
      expect(received?.aborted).toBe(true)

      release?.()
      await pending
      expect(response.jsonCalls).toBe(0)
      expect(response.sentStatus).toBe(499)
      expect(response.ended).toBe(true)
      expect(logger.error).not.toHaveBeenCalled()
    })

    it('does not abort when the connection closes after the answer went out', async () => {
      let received: AbortSignal | undefined
      service.relay.mockImplementation(async (_caller, _accountId, _envelope, signal) => {
        received = signal
        return { remote: { status: 207 } } as never
      })
      const response = fakeResponse(userLocals())

      await controller.relay(request({}, { accountId: ACCOUNT }), response)
      response.emitter.emit('close')

      expect(received?.aborted).toBe(false)
      expect(response.emitter.listenerCount('close')).toBe(0)
    })
  })
})

describe('AdminDavBridgeController', () => {
  let service: ReturnType<typeof serviceMock>
  let logger: { error: jest.Mock; info: jest.Mock }
  let controller: AdminDavBridgeController

  const adminLocals = (): Record<string, unknown> => ({
    user: { uuid: USER },
    roles: [{ name: RoleName.NAMES.CoreUser }, { name: RoleName.NAMES.AdminUser }],
  })

  beforeEach(() => {
    service = serviceMock()
    logger = { error: jest.fn(), info: jest.fn() }
    controller = new AdminDavBridgeController(service as unknown as DavBridgeService, logger)
  })

  it.each([
    ['no roles', { user: { uuid: USER } }],
    ['an ordinary user', { user: { uuid: USER }, roles: [{ name: RoleName.NAMES.CoreUser }] }],
    ['a pro user', { user: { uuid: USER }, roles: [{ name: RoleName.NAMES.ProUser }] }],
    ['a role that only looks like admin', { user: { uuid: USER }, roles: [{ name: 'admin_user' }] }],
  ])('refuses %s on every route and calls nothing', async (_label, locals) => {
    for (const action of [
      (response: FakeResponse) => controller.view(request(), response),
      (response: FakeResponse) => controller.update(request({ enabled: true }), response),
      (response: FakeResponse) => controller.purge(request({ scope: 'all', confirm: 'purge-all' }), response),
    ]) {
      const response = fakeResponse(locals)
      await action(response)

      expect(response.sentStatus).toBe(403)
      expect(response.sentBody).toEqual({ error: { message: 'Admin role required.' } })
    }
    expect(service.adminView).not.toHaveBeenCalled()
    expect(service.adminUpdate).not.toHaveBeenCalled()
    expect(service.purgeAll).not.toHaveBeenCalled()
    expect(service.purgeUser).not.toHaveBeenCalled()
  })

  it('shows the view to an administrator', async () => {
    const response = fakeResponse(adminLocals())

    await controller.view(request(), response)

    expect(response.sentStatus).toBe(200)
    expect(response.sentBody).toEqual({ settings: { enabled: true }, users: [] })
    expect(response.sentHeaders['cache-control']).toBe('no-store')
  })

  it('saves settings, answers with the new view, and audits the NAMES that changed, never the values', async () => {
    service.adminUpdate.mockResolvedValue(['davBridge.enabled', 'davBridge.allowedPrivateOrigins'])
    const response = fakeResponse(adminLocals())

    await controller.update(request({ enabled: true, allowedPrivateOrigins: ['http://nextcloud.lan'] }), response)

    expect(service.adminUpdate).toHaveBeenCalledWith({ enabled: true, allowedPrivateOrigins: ['http://nextcloud.lan'] })
    expect(response.sentBody).toEqual({ settings: { enabled: true }, users: [] })
    expect(logger.info).toHaveBeenCalledWith('admin dav-bridge settings updated', {
      audit: 'admin.dav-bridge.update',
      adminUuid: USER,
      changedSettings: ['davBridge.enabled', 'davBridge.allowedPrivateOrigins'],
    })
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('nextcloud.lan')
  })

  it('answers a refused setting with the refusal and audits nothing', async () => {
    service.adminUpdate.mockRejectedValue(davRefusal.allowlistEnvOnly())
    const response = fakeResponse(adminLocals())

    await controller.update(request({ allowedPrivateOrigins: [] }), response)

    expect(response.sentStatus).toBe(409)
    expect(response.sentBody).toMatchObject({ error: { tag: 'dav-allowlist-env-only' } })
    expect(logger.info).not.toHaveBeenCalled()
  })

  describe('purge', () => {
    it('purges one user', async () => {
      const response = fakeResponse(adminLocals())

      await controller.purge(request({ scope: 'user', userUuid: OTHER_USER }), response)

      expect(service.purgeUser).toHaveBeenCalledWith(OTHER_USER)
      expect(response.sentBody).toEqual({ purgedUsers: 1, purgedAccounts: 2 })
      expect(logger.info).toHaveBeenCalledWith('admin dav-bridge purge', {
        audit: 'admin.dav-bridge.purge',
        adminUuid: USER,
        scope: 'user',
        purgedAccounts: 2,
      })
    })

    it('purges everyone only when the confirmation is typed out', async () => {
      for (const body of [{ scope: 'all' }, { scope: 'all', confirm: true }, { scope: 'all', confirm: 'yes' }]) {
        const refused = fakeResponse(adminLocals())
        await controller.purge(request(body), refused)

        expect(refused.sentStatus).toBe(400)
        expect(refused.sentBody).toMatchObject({ error: { tag: 'dav-invalid-input', field: 'confirm' } })
      }
      expect(service.purgeAll).not.toHaveBeenCalled()

      const response = fakeResponse(adminLocals())
      await controller.purge(request({ scope: 'all', confirm: 'purge-all' }), response)

      expect(service.purgeAll).toHaveBeenCalledTimes(1)
      expect(response.sentBody).toEqual({ purgedUsers: 3, purgedAccounts: 4 })
    })

    it.each([
      ['no body', undefined, 'scope'],
      ['an unknown scope', { scope: 'everything' }, 'scope'],
      ['a user scope with no user', { scope: 'user' }, 'userUuid'],
      ['a user id that is a path', { scope: 'user', userUuid: '../../etc/passwd' }, 'userUuid'],
      ['a user id that is not a string', { scope: 'user', userUuid: { $ne: null } }, 'userUuid'],
    ])('refuses %s', async (_label, body, field) => {
      const response = fakeResponse(adminLocals())

      await controller.purge(request(body), response)

      expect(response.sentStatus).toBe(400)
      expect(response.sentBody).toMatchObject({ error: { tag: 'dav-invalid-input', field } })
      expect(service.purgeUser).not.toHaveBeenCalled()
      expect(service.purgeAll).not.toHaveBeenCalled()
    })
  })
})
