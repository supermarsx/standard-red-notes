#!/usr/bin/env node
// Live verification of the DAV bridge against REAL CalDAV servers.
//
//   node scripts/verify-dav-bridge.mjs check \
//     --topology single --base http://127.0.0.1:3991 --container srn-davtest-single-app-1
//
// It drives a running Standard Red Notes stack (built from a clean export of
// one commit, joined to the test network of docker-compose.dav-test.yml)
// through its public API, exactly as a client would, and judges the outcome
// with scripts/dav-bridge/observer.mjs, which talks to the CalDAV servers
// directly and reads their access logs.
//
// RULES THIS SCRIPT HOLDS ITSELF TO
//   - Positive evidence only. "The relay refused" is asserted as "the server's
//     access log has no such request" or "the canary counted zero", next to a
//     control that DID arrive. Never as "the status was not 200".
//   - Exact counts on both sides: what the relay handed back is compared with
//     what the observer reads directly, entry for entry and byte for byte.
//   - Denominators are asserted: a sweep first proves it had something to look
//     at.
//   - Every check prints PASS or FAIL with its evidence; the exit code is the
//     number of failures (capped at 1).
//
// It never talks to anything but 127.0.0.1 and the containers it is given.
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'

import {
  accessLog,
  canaryHits,
  canaryReset,
  containerAddresses,
  DavObserver,
  DAVTEST,
  etagOf,
  fixtureEvent,
  fixtureTask,
  fromBridge,
  hrefOf,
  mintNextcloudAppPassword,
  multistatusResponses,
  nextcloudForgetFailedSignIns,
  prepareNextcloudFixture,
  sentinel,
  sha256,
} from './dav-bridge/observer.mjs'

const run = promisify(execFile)

// ------------------------------------------------------------------ arguments

function parseArguments(argv) {
  const [command, ...rest] = argv
  const options = {}
  for (let index = 0; index < rest.length; index += 1) {
    const name = rest[index]
    if (!name.startsWith('--')) {
      throw new Error(`unexpected argument ${name}`)
    }
    const next = rest[index + 1]
    if (next === undefined || next.startsWith('--')) {
      options[name.slice(2)] = 'true'
    } else {
      options[name.slice(2)] = next
      index += 1
    }
  }
  return { command, options }
}

const USAGE = `usage:
  node scripts/verify-dav-bridge.mjs fixtures
      print the test stack's servers, addresses and fixture users as JSON

  node scripts/verify-dav-bridge.mjs prepare
      once after the test stack is first started: create the Nextcloud fixture
      users and lift its limit on creating calendars (safe to repeat; \`check\`
      does it too)

  node scripts/verify-dav-bridge.mjs check --topology <single|multi> --base <url> --container <name>
        [--sections boot,policy,servers,secrecy,restart,deletion]   default: all
        [--servers radicale,nextcloud,baikal]              default: all three
        [--env-enabled <true|false>]   whether the stack was started with DAV_BRIDGE_ENABLED=true (default false)
        [--report <file.json>]         write every check with its evidence

  --container is the container the api-gateway runs in: <project>-app-1 for the
  all-in-one image, <project>-server-1 for the multi-container stack.`

// ------------------------------------------------------------- check harness

const results = []
let currentSection = ''

class CheckFailure extends Error {}

function fail(message) {
  throw new CheckFailure(message)
}

function expectEqual(actual, expected, what) {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) {
    fail(`${what}: expected ${right}, got ${left}`)
  }
}

function expectTrue(condition, what) {
  if (!condition) {
    fail(what)
  }
}

async function check(id, title, body) {
  const started = Date.now()
  try {
    const evidence = (await body()) ?? ''
    results.push({ section: currentSection, id, title, ok: true, evidence, ms: Date.now() - started })
    process.stdout.write(`PASS  ${id}  ${title}${evidence ? `\n        ${evidence}` : ''}\n`)
  } catch (error) {
    const message = error instanceof CheckFailure ? error.message : `${error?.name ?? 'Error'}: ${error?.message ?? error}`
    results.push({ section: currentSection, id, title, ok: false, evidence: message, ms: Date.now() - started })
    process.stdout.write(`FAIL  ${id}  ${title}\n        ${message}\n`)
  }
}

function section(name, title) {
  currentSection = name
  process.stdout.write(`\n== ${name}: ${title}\n`)
}

// ----------------------------------------------------------- SRN API client

/** Everything the SRN server sent back, kept for the secrecy sweep. */
const transcript = []

/**
 * What the shipped web app says it is, on every request. The server reads it:
 * a client that does not name its version gets a first-generation token, and
 * the server refuses to delete an account for one ("Please update your
 * application"), whatever password it sends.
 */
const APPLICATION_VERSION = (() => {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../app/packages/web/package.json', import.meta.url), 'utf8'))
    return `web-${manifest.version}`
  } catch {
    return 'web-3.201.28'
  }
})()

class Srn {
  constructor(base) {
    this.base = base.replace(/\/$/, '')
  }

