import { randomBytes, randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import * as http from 'http'
import { AddressInfo } from 'net'
import * as os from 'os'
import * as path from 'path'

import { PinnedRequestFactory, ResolveHost } from '@standardnotes/domain-core'

import { ServerSettingsStore } from '../ServerSettings/ServerSettingsStore'
import { DavAccountStore } from './DavAccountStore'
import { DavBridgeCaller, DavBridgeLogger, DavBridgeService } from './DavBridgeService'
import { DavBridgeEnvBaseline, DavBridgeSettings } from './DavBridgeSettings'
import { DavNetworkPolicy } from './DavNetworkPolicy'
import { DavRelay } from './DavRelay'
import { DavRelayLimiter, DavRelayLimits, DavSharedCounterStore, DEFAULT_DAV_RELAY_LIMITS } from './DavRelayLimiter'
import { DavSecretCipher } from './DavSecretCipher'

/**
 * Shared scaffolding for the DAV bridge specs. It is a `.spec.ts` file so that
 * the build leaves it out of `dist`; the one test it owns runs only when this
 * file is the suite jest was asked for, not in every suite that imports it.
 *
 * The idea every spec here leans on: the bridge is exercised with its REAL
 * transport, REAL file store and REAL cipher. Two seams are replaced, the two
 * that cannot be real in a unit test:
 *
 *   - DNS, by a table (`resolver`), so a test decides where a name "points";
 *   - the socket factory, by one that RECORDS the address the relay tried to
 *     connect to and then dials a fake remote on this machine instead.
 *
 * The record is the evidence. "The relay refused" is asserted as "no connection
 * was attempted", never as "the status was not 200", which a relay that refuses
 * everything would also satisfy.
 */

export const TEST_SERVER_KEY = 'a1'.repeat(32)

export interface ReceivedRequest {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: string
}

export interface FakeRemoteReply {
  status?: number
  headers?: Record<string, string>
  body?: string | Buffer
  /** Never answer, to exercise the deadline. */
  hang?: boolean
  /** Send headers, then this many bytes in chunks, without ever declaring a length. */
  streamBytes?: number
}

export type FakeRemoteHandler = (request: ReceivedRequest) => FakeRemoteReply

/** A real HTTP server on this machine that plays the external CalDAV server. */
export class FakeRemote {
  readonly received: ReceivedRequest[] = []
  private server: http.Server | undefined
  private handler: FakeRemoteHandler = () => ({ status: 207, body: '<multistatus/>' })
  private readonly hanging = new Set<http.ServerResponse>()
  private listeningPort = 0

  /** Stays the same after `stop()`, so a test can aim at a port nothing listens on. */
  get port(): number {
    return this.listeningPort
  }

  respond(handler: FakeRemoteHandler): void {
    this.handler = handler
  }

  async start(): Promise<void> {
    this.server = http.createServer((incoming, outgoing) => {
      const chunks: Buffer[] = []
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
      incoming.on('end', () => {
        const request: ReceivedRequest = {
          method: incoming.method ?? '',
          url: incoming.url ?? '',
          headers: incoming.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }
        this.received.push(request)
        const reply = this.handler(request)
        if (reply.hang) {
          this.hanging.add(outgoing)
          return
        }
        outgoing.statusCode = reply.status ?? 200
        for (const [name, value] of Object.entries(reply.headers ?? {})) {
          outgoing.setHeader(name, value)
        }
        if (reply.streamBytes !== undefined) {
          const chunk = Buffer.alloc(64 * 1024, 0x61)
          let remaining = reply.streamBytes
          const pump = (): void => {
            while (remaining > 0) {
              const piece = remaining >= chunk.length ? chunk : chunk.subarray(0, remaining)
              remaining -= piece.length
              if (!outgoing.write(piece)) {
                outgoing.once('drain', pump)
                return
              }
            }
            outgoing.end()
          }
          outgoing.on('error', () => undefined)
          pump()
          return
        }
        outgoing.end(reply.body ?? '')
      })
    })
    await new Promise<void>((resolve) => this.server?.listen(this.listeningPort, '127.0.0.1', resolve))
    this.listeningPort = (this.server.address() as AddressInfo).port
  }

  async stop(): Promise<void> {
    for (const outgoing of this.hanging) {
      outgoing.destroy()
    }
    this.server?.closeAllConnections()
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
  }
}

export interface AttemptedConnection {
  protocol: string
  /** The address the relay pinned and tried to connect to. */
  address: string
  port: string | undefined
  path: string
  method: string
  host: string
  authorization: string | undefined
}

/**
 * A socket factory that records where the relay tried to go and dials the fake
 * remote instead. Everything above it (resolution, pinning, header assembly,
 * redirect handling, size and time ceilings) is production code.
 */
export function recordingFactory(remote: FakeRemote): {
  factory: PinnedRequestFactory
  attempts: AttemptedConnection[]
} {
  const attempts: AttemptedConnection[] = []
  const factory: PinnedRequestFactory = (protocol, options, onResponse) => {
    const headers = (options.headers ?? {}) as Record<string, string>
    attempts.push({
      protocol,
      address: String(options.hostname),
      port: options.port === undefined ? undefined : String(options.port),
      path: String(options.path),
      method: String(options.method),
      host: headers.Host,
      authorization: headers.Authorization,
    })
    return http.request(
      {
        hostname: '127.0.0.1',
        port: remote.port,
        path: options.path,
        method: options.method,
        headers: options.headers,
        agent: false,
      },
      onResponse,
    )
  }
  return { factory, attempts }
}

/** DNS by table. A name that is not in the table does not exist. */
export function resolver(table: Record<string, string[]>): ResolveHost & { lookups: string[] } {
  const lookups: string[] = []
  const resolve = (async (host: string): Promise<string[]> => {
    lookups.push(host)
    const answer = table[host]
    if (!answer) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' })
    }
    return answer
  }) as ResolveHost & { lookups: string[] }
  resolve.lookups = lookups
  return resolve
}

export interface LoggedLine {
  level: 'info' | 'warn' | 'debug' | 'error'
  message: string
  meta: Record<string, unknown> | undefined
}

/** Keeps every log call, at every level, so a sweep can look at all of them. */
export function capturingLogger(): DavBridgeLogger & {
  error: DavBridgeLogger['info']
  lines: LoggedLine[]
  text(): string
} {
  const lines: LoggedLine[] = []
  const at =
    (level: LoggedLine['level']) =>
    (message: string, meta?: Record<string, unknown>): void => {
      lines.push({ level, message, meta })
    }
  return {
    lines,
    info: at('info'),
    warn: at('warn'),
    debug: at('debug'),
    error: at('error'),
    text: () => lines.map((line) => `${line.level} ${line.message} ${JSON.stringify(line.meta ?? {})}`).join('\n'),
  }
}

export async function temporaryDirectory(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `srn-dav-${label}-`))
}

export async function removeDirectory(directory: string): Promise<void> {
  await fs.rm(directory, { recursive: true, force: true })
}

/**
 * An opaque marker that cannot occur by accident and does not look like an
 * address, a word or a number. Sweeps search for 20-character windows from its
 * start, middle and end, so a value that leaked truncated or embedded in a
 * longer string is still found.
 */
export function sentinel(label: string): { value: string; windows: string[] } {
  const value = `Zq7${label}${randomBytes(30).toString('hex')}Kx9`
  const middle = Math.floor((value.length - 20) / 2)
  return {
    value,
    windows: [value.slice(0, 20), value.slice(middle, middle + 20), value.slice(value.length - 20)],
  }
}

export const newUserUuid = (): string => randomUUID()

export const caller = (userUuid: string, overrides: Partial<DavBridgeCaller> = {}): DavBridgeCaller => ({
  userUuid,
  permitted: true,
  readOnlySession: false,
  mcpScoped: false,
  ...overrides,
})

export interface BridgeHarness {
  service: DavBridgeService
  remote: FakeRemote
  attempts: AttemptedConnection[]
  logger: ReturnType<typeof capturingLogger>
  store: DavAccountStore
  settingsStore: ServerSettingsStore
  cipher: DavSecretCipher
  limiter: DavRelayLimiter
  dataPath: string
  settingsPath: string
  clock: { now: number }
  dns: ReturnType<typeof resolver>
  close(): Promise<void>
}