  async call(method, path, { session, body, headers } = {}) {
    const response = await fetch(`${this.base}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        'x-application-version': APPLICATION_VERSION,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(session ? { authorization: `Bearer ${session.token}`, cookie: session.cookie } : {}),
        ...(headers ?? {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = undefined
    }
    // The gateway wraps answers proxied from auth as { meta, data }.
    const enveloped = parsed !== null && typeof parsed === 'object' && 'data' in parsed && 'meta' in parsed
    const result = {
      status: response.status,
      json: enveloped ? parsed.data : parsed,
      text,
      headers: Object.fromEntries(response.headers.entries()),
      setCookie: response.headers.getSetCookie?.() ?? [],
    }
    transcript.push({ method, path, status: result.status, text })
    return result
  }

  static cookieHeader(setCookie) {
    return setCookie
      .map((entry) => entry.split(';', 1)[0].trim())
      .filter((pair) => pair.includes('=') && !pair.endsWith('='))
      .join('; ')
  }

  /** A fresh account with a cookie session, the way the shipped web app holds one. */
  async register(label) {
    const email = `davtest-${label}-${Date.now()}-${randomBytes(3).toString('hex')}@example.com`
    const password = randomBytes(32).toString('hex')
    let answer
    // Sign-up is limited per address (five a minute by default). That limit
    // is the server working, so it is waited out rather than reported.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      answer = await this.call('POST', '/v1/users', {
        body: {
          email,
          password,
          api: '20240226',
          version: '004',
          pw_nonce: randomBytes(32).toString('hex'),
          origination: 'registration',
          created: String(Date.now()),
          ephemeral: false,
        },
      })
      if (answer.status !== 429) {
        break
      }
      const wait = Math.min(Number(answer.headers['retry-after']) || 15, 65)
      await new Promise((resolve) => setTimeout(resolve, (wait + 1) * 1000))
    }
    const token = answer.json?.session?.access_token
    const uuid = answer.json?.user?.uuid
    if (answer.status !== 200 || typeof token !== 'string' || typeof uuid !== 'string') {
      throw new Error(`could not register ${email}: HTTP ${answer.status} ${answer.text.slice(0, 200)}`)
    }
    return { email, password, uuid, token, cookie: Srn.cookieHeader(answer.setCookie) }
  }

  /** A second session for an existing account, through the PKCE v2 sign-in the web app uses. */
  async signIn(account) {
    const verifier = randomBytes(32).toString('hex')
    // The server compares base64url of the HEX TEXT of the digest, not of the digest bytes.
    const challenge = Buffer.from(createHash('sha256').update(verifier, 'utf8').digest('hex'), 'utf8').toString(
      'base64url',
    )
    const parameters = await this.call('POST', '/v2/login-params', {
      body: { email: account.email, code_challenge: challenge, api: '20240226' },
    })
    if (parameters.status !== 200) {
      throw new Error(`login-params for ${account.email}: HTTP ${parameters.status}`)
    }
    const answer = await this.call('POST', '/v2/login', {
      body: { email: account.email, password: account.password, code_verifier: verifier, api: '20240226' },
    })
    const token = answer.json?.session?.access_token
    if (answer.status !== 200 || typeof token !== 'string') {
      throw new Error(`sign-in for ${account.email}: HTTP ${answer.status} ${answer.text.slice(0, 200)}`)
    }
    return { ...account, token, cookie: Srn.cookieHeader(answer.setCookie) }
  }
}

const tagOf = (answer) => answer.json?.error?.tag

function expectRefusal(answer, status, tag, what) {
  if (answer.status !== status || tagOf(answer) !== tag) {
    fail(`${what}: expected HTTP ${status} ${tag}, got HTTP ${answer.status} ${tagOf(answer) ?? answer.text.slice(0, 160)}`)
  }
}

function expectRemote(answer, status, what) {
  if (answer.status !== 200 || answer.json?.remote?.status !== status) {
    fail(
      `${what}: expected HTTP 200 with remote status ${status}, got HTTP ${answer.status} ${
        answer.json?.remote ? `remote ${answer.json.remote.status}` : (tagOf(answer) ?? answer.text.slice(0, 160))
      }`,
    )
  }
  return answer.json.remote
}

// ------------------------------------------------------------------- helpers

async function dockerExec(container, ...command) {
  return run('docker', ['exec', container, ...command], { maxBuffer: 64 * 1024 * 1024 })
}

/**
 * `srn-admin` publishes an event when it changes a role. On the multi-container
 * stack the queue emulator can still be coming up when the front door already
 * answers, so a refused connection there is retried rather than reported.
 */
async function grantAdministrator(container, email) {
  let lastError
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await dockerExec(container, 'srn-admin', 'roles', 'grant', email, 'ADMIN_USER')
      return
    } catch (error) {
      lastError = error
      if (!/ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/.test(String(error?.stderr ?? error?.message))) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }
  }
  const lines = String(lastError?.stderr ?? lastError?.message).trim().split(/\r?\n/)
  throw new Error(`could not grant the administrator role: ${lines[lines.length - 1]}`)
}

const PROPFIND_PRINCIPAL =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>'
const PROPFIND_HOME =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>'
const PROPFIND_ETAGS =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:resourcetype/></d:prop></d:propfind>'
const XML = { 'content-type': 'application/xml; charset=utf-8' }

const innerHref = (body, property) => {
  const match = new RegExp(
    `<(?:[A-Za-z0-9]+:)?${property}[^>]*>\\s*<(?:[A-Za-z0-9]+:)?href[^>]*>([^<]*)</(?:[A-Za-z0-9]+:)?href>`,
    'i',
  ).exec(body)
  return match ? match[1] : undefined
}

// ---------------------------------------------------------------------- main

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2))

  if (command === 'fixtures') {
    const servers = {}
    for (const [name, server] of Object.entries(DAVTEST.servers)) {
      servers[name] = {
        kind: server.kind,
        hostUrl: server.hostUrl,
        bridgeOrigin: server.bridgeOrigin,
        address: server.address,
        users: server.users,
        homePath: server.homePath('{user}'),
        principalPath: server.principalPath('{user}'),
      }
    }
    process.stdout.write(`${JSON.stringify({ network: DAVTEST.network, servers, canary: DAVTEST.canary }, null, 2)}\n`)
    return 0
  }

  if (command === 'prepare') {
    const { created } = await prepareNextcloudFixture()
    process.stdout.write(
      `nextcloud: ${created.length === 0 ? 'fixture users already there' : `created ${created.join(', ')}`}; calendar-creation limit lifted\n`,
    )
    return 0
  }

  if (command !== 'check' || !options.base || !options.container || !['single', 'multi'].includes(options.topology)) {
    process.stdout.write(`${USAGE}\n`)
    return 2
  }

  const srn = new Srn(options.base)
  const container = options.container
  const topology = options.topology
  const sections = new Set((options.sections ?? 'boot,policy,servers,secrecy,restart,deletion').split(','))
  const dataPath = topology === 'single' ? '/data/dav-bridge' : '/opt/server/packages/api-gateway/data/dav-bridge'
  const serverNames = (options.servers ?? 'radicale,nextcloud,baikal').split(',')
  const envEnabled = options['env-enabled'] === 'true'
  const allOrigins = Object.values(DAVTEST.servers).map((server) => server.bridgeOrigin)
  const startedAt = new Date()

  if (sections.has('servers') && serverNames.includes('nextcloud')) {
    await prepareNextcloudFixture()
  }

  process.stdout.write(
    `DAV bridge live verification\n  topology:  ${topology}\n  front door: ${options.base}\n  gateway in: ${container}\n  started:   ${startedAt.toISOString()}\n`,
  )

  // People. The administrator's role is granted before that session is first
  // used, so the first cross-service token minted for it already carries it.
  const admin = await srn.register('admin')
  await grantAdministrator(container, admin.email)
  let user = await srn.register('user')
  const stranger = await srn.register('stranger')
  const adminPut = (body) => srn.call('PUT', '/v1/admin/dav-bridge', { session: admin, body })
  const relay = (session, accountId, envelope) =>
    srn.call('POST', `/v1/dav-bridge/accounts/${accountId}/relay`, { session, body: envelope })
  const createAccount = (session, body) => srn.call('POST', '/v1/dav-bridge/accounts', { session, body })
  /**
   * A fresh user who may use the bridge. Saving an account is budgeted per
   * user (ten an hour, counting refusals), and this script provokes far more
   * refusals than that, so each group of checks gets a user of its own.
   */
  const permittedUser = async (label) => {
    const account = await srn.register(label)
    const grant = await srn.call('PUT', `/v1/admin/users/${account.uuid}/feature-flags`, {
      session: admin,
      body: { name: 'DAV_BRIDGE_ALLOWED', value: 'true' },
    })
    if (grant.status !== 200) {
      throw new Error(`could not grant DAV_BRIDGE_ALLOWED to ${label}: HTTP ${grant.status}`)
    }
    return srn.signIn(account)
  }

  // ====================================================================== boot
  if (sections.has('boot')) {
    section('boot', 'every endpoint is registered and answers what the contract says, switch off and on')
    const anyId = '00000000-0000-4000-8000-000000000000'
    const userRoutes = [
      ['GET', '/v1/dav-bridge/config'],
      ['GET', '/v1/dav-bridge/accounts'],
      ['POST', '/v1/dav-bridge/accounts'],
      ['DELETE', '/v1/dav-bridge/accounts'],
      ['DELETE', `/v1/dav-bridge/accounts/${anyId}`],
      ['PUT', `/v1/dav-bridge/accounts/${anyId}/secret`],
      ['PUT', `/v1/dav-bridge/accounts/${anyId}/pin`],
      ['POST', `/v1/dav-bridge/accounts/${anyId}/relay`],
    ]
    const adminRoutes = [
      ['GET', '/v1/admin/dav-bridge'],
      ['PUT', '/v1/admin/dav-bridge'],
      ['POST', '/v1/admin/dav-bridge/purge'],
    ]

    await check('B01', 'without a session every route answers 401: registered, and behind the session gate', async () => {
      const statuses = []
      for (const [method, path] of [...userRoutes, ...adminRoutes]) {
        const answer = await srn.call(method, path, { body: method === 'GET' || method === 'DELETE' ? undefined : {} })
        statuses.push(`${method} ${path.replace(anyId, ':id')} ${answer.status}`)
        // 404 would mean the controller is not registered on this topology,
        // 500 that it is registered and cannot be constructed.
        expectEqual(answer.status, 401, `${method} ${path}`)
      }
      return `${statuses.length} routes, all 401`
    })

    await check('B02', `the bridge is ${envEnabled ? 'on (the stack was started with the switch on)' : 'OFF by default'} and says so`, async () => {
      const answer = await srn.call('GET', '/v1/dav-bridge/config', { session: user })
      expectEqual(answer.status, 200, 'config status')
      expectEqual(
        {
          enabled: answer.json.enabled,
          allowed: answer.json.allowed,
          available: answer.json.available,
          mode: answer.json.mode,
          writeEnabled: answer.json.writeEnabled,
          methods: answer.json.methods,
        },
        {
          enabled: envEnabled,
          allowed: false,
          available: false,
          mode: 'relay',
          writeEnabled: false,
          methods: ['OPTIONS', 'PROPFIND', 'REPORT', 'GET'],
        },
        'config',
      )
      expectEqual(answer.headers['cache-control'], 'no-store', 'cache-control')
      return JSON.stringify(answer.json.limits)
    })

    if (envEnabled) {
      await check('B02a', 'an administrator can switch it off without a restart (kill switch), for the rest of this section', async () => {
        const answer = await adminPut({ enabled: false })
        expectEqual(answer.status, 200, 'admin PUT status')
        expectEqual(answer.json.settings.enabled, false, 'enabled after PUT')
        expectEqual(answer.json.sources.enabled, 'persisted', 'source')
      })
    }

    await check('B03', 'with the switch off: looking and removing work, everything else is refused as dav-bridge-disabled', async () => {
      const list = await srn.call('GET', '/v1/dav-bridge/accounts', { session: user })
      expectEqual([list.status, list.json], [200, { accounts: [] }], 'list')
      expectRefusal(
        await createAccount(user, { kind: 'caldav', url: 'https://cloud.example.org/', username: 'a', secret: 'b' }),
        403,
        'dav-bridge-disabled',
        'create',
      )
      expectRefusal(await relay(user, anyId, { method: 'PROPFIND', path: '/' }), 403, 'dav-bridge-disabled', 'relay')
      expectRefusal(
        await srn.call('PUT', `/v1/dav-bridge/accounts/${anyId}/secret`, { session: user, body: { secret: 'x' } }),
        403,
        'dav-bridge-disabled',
        'replace secret',
      )
      expectRefusal(
        await srn.call('PUT', `/v1/dav-bridge/accounts/${anyId}/pin`, {
          session: user,
          body: { principalPath: '/p/', calendarHomePath: '/c/' },
        }),
        403,
        'dav-bridge-disabled',
        'pin',
      )
      expectRefusal(
        await srn.call('DELETE', `/v1/dav-bridge/accounts/${anyId}`, { session: user }),
        404,
        'dav-account-not-found',
        'delete one',
      )
      const removed = await srn.call('DELETE', '/v1/dav-bridge/accounts', { session: user })
      expectEqual([removed.status, removed.json], [200, { deleted: 0 }], 'delete all')
      return 'list 200 [], create/relay/secret/pin 403 dav-bridge-disabled, delete-one 404, delete-all 200 {deleted:0}'
    })

    await check('B04', 'the administrator routes refuse a signed-in user who is not an administrator', async () => {
      for (const [method, path] of adminRoutes) {
        const answer = await srn.call(method, path, { session: user, body: method === 'GET' ? undefined : { enabled: true } })
        expectEqual([answer.status, answer.json?.error?.message], [403, 'Admin role required.'], `${method} ${path}`)
      }
      const config = await srn.call('GET', '/v1/dav-bridge/config', { session: user })
      expectEqual(config.json.enabled, false, 'a refused PUT changed nothing')
    })

    await check('B05', 'the administrator sees the settings, their sources, the mode and that the secret store is ready', async () => {
      const answer = await srn.call('GET', '/v1/admin/dav-bridge', { session: admin })
      expectEqual(answer.status, 200, 'admin view status')
      expectEqual(
        [answer.json.settings.enabled, answer.json.settings.mode, answer.json.modes, answer.json.modeImplemented],
        [false, 'relay', ['relay'], true],
        'settings',
      )
      expectEqual(answer.json.secretStoreReady, true, 'secretStoreReady (the server encryption key reached the gateway)')
      expectEqual(answer.json.writeEnabled, false, 'writeEnabled')
      return `sources ${JSON.stringify(answer.json.sources)}`
    })

    await check('B06', 'the administrator switches it on; a user without the permission is still refused', async () => {
      const answer = await adminPut({ enabled: true })
      expectEqual([answer.status, answer.json.settings.enabled, answer.json.sources.enabled], [200, true, 'persisted'], 'admin PUT')
      const config = await srn.call('GET', '/v1/dav-bridge/config', { session: user })
      expectEqual([config.json.enabled, config.json.allowed, config.json.available], [true, false, false], 'config')
      expectRefusal(
        await createAccount(user, { kind: 'caldav', url: 'https://cloud.example.org/', username: 'a', secret: 'b' }),
        403,
        'dav-bridge-not-allowed',
        'create',
      )
    })

    await check('B07', 'a user cannot grant themselves the permission through their own settings', async () => {
      // The control first: the same request with a setting a user MAY write
      // succeeds, so a refusal below is about this setting and not about the
      // shape of the request.
      const control = await srn.call('PUT', `/v1/users/${stranger.uuid}/settings`, {
        session: stranger,
        body: { name: 'LOG_SESSION_USER_AGENT', value: 'disabled' },
      })
      expectEqual(control.status, 200, 'the control settings write')
      const attempt = await srn.call('PUT', `/v1/users/${stranger.uuid}/settings`, {
        session: stranger,
        body: { name: 'DAV_BRIDGE_ALLOWED', value: 'true' },
      })
      expectTrue(attempt.status >= 400, `the settings write was accepted (HTTP ${attempt.status})`)
      const again = await srn.signIn(stranger)
      const config = await srn.call('GET', '/v1/dav-bridge/config', { session: again })
      expectEqual(config.json.allowed, false, 'allowed after the self-grant attempt, on a fresh session')
      return `settings PUT answered HTTP ${attempt.status}; a fresh session is still not allowed`
    })

    await check('B08', 'the administrator grants the permission; it reaches the gateway in the token of the next session', async () => {
      const grant = await srn.call('PUT', `/v1/admin/users/${user.uuid}/feature-flags`, {
        session: admin,
        body: { name: 'DAV_BRIDGE_ALLOWED', value: 'true' },
      })
      expectEqual(grant.status, 200, `feature-flag PUT (${grant.text.slice(0, 120)})`)
      user = await srn.signIn(user)
      const config = await srn.call('GET', '/v1/dav-bridge/config', { session: user })
      expectEqual([config.json.enabled, config.json.allowed, config.json.available], [true, true, true], 'config')
      // The other user was not granted anything.
      const other = await srn.call('GET', '/v1/dav-bridge/config', { session: stranger })
      expectEqual(other.json.allowed, false, 'the stranger')
    })
  } else {
    // Sections below need the bridge on.
    await adminPut({ enabled: true })
  }

  // ==================================================================== policy
  if (sections.has('policy')) {
    section('policy', 'the network policy, judged by what reached the canary')
    const canary = DAVTEST.canary
    await canaryReset()
    const canaryAccount = { kind: 'caldav', url: `${canary.bridgeOrigin}/`, username: 'canary-user', secret: 'canary-fixture-secret' }
    const probeUsers = [await permittedUser('probe1'), await permittedUser('probe2')]
    user = await permittedUser('policy')

    await check('N01', 'with the allowed list EMPTY, private targets are refused when saved and nothing reaches the canary', async () => {
      const cleared = await adminPut({ allowedPrivateOrigins: [] })
      expectEqual(cleared.json.settings.allowedPrivateOrigins, [], 'list after clearing')
      const attempts = [
        `${canary.bridgeOrigin}/`,
        `http://${canary.address}:8080/`,
        `https://${canary.address}/`,
        `${DAVTEST.servers.radicale.bridgeOrigin}/`,
        'http://127.0.0.1:3000/',
        'http://localhost:3000/',
        'http://[::1]:3000/',
        'http://169.254.169.254/',
        'http://2130706433/',
        'http://0x7f.0.0.1/',
        'http://[::ffff:127.0.0.1]/',
        'http://server:3000/',
        'http://db:3306/',
        'http://cache:6379/',
      ]
      for (const [index, url] of attempts.entries()) {
        const prober = probeUsers[index % probeUsers.length]
        expectRefusal(await createAccount(prober, { ...canaryAccount, url }), 403, 'dav-address-not-allowed', url)
      }
      expectEqual((await canaryHits()).length, 0, 'canary hits')
      for (const prober of probeUsers) {
        const list = await srn.call('GET', '/v1/dav-bridge/accounts', { session: prober })
        expectEqual(list.json.accounts.length, 0, 'accounts stored')
      }
      return `${attempts.length} targets refused, 0 canary hits, 0 accounts stored`
    })

    await check('N02', 'the administrator cannot list a target that can never be allowed', async () => {
      const never = [
        'http://127.0.0.1:3000',
        'http://localhost:3000',
        'http://[::1]',
        'http://169.254.169.254',
        'http://0.0.0.0',
        'http://db:3306',
        'http://cache:6379',
        'http://server:3000',
        'http://app:8080',
      ]
      for (const origin of never) {
        expectRefusal(await adminPut({ allowedPrivateOrigins: [origin] }), 400, 'dav-invalid-input', origin)
      }
      const view = await srn.call('GET', '/v1/admin/dav-bridge', { session: admin })
      expectEqual(view.json.settings.allowedPrivateOrigins, [], 'list is unchanged')
      return `${never.length} origins refused at save time`
    })

    let canaryAccountId
    await check('N03', 'CONTROL: once the canary origin is listed, one relayed request arrives there, with credentials', async () => {
      const listed = await adminPut({ allowedPrivateOrigins: [canary.bridgeOrigin] })
      expectEqual(listed.json.settings.allowedPrivateOrigins, [canary.bridgeOrigin], 'list')
      const created = await createAccount(user, canaryAccount)
      expectEqual(created.status, 201, `create (${created.text.slice(0, 160)})`)
      canaryAccountId = created.json.account.id
      expectEqual((await canaryHits()).length, 0, 'creating an account makes no request')
      const answer = await relay(user, canaryAccountId, { method: 'PROPFIND', path: '/dav/', headers: { depth: '0' } })
      expectRemote(answer, 207, 'relay to the listed canary')
      const hits = await canaryHits()
      expectEqual(
        hits.map((hit) => [hit.method, hit.path, hit.hasAuthorization]),
        [['PROPFIND', '/dav/', true]],
        'canary hits',
      )
      return '1 hit: PROPFIND /dav/ with an Authorization header'
    })

    await check('N04', 'listing the NAME does not list the address behind it, another port, or another scheme', async () => {
      const before = (await canaryHits()).length
      for (const url of [`http://${canary.address}:8080/`, 'http://canary:8081/', 'https://canary:8080/', 'http://canary/']) {
        const answer = await createAccount(user, { ...canaryAccount, url })
        expectTrue(
          answer.status === 403 || answer.status === 400,
          `${url} was accepted (HTTP ${answer.status} ${tagOf(answer)})`,
        )
      }
      expectEqual((await canaryHits()).length, before, 'canary hits')
    })

    await check('N05', 'a redirect off the account origin is never followed: one hit on the canary, none anywhere else', async () => {
      const radicaleBefore = new Date()
      const cases = [
        ['/r/loopback', 'http://127.0.0.1:3000'],
        ['/r/metadata', 'http://169.254.169.254'],
        ['/r/db', 'http://db:3306'],
        ['/r/server', 'http://server:3000'],
        ['/r/https', 'https://canary:8080'],
        ['/r/elsewhere', 'http://radicale:5232'],
      ]
      for (const [path, origin] of cases) {
        await canaryReset()
        const answer = await relay(user, canaryAccountId, { method: 'PROPFIND', path })
        expectRefusal(answer, 409, 'dav-redirect-other-origin', path)
        expectEqual(answer.json.error.location.origin, origin, `${path} reported target`)
        expectEqual((await canaryHits()).map((hit) => hit.path), [path], `${path} canary hits`)
      }
      // The one target that keeps a log of its own: nothing from the bridge arrived.
      expectEqual(fromBridge(await accessLog(DAVTEST.servers.radicale, radicaleBefore)).length, 0, 'bridge requests seen by radicale')
      return `${cases.length} cross-origin redirects refused; radicale saw 0 bridge requests`
    })

    await check('N06', 'a redirect inside the origin is followed and counted; a redirect loop stops after three hops', async () => {
      await canaryReset()
      const same = expectRemote(await relay(user, canaryAccountId, { method: 'PROPFIND', path: '/r/same' }), 207, '/r/same')
      expectEqual([same.path, same.redirects], ['/dav/landed/', 1], 'where it ended')
      expectEqual((await canaryHits()).map((hit) => hit.path), ['/r/same', '/dav/landed/'], 'canary hits')
      await canaryReset()
      expectRefusal(await relay(user, canaryAccountId, { method: 'PROPFIND', path: '/r/loop' }), 502, 'dav-too-many-redirects', '/r/loop')
      expectEqual((await canaryHits()).length, 4, 'hits for the loop (the request and three followed hops)')
    })

    await check('N07', 'one 401 stops the account: the remote is not asked again', async () => {
      await canaryReset()
      expectRefusal(await relay(user, canaryAccountId, { method: 'PROPFIND', path: '/unauthorized' }), 409, 'dav-password-rejected', 'the 401')
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expectRefusal(await relay(user, canaryAccountId, { method: 'PROPFIND', path: '/dav/' }), 409, 'dav-password-rejected', 'after the 401')
      }
      expectEqual((await canaryHits()).map((hit) => hit.path), ['/unauthorized'], 'canary hits')
      const list = await srn.call('GET', '/v1/dav-bridge/accounts', { session: user })
      expectEqual(list.json.accounts.find((account) => account.id === canaryAccountId)?.status, 'password-rejected', 'status')
      // Replacing the password is what clears it.
      const replaced = await srn.call('PUT', `/v1/dav-bridge/accounts/${canaryAccountId}/secret`, {
        session: user,
        body: { secret: 'canary-fixture-secret-2' },
      })
      expectEqual([replaced.status, replaced.json.account.status], [200, 'unverified'], 'replace')
      expectRemote(await relay(user, canaryAccountId, { method: 'PROPFIND', path: '/dav/' }), 207, 'after replacing')
      return '1 hit for six relay calls; cleared only by replacing the password'
    })

    await check('N08', 'taking the origin off the list stops the account at once, with no request made', async () => {
      await adminPut({ allowedPrivateOrigins: [] })
      await canaryReset()
      expectRefusal(await relay(user, canaryAccountId, { method: 'PROPFIND', path: '/dav/' }), 403, 'dav-address-not-allowed', 'relay')
      expectEqual((await canaryHits()).length, 0, 'canary hits')
    })

    if (topology === 'multi') {
      await check('N09', "the address of one of this stack's own services is refused even when an administrator lists it", async () => {
        const project = container.replace(/-server-1$/, '')
        const addresses = Object.values(await containerAddresses(`${project}-db-1`)).filter(Boolean)
        expectTrue(addresses.length > 0, 'could not find the database container address')
        const origin = `http://${addresses[0]}:3306`
        const listed = await adminPut({ allowedPrivateOrigins: [origin] })
        expectEqual(listed.status, 200, `listing a private literal address is allowed (${listed.text.slice(0, 120)})`)
        expectRefusal(await createAccount(user, { ...canaryAccount, url: `${origin}/` }), 403, 'dav-address-not-allowed', origin)
        return `${origin} (the db container) listed by the administrator and still refused`
      })
    }

    await check('N10', 'the kill switch stops relaying at once and leaves looking and removing', async () => {
      await adminPut({ allowedPrivateOrigins: [canary.bridgeOrigin] })
      expectRemote(await relay(user, canaryAccountId, { method: 'PROPFIND', path: '/dav/' }), 207, 'before')
      await adminPut({ enabled: false })
      await canaryReset()
      expectRefusal(await relay(user, canaryAccountId, { method: 'PROPFIND', path: '/dav/' }), 403, 'dav-bridge-disabled', 'relay')
      expectEqual((await canaryHits()).length, 0, 'canary hits while off')
      const list = await srn.call('GET', '/v1/dav-bridge/accounts', { session: user })
      expectEqual(list.json.accounts.length, 1, 'the account is still listed')
      await adminPut({ enabled: true })
      const removed = await srn.call('DELETE', `/v1/dav-bridge/accounts/${canaryAccountId}`, { session: user })
      expectEqual([removed.status, removed.json], [200, { deleted: true }], 'delete')
    })

    await adminPut({ allowedPrivateOrigins: allOrigins })
  } else {
    await adminPut({ allowedPrivateOrigins: allOrigins })
  }

  // =================================================================== servers
  const secrets = []
  const contentMarkers = []
  if (sections.has('servers')) {
    user = await permittedUser('servers')
    for (const name of serverNames) {
      const server = DAVTEST.servers[name]
      section(`servers/${name}`, `read a real ${name} calendar through the relay and compare with the observer`)
      const observer = new DavObserver(server, 'alice')
      const password = name === 'nextcloud' ? await mintNextcloudAppPassword('alice') : server.users.alice
      secrets.push({ label: `${name} password`, value: password })
      const title = sentinel(`title${name}`)
      contentMarkers.push({ label: `${name} event title`, ...title })
      const collectionName = `srnfx-${randomBytes(4).toString('hex')}`
      const collection = `${observer.homePath}${collectionName}/`
      let accountId
      let before
      const phaseStart = new Date()

      await check(`${name}-S01`, 'the observer puts 25 events and 5 tasks on the server directly', async () => {
        await observer.removeCollections('srnfx-')
        await observer.mkcalendar(collection, 'SRN fixture', ['VEVENT', 'VTODO'])
        for (let index = 0; index < 25; index += 1) {
          const event = fixtureEvent(index, index === 0 ? title.value : `Fixture event ${index} — café`)
          await observer.put(`${collection}${event.fileName}`, event.ics)
        }
        for (let index = 0; index < 5; index += 1) {
          const task = fixtureTask(index, `Fixture task ${index}`)
          await observer.put(`${collection}${task.fileName}`, task.ics)
        }
        before = await observer.snapshot(collection)
        expectEqual(before.length, 30, 'objects on the server')
        return `30 objects in ${collection}`
      })

      await check(`${name}-S02`, 'connect: discovery through the relay finds the same principal and home the server defines', async () => {
        const created = await createAccount(user, { kind: server.kind, url: `${server.bridgeOrigin}/`, username: 'alice', secret: password })
        expectEqual(created.status, 201, `create (${created.text.slice(0, 160)})`)
        accountId = created.json.account.id
        expectEqual([created.json.account.status, created.json.account.pin], ['unverified', null], 'new account')
        expectTrue(!('secret' in created.json.account) && !created.text.includes(password), 'the answer contains the password')

        let principal
        const tried = []
        for (const path of ['/.well-known/caldav', '/remote.php/dav/', '/dav.php/', '/']) {
          const answer = await relay(user, accountId, { method: 'PROPFIND', path, headers: { depth: '0', ...XML }, body: PROPFIND_PRINCIPAL })
          tried.push(`${path} -> ${answer.status === 200 ? `remote ${answer.json.remote.status} at ${answer.json.remote.path}` : tagOf(answer)}`)
          if (answer.status === 200 && answer.json.remote.status === 207) {
            principal = innerHref(answer.json.remote.body, 'current-user-principal')
            if (principal) {
              break
            }
          }
        }
        expectEqual(principal, server.principalPath('alice'), `principal (${tried.join('; ')})`)
        const home = expectRemote(
          await relay(user, accountId, { method: 'PROPFIND', path: principal, headers: { depth: '0', ...XML }, body: PROPFIND_HOME }),
          207,
          'calendar-home-set',
        )
        expectEqual(innerHref(home.body, 'calendar-home-set'), server.homePath('alice'), 'calendar home')
        const pinned = await srn.call('PUT', `/v1/dav-bridge/accounts/${accountId}/pin`, {
          session: user,
          body: { principalPath: principal, calendarHomePath: server.homePath('alice') },
        })
        expectEqual([pinned.status, pinned.json.account.status, pinned.json.account.discoveryOpenUntil], [200, 'ok', null], 'pin')
        return tried.join('; ')
      })

      await check(`${name}-S03`, 'the listing through the relay equals the observer listing: same hrefs, same ETags, exact count', async () => {
        const listing = expectRemote(
          await relay(user, accountId, { method: 'PROPFIND', path: collection, headers: { depth: '1', ...XML }, body: PROPFIND_ETAGS }),
          207,
          'PROPFIND depth 1',
        )
        const viaRelay = multistatusResponses(listing.body)
          .map((response) => ({ href: hrefOf(response), etag: etagOf(response) }))
          .filter((entry) => entry.href?.endsWith('.ics'))
          .sort((left, right) => left.href.localeCompare(right.href))
        expectEqual(viaRelay.length, 30, 'objects via the relay')
        expectEqual(viaRelay, before.map(({ href, etag }) => ({ href, etag })), 'hrefs and ETags')
        return '30 of 30 hrefs and ETags equal'
      })

      await check(`${name}-S04`, 'every object fetched through the relay is byte-identical to the one the observer reads', async () => {
        let bytes = 0
        for (const object of before) {
          const fetched = expectRemote(await relay(user, accountId, { method: 'GET', path: object.href }), 200, `GET ${object.href}`)
          expectEqual(fetched.bodyEncoding, 'utf8', 'encoding')
          expectEqual(sha256(fetched.body), object.digest, `digest of ${object.href}`)
          expectEqual(fetched.headers.etag, object.etag, `ETag header of ${object.href}`)
          bytes += Buffer.byteLength(fetched.body)
        }
        expectTrue(before.some((object) => object.body.includes(title.value)), 'the title marker is not on the server')
        return `30 objects, ${bytes} bytes, all digests and ETags equal`
      })

      await check(`${name}-S05`, 'a calendar-multiget REPORT through the relay returns exactly the entries asked for', async () => {
        const wanted = before.slice(0, 10).map((object) => object.href)
        const report = expectRemote(
          await relay(user, accountId, {
            method: 'REPORT',
            path: collection,
            headers: { depth: '1', ...XML },
            body:
              '<?xml version="1.0" encoding="utf-8"?><c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
              '<d:prop><d:getetag/><c:calendar-data/></d:prop>' +
              wanted.map((href) => `<d:href>${href}</d:href>`).join('') +
              '</c:calendar-multiget>',
          }),
          207,
          'REPORT',
        )
        const returned = multistatusResponses(report.body).map(hrefOf).sort()
        expectEqual(returned, [...wanted].sort(), 'hrefs returned')
        expectTrue(report.body.includes('BEGIN:VCALENDAR'), 'calendar data is missing')
        return `${returned.length} of ${wanted.length} entries`
      })

      await check(`${name}-S06`, 'write methods are refused BY THE SERVER: the collection is untouched and the remote never saw one', async () => {
        const target = `${collection}srnfx-0.ics`
        for (const envelope of [
          { method: 'PUT', path: target, headers: { 'content-type': 'text/calendar', 'if-match': '*' }, body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' },
          { method: 'PUT', path: `${collection}new.ics`, headers: { 'content-type': 'text/calendar', 'if-none-match': '*' }, body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' },
          { method: 'DELETE', path: target },
          { method: 'DELETE', path: collection },
          { method: 'MKCALENDAR', path: `${observer.homePath}srnfx-made-by-relay/` },
        ]) {
          expectRefusal(await relay(user, accountId, envelope), 403, 'dav-writes-disabled', `${envelope.method} ${envelope.path}`)
        }
        for (const method of ['POST', 'PROPPATCH', 'MOVE', 'COPY', 'MKCOL', 'LOCK']) {
          expectRefusal(await relay(user, accountId, { method, path: target }), 400, 'dav-method-not-allowed', method)
        }
        const after = await observer.snapshot(collection)
        expectEqual(
          after.map(({ href, etag, digest }) => [href, etag, digest]),
          before.map(({ href, etag, digest }) => [href, etag, digest]),
          'collection after the attempts',
        )
        const collections = (await observer.listCollections()).map((entry) => entry.href)
        expectTrue(!collections.some((href) => href.includes('srnfx-made-by-relay')), 'a calendar was created on the server')
        const seen = fromBridge(await accessLog(server, phaseStart))
        expectTrue(seen.length > 30, `only ${seen.length} bridge requests in the server log: the log is not being read`)
        const writes = seen.filter((entry) => !['OPTIONS', 'PROPFIND', 'REPORT', 'GET'].includes(entry.method))
        expectEqual(writes, [], 'non-read requests from the bridge in the server access log')
        return `11 write attempts refused; 30 objects unchanged; server log: ${seen.length} bridge requests, 0 writes`
      })

      await check(`${name}-S07`, 'the path pin holds: nothing outside the calendar home is forwarded, and the server never saw it', async () => {
        const outside =
          name === 'nextcloud'
            ? [server.filesPath('alice'), '/remote.php/dav/addressbooks/users/alice/', '/remote.php/dav/calendars/bob/', '/status.php', '/']
            : name === 'baikal'
              ? ['/dav.php/calendars/bob/', '/dav.php/addressbooks/alice/', '/dav.php/', '/admin/', '/']
              : ['/bob/', '/', '/.web/']
        if (name === 'nextcloud') {
          // So that there IS something to steal: a file in alice's Nextcloud.
          const upload = await observer.request('PUT', `${server.filesPath('alice')}srnfx-private.txt`, {
            headers: { 'content-type': 'text/plain' },
            body: 'private file content',
          })
          expectTrue([201, 204].includes(upload.status), `could not plant the file (HTTP ${upload.status})`)
        }
        const since = new Date()
        for (const path of outside) {
          for (const method of ['PROPFIND', 'GET']) {
            expectRefusal(await relay(user, accountId, { method, path }), 403, 'dav-path-not-allowed', `${method} ${path}`)
          }
        }
        const reached = fromBridge(await accessLog(server, since)).filter((entry) => outside.includes(entry.path))
        expectEqual(reached, [], 'requests for those paths in the server access log')
        return `${outside.length * 2} requests refused; 0 reached ${name}`
      })

      await check(`${name}-S08`, 'a wrong password costs the remote exactly ONE failed sign-in, however often the client retries', async () => {
        const wrong = await createAccount(user, { kind: server.kind, url: `${server.bridgeOrigin}/`, username: 'alice', secret: 'not-the-password-fixture' })
        expectEqual(wrong.status, 201, 'create')
        const wrongId = wrong.json.account.id
        const since = new Date()
        const probe = { method: 'PROPFIND', path: server.principalPath('alice'), headers: { depth: '0' } }
        expectRefusal(await relay(user, wrongId, probe), 409, 'dav-password-rejected', 'first attempt')
        for (let attempt = 0; attempt < 5; attempt += 1) {
          expectRefusal(await relay(user, wrongId, probe), 409, 'dav-password-rejected', `retry ${attempt + 1}`)
        }
        const unauthorized = fromBridge(await accessLog(server, since)).filter((entry) => entry.status === 401)
        expectEqual(unauthorized.length, 1, '401 answers in the server access log')
        // The good account at the same origin is unaffected.
        expectRemote(await relay(user, accountId, { method: 'PROPFIND', path: collection, headers: { depth: '0' } }), 207, 'the working account')
        await srn.call('DELETE', `/v1/dav-bridge/accounts/${wrongId}`, { session: user })
        if (name === 'nextcloud') {
          const addresses = Object.values(await containerAddresses(container)).filter(Boolean)
          await nextcloudForgetFailedSignIns(addresses)
        }
        return '6 relay calls, 1 failed sign-in at the remote'
      })

      if (name === 'radicale') {
        await check(`${name}-S09`, 'a remote 403 is handed back as an answer and does not pause the account', async () => {
          const fresh = await createAccount(user, { kind: server.kind, url: `${server.bridgeOrigin}/`, username: 'alice', secret: password })
          const freshId = fresh.json.account.id
          const forbidden = expectRemote(await relay(user, freshId, { method: 'PROPFIND', path: '/bob/', headers: { depth: '0' } }), 403, "bob's collection, as alice")
          expectRemote(await relay(user, freshId, { method: 'PROPFIND', path: '/alice/', headers: { depth: '0' } }), 207, 'after the 403')
          await srn.call('DELETE', `/v1/dav-bridge/accounts/${freshId}`, { session: user })
          return `remote 403 passed through (${forbidden.body.length} bytes); the next request was forwarded`
        })
      }

      await check(`${name}-S10`, 'nothing was written: after everything above, the collection is exactly what the observer put there', async () => {
        const after = await observer.snapshot(collection)
        expectEqual(after.length, 30, 'objects')
        expectEqual(
          after.map(({ href, etag, digest }) => [href, etag, digest]),
          before.map(({ href, etag, digest }) => [href, etag, digest]),
          'collection',
        )
        return '30 objects, every href, ETag and digest unchanged'
      })
    }
  }

  // ================================================================== secrecy
  if (sections.has('secrecy')) {
    section('secrecy', 'the passwords used above are in no API answer and no server log line')
    const logs = await run('docker', ['logs', '--since', startedAt.toISOString(), container], { maxBuffer: 256 * 1024 * 1024 })
    let logText = `${logs.stdout}\n${logs.stderr}`
    if (topology === 'multi') {
      // The multi-container image writes each service's log to a file as well.
      const files = await dockerExec(container, 'sh', '-c', 'cat /var/lib/server/logs/*.log 2>/dev/null || true')
      logText += `\n${files.stdout}`
    }
    const answers = transcript.map((entry) => entry.text).join('\n')

    await check('X01', 'the sweep has something to look at', async () => {
      expectTrue(secrets.length >= 1, 'no passwords were used: run the servers section with this one')
      expectTrue(transcript.length > 100, `only ${transcript.length} API answers were recorded`)
      expectTrue(logText.length > 2000, `only ${logText.length} bytes of gateway log were read`)
      const relayed = (logText.match(/dav bridge request relayed/g) ?? []).length
      const refused = (logText.match(/dav bridge request refused/g) ?? []).length
      expectTrue(relayed > 30, `only ${relayed} "request relayed" lines: is LOG_LEVEL=debug set on the stack under test?`)
      expectTrue(refused > 10, `only ${refused} "request refused" lines`)
      return `${transcript.length} API answers, ${logText.length} bytes of log, ${relayed} relayed and ${refused} refused lines`
    })

    await check('X02', 'the passwords DID travel: the servers answered authenticated requests from the bridge', async () => {
      const proof = []
      for (const name of serverNames) {
        // 30 objects fetched one by one (200) plus the listings and reports (207).
        const ok = fromBridge(await accessLog(DAVTEST.servers[name], startedAt)).filter(
          (entry) => entry.status === 200 || entry.status === 207,
        )
        expectTrue(ok.length >= 30, `${name} answered only ${ok.length} bridge requests with 200 or 207`)
        proof.push(`${name} ${ok.length}`)
      }
      return `authenticated answers (200 or 207) to the bridge: ${proof.join(', ')}`
    })

    await check('X03', 'no password, in clear or as Basic credentials, is in any API answer or log line', async () => {
      for (const { label, value } of secrets) {
        const forms = [value, Buffer.from(`alice:${value}`).toString('base64'), Buffer.from(value).toString('base64')]
        for (const form of forms) {
          expectTrue(!answers.includes(form), `${label} is in an API answer`)
          expectTrue(!logText.includes(form), `${label} is in the gateway log`)
        }
      }
      return `${secrets.length} passwords, 3 encodings each`
    })

    await check('X04', 'calendar content reached the owner and no log line', async () => {
      for (const marker of contentMarkers) {
        expectTrue(answers.includes(marker.value), `${marker.label} never reached the client: the sweep would prove nothing`)
        for (const window of marker.windows) {
          expectTrue(!logText.includes(window), `${marker.label} is in the gateway log`)
        }
      }
      for (const path of ['remote.php/dav', 'dav.php/calendars', '/alice/srnfx-', 'srnfx-0.ics', '.well-known/caldav']) {
        expectTrue(!logText.includes(path), `a request path (${path}) is in the gateway log`)
      }
      return `${contentMarkers.length} content markers present in answers and absent from the log; no request path in the log`
    })

    await check('X05', 'the stored file holds ciphertext and no password', async () => {
      const file = `${dataPath}/accounts/${user.uuid}.json`
      const stored = (await dockerExec(container, 'cat', file)).stdout
      expectTrue(stored.includes('"ciphertext"') && stored.includes('"alg": "A256GCM"'), 'the account file has no sealed secret')
      for (const { label, value } of secrets) {
        expectTrue(!stored.includes(value), `${label} is in the account file in clear`)
        expectTrue(!stored.includes(Buffer.from(value).toString('base64')), `${label} is in the account file as base64`)
      }
      const mode = (await dockerExec(container, 'stat', '-c', '%a', file)).stdout.trim()
      expectEqual(mode, '600', 'file mode')
      return `${file}: sealed, mode ${mode}`
    })
  }

  // ================================================================== restart
  if (sections.has('restart')) {
    section('restart', 'accounts survive a restart and removing them leaves nothing')
    const server = DAVTEST.servers[serverNames[0]]
    const before = (await srn.call('GET', '/v1/dav-bridge/accounts', { session: user })).json.accounts

    await check('R01', 'after the container restarts, the same accounts are there and still relay (the key was not regenerated)', async () => {
      expectTrue(before.length >= 1, 'no account to restart with: run the servers section with this one')
      await run('docker', ['restart', container])
      const deadline = Date.now() + 240_000
      let ready = false
      while (Date.now() < deadline && !ready) {
        await new Promise((resolve) => setTimeout(resolve, 3000))
        try {
          const probe = await fetch(`${srn.base}/v1/dav-bridge/config`)
          ready = probe.status === 401
        } catch {
          ready = false
        }
      }
      expectTrue(ready, 'the stack did not come back within four minutes')
      const after = (await srn.call('GET', '/v1/dav-bridge/accounts', { session: user })).json.accounts
      expectEqual(
        after.map((account) => [account.id, account.origin, account.status, account.pin]),
        before.map((account) => [account.id, account.origin, account.status, account.pin]),
        'accounts after the restart',
      )
      const account = after.find((entry) => entry.origin === server.bridgeOrigin && entry.pin !== null)
      expectTrue(account !== undefined, 'the pinned account is gone')
      expectRemote(await relay(user, account.id, { method: 'PROPFIND', path: account.pin.calendarHomePath, headers: { depth: '0' } }), 207, 'relay after restart')
      const view = await srn.call('GET', '/v1/admin/dav-bridge', { session: admin })
      expectEqual([view.json.settings.enabled, view.json.sources.enabled], [true, 'persisted'], 'the administrator setting survived')
      return `${after.length} accounts, statuses and pins unchanged; relay answered 207`
    })

    await check('R02', 'the administrator view lists origins and states, and no username, path or content', async () => {
      const view = await srn.call('GET', '/v1/admin/dav-bridge', { session: admin })
      const mine = view.json.users.find((entry) => entry.userUuid === user.uuid)
      expectTrue(mine !== undefined && mine.accounts.length === before.length, 'the user is missing from the view')
      expectEqual(Object.keys(mine.accounts[0]).sort(), ['id', 'kind', 'lastResult', 'origin', 'requests', 'status'], 'account fields')
      expectTrue(!view.text.includes('alice') && !view.text.includes('calendars') && !view.text.includes('srnfx-'), 'the view names a user, a path or a collection')
      return `${mine.accounts.length} accounts shown as origin + state`
    })

    await check('R03', 'removing everything removes the file from the server', async () => {
      const listing = async () => (await dockerExec(container, 'sh', '-c', `ls -a ${dataPath}/accounts 2>/dev/null || true`)).stdout
      expectTrue((await listing()).includes(user.uuid), 'there is no file for this user before removal: nothing to prove')
      const removed = await srn.call('DELETE', '/v1/dav-bridge/accounts', { session: user })
      expectEqual([removed.status, removed.json.deleted], [200, before.length], 'delete all')
      expectTrue(!(await listing()).includes(user.uuid), 'something that names the user is still on disk')
      expectEqual((await srn.call('GET', '/v1/dav-bridge/accounts', { session: user })).json.accounts, [], 'list')
      return `${before.length} accounts removed; no file names the user`
    })
  }

  // ================================================================= deletion
  if (sections.has('deletion')) {
    section('deletion', 'deleting a Standard Red Notes account removes what the gateway stored for it')
    const origin = DAVTEST.servers.radicale.bridgeOrigin
    const stored = async () => (await dockerExec(container, 'sh', '-c', `ls -a ${dataPath}/accounts 2>/dev/null || true`)).stdout
    const connect = async (label) => {
      const person = await permittedUser(label)
      const created = await createAccount(person, {
        kind: 'caldav',
        url: `${origin}/`,
        username: 'alice',
        secret: DAVTEST.servers.radicale.users.alice,
      })
      if (created.status !== 201) {
        throw new Error(`could not connect an account for ${label}: HTTP ${created.status} ${created.text.slice(0, 120)}`)
      }
      return person
    }
    const leaver = await connect('leaver')
    const removed = await connect('removed')
    const bystander = await connect('bystander')

    // A token for this server's own read-only CalDAV feed. It is a credential
    // that lives in the gateway, not in auth, so before the cleanup existed it
    // kept working after its account was deleted.
    const feedStatus = async (person, token) => {
      const response = await fetch(`${srn.base}/dav/calendars/${person.uuid}/todos/`, {
        method: 'PROPFIND',
        headers: { depth: '0', authorization: `Basic ${Buffer.from(`${person.email}:${token}`).toString('base64')}` },
      })
      await response.text()
      return response.status
    }
    const mintFeedToken = async (person) => {
      const optIn = await srn.call('PUT', `/v1/users/${person.uuid}/settings`, {
        session: person,
        body: { name: 'CALDAV_ENABLED', value: 'true' },
      })
      if (optIn.status !== 200) {
        throw new Error(`could not opt ${person.email} into the CalDAV feed: HTTP ${optIn.status}`)
      }
      const fresh = await srn.signIn(person)
      const created = await srn.call('POST', '/v1/caldav/tokens', { session: fresh, body: { label: 'davtest' } })
      const token = created.json?.token?.token
      if (created.status !== 201 || typeof token !== 'string') {
        throw new Error(`could not mint a CalDAV feed token: HTTP ${created.status} ${created.text.slice(0, 160)}`)
      }
      return token
    }
    const tokens = {}

    await check('D00', 'each of the three users has a feed token that WORKS (the control for everything below)', async () => {
      for (const [label, person] of [['leaver', leaver], ['removed', removed], ['bystander', bystander]]) {
        tokens[label] = await mintFeedToken(person)
        expectEqual(await feedStatus(person, tokens[label]), 207, `${label}: feed with the token`)
        expectEqual(await feedStatus(person, `${tokens[label]}x`), 401, `${label}: feed with a wrong token`)
      }
      return '3 tokens answer 207; a wrong token answers 401'
    })

    await check('D01', 'a REFUSED deletion leaves the stored account exactly where it was', async () => {
      expectTrue((await stored()).includes(leaver.uuid), 'there is no file for this user: nothing to prove')
      const wrongPassword = await srn.call('DELETE', `/v1/users/${leaver.uuid}`, {
        session: leaver,
        headers: { 'x-server-password': 'not-the-password' },
      })
      expectTrue(wrongPassword.status >= 400, `deletion with a wrong password was accepted (HTTP ${wrongPassword.status})`)
      // Refused for the reason this check is about. Any other refusal (an
      // unsupported client, a missing header) would pass the line above and
      // say nothing about a wrong password.
      expectTrue(
        String(wrongPassword.json?.error?.message).includes('password you entered is incorrect'),
        `the deletion was refused for another reason: ${String(wrongPassword.json?.error?.message)}`,
      )
      const notOwner = await srn.call('DELETE', `/v1/users/${leaver.uuid}`, {
        session: bystander,
        headers: { 'x-server-password': bystander.password },
      })
      expectTrue(notOwner.status >= 400, `deletion by another user was accepted (HTTP ${notOwner.status})`)
      const wrongConfirmation = await srn.call('DELETE', `/v1/admin/users/${removed.uuid}`, {
        session: admin,
        body: { confirmEmail: 'someone-else@example.com' },
      })
      expectTrue(wrongConfirmation.status >= 400, `admin deletion with a wrong confirmation was accepted (HTTP ${wrongConfirmation.status})`)
      const files = await stored()
      expectTrue(files.includes(leaver.uuid) && files.includes(removed.uuid), 'a refused deletion removed a stored account')
      expectEqual(await feedStatus(leaver, tokens.leaver), 207, "the leaver's feed token after the refused deletions")
      expectEqual(await feedStatus(removed, tokens.removed), 207, "the other user's feed token after the refused deletion")
      return `refused with HTTP ${wrongPassword.status}, ${notOwner.status} and ${wrongConfirmation.status}; both files still there, both tokens still work`
    })

    await check('D02', 'a user deletes their own account: its file is gone, the others are untouched', async () => {
      const answer = await srn.call('DELETE', `/v1/users/${leaver.uuid}`, {
        session: leaver,
        headers: { 'x-server-password': leaver.password },
      })
      expectEqual(answer.status, 200, `self-deletion (${answer.json?.error?.message ?? answer.text.slice(0, 160)})`)
      const files = await stored()
      // Both halves in one line, so that a failure says which of the two it
      // was. The token is the same one that answered 207 in D00 and D01.
      expectEqual(
        [!files.includes(leaver.uuid), await feedStatus(leaver, tokens.leaver)],
        [true, 401],
        'the deleted user [stored file gone, answer to the same feed token]',
      )
      expectTrue(files.includes(removed.uuid) && files.includes(bystander.uuid), 'another user lost their stored account')
      expectEqual(await feedStatus(removed, tokens.removed), 207, "another user's feed token")
      expectEqual(await feedStatus(bystander, tokens.bystander), 207, "the bystander's feed token")
      return 'file gone and the feed token is refused (401); two other users and their tokens untouched'
    })

    await check('D03', 'an administrator deletes an account: its file is gone, the others are untouched', async () => {
      const answer = await srn.call('DELETE', `/v1/admin/users/${removed.uuid}`, {
        session: admin,
        body: { confirmEmail: removed.email },
      })
      expectEqual(answer.status, 200, `admin deletion (${answer.text.slice(0, 160)})`)
      const files = await stored()
      expectEqual(
        [!files.includes(removed.uuid), await feedStatus(removed, tokens.removed)],
        [true, 401],
        'the deleted user [stored file gone, answer to the same feed token]',
      )
      expectTrue(files.includes(bystander.uuid), 'the bystander lost their stored account')
      expectEqual(await feedStatus(bystander, tokens.bystander), 207, "the bystander's feed token")
      const list = await srn.call('GET', '/v1/dav-bridge/accounts', { session: bystander })
      expectEqual(list.json.accounts.length, 1, "the bystander's accounts")
      await srn.call('DELETE', '/v1/dav-bridge/accounts', { session: bystander })
      return 'file gone and the feed token is refused (401); the bystander still has their file and a working token'
    })

    // A deletion made with `srn-admin` never passes through the gateway. What
    // tells the gateway is the record auth's deletion handler writes beside
    // the shared settings file; the gateway reads it 30 s after start and every
    // minute. So this check waits, and says how long it took.
    //
    // On the all-in-one there is no such deletion: the command line runs as a
    // separate process from the server that would carry the event, and refuses.
    // The check then is that the refusal left the account whole.
    const recordPath = topology === 'single' ? '/data/deleted-accounts' : '/opt/server/packages/api-gateway/data/deleted-accounts'
    const recorded = async () => (await dockerExec(container, 'sh', '-c', `ls -a ${recordPath} 2>/dev/null || true`)).stdout
    const waiting = async () => (await srn.call('GET', '/v1/admin/dav-bridge', { session: admin })).json?.pendingAccountPurges

    await check('D04', 'an account deleted on the COMMAND LINE: the gateway is told, and removes what it stored on its next sweep', async () => {
      const cli = await connect('cli')
      const token = await mintFeedToken(cli)
      expectEqual(await feedStatus(cli, token), 207, 'feed with the token before the deletion')
      expectTrue((await stored()).includes(cli.uuid), 'there is no file for this user: nothing to prove')

      let refusal
      try {
        await dockerExec(container, 'srn-admin', 'delete-user', cli.email, '--confirm', cli.email)
      } catch (error) {
        refusal = `${error.stderr ?? ''}${error.message ?? ''}`
      }
      if (refusal !== undefined) {
        expectTrue(
          topology === 'single' && refusal.includes('Cannot publish ACCOUNT_DELETION_REQUESTED'),
          `the command failed, and not with the refusal an in-process deployment gives: ${refusal.slice(-300)}`,
        )
        const files = await stored()
        expectEqual(
          [files.includes(cli.uuid), await feedStatus(cli, token), (await recorded()).includes(cli.uuid)],
          [true, 207, false],
          'after the refused command [stored file still there, answer to the feed token, a record was written]',
        )
        const signedIn = await srn.signIn(cli)
        expectEqual((await srn.call('GET', '/v1/dav-bridge/accounts', { session: signedIn })).json.accounts.length, 1, 'accounts of the user who was not deleted')
        await srn.call('DELETE', '/v1/dav-bridge/accounts', { session: signedIn })
        return 'the command line refuses to delete on this topology (no transport for the event); the account, its file and its token are untouched'
      }

      const started = Date.now()
      let sawRecord = false
      let sawWaiting = false
      let tokenAnsweredWhileWaiting = false
      let done = false
      while (!done && Date.now() - started < 4 * 60_000) {
        const record = await recorded()
        const inRecord = record.includes(cli.uuid)
        sawRecord = sawRecord || inRecord
        if (inRecord) {
          sawWaiting = sawWaiting || (await waiting()) >= 1
          tokenAnsweredWhileWaiting = tokenAnsweredWhileWaiting || (await feedStatus(cli, token)) === 207
        }
        done = sawRecord && !inRecord && !(await stored()).includes(cli.uuid)
        if (!sawRecord && Date.now() - started > 90_000) {
          break
        }
        if (!done) {
          await new Promise((resolve) => setTimeout(resolve, 2000))
        }
      }
      const took = Math.round((Date.now() - started) / 1000)
      expectTrue(sawRecord, `auth did not record the deletion in ${recordPath} within 90 s: the gateway is never told`)
      expectTrue(done, `${took} s after the command the gateway still holds the account file, or the record is still there`)
      expectTrue(sawWaiting, 'the administrator view never showed a deletion waiting while the record was there')
      expectEqual(await feedStatus(cli, token), 401, "the deleted user's feed token")
      expectEqual(await waiting(), 0, 'pendingAccountPurges at the end')
      return (
        `recorded by auth; file, record and token gone ${took} s after the command; the view showed it waiting; ` +
        `in between the token ${tokenAnsweredWhileWaiting ? 'still answered 207 (the stated window)' : 'was not seen answering'}`
      )
    })
  }

  // ------------------------------------------------------------------ summary
  const failed = results.filter((result) => !result.ok)
  process.stdout.write(
    `\n${results.length - failed.length} passed, ${failed.length} failed (${topology}, ${options.base}, ${new Date().toISOString()})\n`,
  )
  for (const result of failed) {
    process.stdout.write(`  FAILED ${result.id} ${result.title}\n`)
  }
  if (options.report) {
    await writeFile(
      options.report,
      `${JSON.stringify({ topology, base: options.base, container, startedAt, finishedAt: new Date(), results }, null, 2)}\n`,
    )
  }
  return failed.length === 0 ? 0 : 1
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    process.stderr.write(`verify-dav-bridge could not run: ${error?.stack ?? error}\n`)
    process.exitCode = 2
  },
)