export interface BridgeHarnessOptions {
  env?: Partial<DavBridgeEnvBaseline>
  dns?: Record<string, string[]>
  limits?: Partial<DavRelayLimits>
  sharedStore?: DavSharedCounterStore
  serverKey?: string | undefined
  ownServiceAddresses?: Record<string, string[]>
  ownInterfaceAddresses?: string[]
  relayTimeoutMs?: number
  /** Wraps the recording socket factory, to make chosen connections fail in a chosen way. */
  wrapFactory?: (inner: PinnedRequestFactory) => PinnedRequestFactory
}

/** The bridge with real parts, a fake remote behind a recording socket factory, and a clock a test can move. */
export async function buildBridge(options: BridgeHarnessOptions = {}): Promise<BridgeHarness> {
  const directory = await temporaryDirectory('bridge')
  const dataPath = path.join(directory, 'dav-bridge')
  const settingsPath = path.join(directory, 'server-settings.json')
  const remote = new FakeRemote()
  await remote.start()
  const { factory, attempts } = recordingFactory(remote)
  const dns = resolver({
    'cloud.example.org': ['93.184.216.34'],
    ...options.dns,
  })
  const clock = { now: Date.UTC(2026, 9, 12, 12, 0, 0) }
  const now = (): number => clock.now
  const logger = capturingLogger()
  const settingsStore = new ServerSettingsStore(settingsPath, TEST_SERVER_KEY)
  const store = new DavAccountStore(dataPath)
  const cipher = new DavSecretCipher('serverKey' in options ? options.serverKey : TEST_SERVER_KEY)
  const ownServices = options.ownServiceAddresses ?? {}
  const policy = new DavNetworkPolicy({
    resolveHost: dns,
    requestFactory: options.wrapFactory ? options.wrapFactory(factory) : factory,
    resolveOwnServiceName: async (name) => {
      const answer = ownServices[name]
      if (!answer) {
        throw new Error('ENOTFOUND')
      }
      return answer
    },
    ownInterfaceAddresses: () => options.ownInterfaceAddresses ?? [],
    now,
  })
  const limiter = new DavRelayLimiter({ ...DEFAULT_DAV_RELAY_LIMITS, ...options.limits }, options.sharedStore, now)
  const service = new DavBridgeService({
    settings: new DavBridgeSettings(settingsStore, {
      enabled: true,
      allowlistEnvOnly: false,
      ...options.env,
    }),
    store,
    cipher,
    policy,
    // The relay's deadline uses the real clock: the fake clock above is for
    // windows and budgets, and a deadline measured on it would never arrive.
    relay: new DavRelay(policy, () => Date.now(), options.relayTimeoutMs),
    limiter,
    logger,
    now,
  })

  return {
    service,
    remote,
    attempts,
    logger,
    store,
    settingsStore,
    cipher,
    limiter,
    dataPath,
    settingsPath,
    clock,
    dns,
    close: async () => {
      await remote.stop()
      await removeDirectory(directory)
    },
  }
}

if (expect.getState().testPath === __filename) {
  describe('DAV bridge test kit', () => {
    it('records the address the relay pinned while the request lands on the fake remote', async () => {
      const remote = new FakeRemote()
      await remote.start()
      try {
        const { factory, attempts } = recordingFactory(remote)
        await new Promise<void>((resolve, reject) => {
          const request = factory(
            'https:',
            { hostname: '203.0.113.9', port: '8443', path: '/dav/', method: 'PROPFIND', headers: { Host: 'x.test' } },
            (response) => {
              response.resume()
              response.on('end', resolve)
            },
          )
          request.on('error', reject)
          request.end()
        })

        expect(attempts).toEqual([
          {
            protocol: 'https:',
            address: '203.0.113.9',
            port: '8443',
            path: '/dav/',
            method: 'PROPFIND',
            host: 'x.test',
            authorization: undefined,
          },
        ])
        expect(remote.received.map((request) => [request.method, request.url])).toEqual([['PROPFIND', '/dav/']])
      } finally {
        await remote.stop()
      }
    })

    it('makes sentinels whose three windows are distinct and inside the value', () => {
      const marker = sentinel('pw')

      expect(new Set(marker.windows).size).toBe(3)
      for (const window of marker.windows) {
        expect(window).toHaveLength(20)
        expect(marker.value).toContain(window)
      }
    })
  })
}
