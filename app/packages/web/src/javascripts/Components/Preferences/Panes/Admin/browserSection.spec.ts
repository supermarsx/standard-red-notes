import { webcrypto } from 'crypto'

import {
  buildBrowserSection,
  observeBrowserCapabilities,
  probeInputBytes,
  PROBE_DIGEST_SHA256_HEX,
  type BrowserObservations,
  type BrowserRuntime,
  type NavigatorLike,
  type SubtleCryptoLike,
  type WebStorageLike,
} from './browserSection'
import { EFFORT_LABEL } from './diagnosticRemedies'
import type { DiagnosticFinding, DiagnosticRow, SectionModel } from './diagnosticsSections'

/**
 * Standard Red Notes: the Browser section's own tests.
 *
 * *** WHY THIS FILE INSTALLS A WEB CRYPTO IMPLEMENTATION ***
 *
 * jsdom provides a `crypto` object with NO `subtle`. The natural shape for a
 * suite in that environment is `hasSubtle ? describe : describe.skip`, and this
 * repository has already shipped four suites written exactly that way: they
 * passed, in CI, for weeks, having asserted nothing at all. A guard that skips is
 * not a weaker test, it is the absence of one.
 *
 * So the collector reads a runtime that is handed to it, this file hands it Node's
 * `webcrypto`, and the success path runs a real SHA-256 and a real AES-GCM round
 * trip on every run on every machine. The absent, throwing, wrong-answer and
 * hanging paths are then each exercised with their own fixture rather than by
 * hoping the environment supplies one. There is no `describe.skip` in this file
 * and there must never be one.
 *
 * The second thing this file is for: proving the contract's evidence mechanism is
 * load-bearing HERE and not merely imported. Three properties are asserted per
 * row rather than over a set of rows, because an assertion over a set is
 * satisfied by any member of it — a mistake already made once on this task.
 */

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const workingStorage = (): WebStorageLike => {
  const entries = new Map<string, string>()
  return {
    setItem: (key, value) => {
      entries.set(key, value)
    },
    getItem: (key) => entries.get(key) ?? null,
    removeItem: (key) => {
      entries.delete(key)
    },
  }
}

const healthyNavigator = (overrides: Partial<NavigatorLike> = {}): NavigatorLike => ({
  onLine: true,
  cookieEnabled: true,
  hardwareConcurrency: 8,
  deviceMemory: 8,
  storage: {
    estimate: () => Promise.resolve({ usage: 1024 * 1024 * 1024, quota: 8 * 1024 * 1024 * 1024 }),
    persisted: () => Promise.resolve(true),
  },
  serviceWorker: {
    controller: { scriptURL: 'sw.js' },
    getRegistrations: () => Promise.resolve([{}]),
  },
  clipboard: { writeText: () => Promise.resolve() },
  userAgentData: {
    brands: [{ brand: 'Chromium', version: '140' }],
    platform: 'Windows',
    mobile: false,
  },
  ...overrides,
})

const healthyRuntime = (overrides: Partial<BrowserRuntime> = {}): BrowserRuntime => ({
  isSecureContext: true,
  location: { protocol: 'https:', hostname: 'notes.example.test' },
  crypto: webcrypto,
  WebSocket: class FakeWebSocket {},
  Worker: class FakeWorker {},
  indexedDB: { open: () => undefined },
  WebAssembly: { validate: (bytes) => WebAssembly.validate(bytes) },
  localStorage: workingStorage(),
  sessionStorage: workingStorage(),
  navigator: healthyNavigator(),
  document: { visibilityState: 'visible' },
  Notification: { permission: 'granted' },
  ...overrides,
})

/** A subtle implementation that resolves with the wrong bytes rather than failing. */
const shimmedSubtle = (): SubtleCryptoLike => ({
  digest: () => Promise.resolve(new Uint8Array(32).buffer),
  importKey: () => Promise.resolve({}),
  encrypt: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
  decrypt: () => Promise.resolve(new Uint8Array([9, 9, 9]).buffer),
})

const throwingSubtle = (): SubtleCryptoLike => ({
  digest: () => Promise.reject(new Error('refused')),
  importKey: () => Promise.reject(new Error('refused')),
  encrypt: () => Promise.reject(new Error('refused')),
  decrypt: () => Promise.reject(new Error('refused')),
})

const hangingSubtle = (): SubtleCryptoLike => ({
  digest: () => new Promise<ArrayBuffer>(() => undefined),
  importKey: () => new Promise<unknown>(() => undefined),
  encrypt: () => new Promise<ArrayBuffer>(() => undefined),
  decrypt: () => new Promise<ArrayBuffer>(() => undefined),
})

/* -------------------------------------------------------------------------- */
/* Lookups that fail loudly                                                   */
/* -------------------------------------------------------------------------- */

const allRows = (model: SectionModel): readonly DiagnosticRow[] => model.blocks.flatMap((block) => block.rows)

const allFindings = (model: SectionModel): readonly DiagnosticFinding[] =>
  model.blocks.flatMap((block) => block.findings)

/**
 * A missing row THROWS rather than returning undefined.
 *
 * A renamed label would otherwise turn every assertion about that row into a
 * silent pass, which is the same vacuity as a skipped suite wearing different
 * clothes.
 */
const rowOf = (model: SectionModel, label: string): DiagnosticRow => {
  const found = allRows(model).find((row) => row.label === label)
  if (found === undefined) {
    throw new Error(
      `no row labelled "${label}" — the model has: ${allRows(model)
        .map((row) => row.label)
        .join(' | ')}`,
    )
  }
  return found
}

const findingOf = (model: SectionModel, code: string): DiagnosticFinding | undefined =>
  allFindings(model).find((finding) => finding.code === code)

const codesOf = (model: SectionModel): string[] => allFindings(model).map((finding) => String(finding.code))

const sectionFor = async (runtime: BrowserRuntime, timeoutMs = 2000): Promise<SectionModel> =>
  buildBrowserSection({ observations: await observeBrowserCapabilities(runtime, { timeoutMs }) })

/* -------------------------------------------------------------------------- */
/* The collector, against a real implementation                               */
/* -------------------------------------------------------------------------- */

describe('observeBrowserCapabilities against a real Web Crypto implementation', () => {
  it('is handed an implementation that genuinely works, so the success path is not a skip', () => {
    expect(typeof webcrypto.subtle.digest).toBe('function')
    expect(typeof webcrypto.subtle.importKey).toBe('function')
    expect(typeof webcrypto.getRandomValues).toBe('function')
  })

  it('pins the expected digest to what a real implementation actually produces', async () => {
    const digested = await webcrypto.subtle.digest('SHA-256', probeInputBytes())

    expect(Buffer.from(digested).toString('hex')).toBe(PROBE_DIGEST_SHA256_HEX)
  })

  it('reports ok for every attempted cryptographic operation', async () => {
    const observed = await observeBrowserCapabilities(healthyRuntime())

    expect(observed.subtlePresent).toBe(true)
    expect(observed.digest).toBe('ok')
    expect(observed.aesRoundTrip).toBe('ok')
    expect(observed.randomValues).toBe('ok')
  })

  it('reports unavailable, not failed, when there is no crypto object to attempt against', async () => {
    const observed = await observeBrowserCapabilities(healthyRuntime({ crypto: undefined }))

    expect(observed.subtlePresent).toBe(false)
    expect(observed.digest).toBe('unavailable')
    expect(observed.aesRoundTrip).toBe('unavailable')
    expect(observed.randomValues).toBe('unavailable')
  })

  it('reports mismatch when a shim resolves with the wrong bytes', async () => {
    const observed = await observeBrowserCapabilities(
      healthyRuntime({ crypto: { subtle: shimmedSubtle(), getRandomValues: () => undefined } }),
    )

    expect(observed.subtlePresent).toBe(true)
    expect(observed.digest).toBe('mismatch')
    expect(observed.aesRoundTrip).toBe('mismatch')
    expect(observed.randomValues).toBe('mismatch')
  })

  it('reports threw when the operations reject', async () => {
    const observed = await observeBrowserCapabilities(
      healthyRuntime({
        crypto: {
          subtle: throwingSubtle(),
          getRandomValues: () => {
            throw new Error('refused')
          },
        },
      }),
    )

    expect(observed.digest).toBe('threw')
    expect(observed.aesRoundTrip).toBe('threw')
    expect(observed.randomValues).toBe('threw')
  })

  it('reports timed-out, and resolves, when the operations never settle', async () => {
    const observed = await observeBrowserCapabilities(healthyRuntime({ crypto: { subtle: hangingSubtle() } }), {
      timeoutMs: 5,
    })

    expect(observed.digest).toBe('timed-out')
    expect(observed.aesRoundTrip).toBe('timed-out')
  })

  it('reports unavailable when subtle exists but the method this probe needs does not', async () => {
    const observed = await observeBrowserCapabilities(healthyRuntime({ crypto: { subtle: {} } }))

    expect(observed.subtlePresent).toBe(true)
    expect(observed.digest).toBe('unavailable')
    expect(observed.aesRoundTrip).toBe('unavailable')
  })
})

/* -------------------------------------------------------------------------- */
/* The collector, over a runtime that bites                                   */
/* -------------------------------------------------------------------------- */

describe('observeBrowserCapabilities over hostile runtimes', () => {
  it('distinguishes a localStorage accessor that throws from one that is absent', async () => {
    const throwing = healthyRuntime()
    Object.defineProperty(throwing, 'localStorage', {
      get: () => {
        throw new Error('site data blocked')
      },
    })

    const blocked = await observeBrowserCapabilities(throwing)
    const absent = await observeBrowserCapabilities(healthyRuntime({ localStorage: undefined }))

    expect(blocked.localStorageAccess).toBe('threw')
    expect(blocked.localStorageWrite).toBe('unavailable')
    expect(absent.localStorageAccess).toBe('absent')
    expect(absent.localStorageWrite).toBe('unavailable')
  })

  it('reports a write round trip that completes, one that throws and one that is silently dropped', async () => {
    const ok = await observeBrowserCapabilities(healthyRuntime())
    const refusing = await observeBrowserCapabilities(
      healthyRuntime({
        localStorage: {
          setItem: () => {
            throw new Error('quota')
          },
          getItem: () => null,
          removeItem: () => undefined,
        },
      }),
    )
    const dropping = await observeBrowserCapabilities(
      healthyRuntime({
        localStorage: { setItem: () => undefined, getItem: () => null, removeItem: () => undefined },
      }),
    )

    expect(ok.localStorageWrite).toBe('ok')
    expect(ok.localStorageAccess).toBe('reachable')
    expect(refusing.localStorageWrite).toBe('threw')
    expect(refusing.localStorageAccess).toBe('reachable')
    expect(dropping.localStorageWrite).toBe('mismatch')
  })

  it('leaves no probe key behind in a store that works', async () => {
    const store = workingStorage()
    await observeBrowserCapabilities(healthyRuntime({ localStorage: store }))

    const getItem = store.getItem
    expect(typeof getItem).toBe('function')
    expect(getItem?.('__srn_diagnostics_storage_probe__')).toBeNull()
  })

  it('resolves rather than throwing when every property access raises', async () => {
    const hostile = {} as BrowserRuntime
    for (const key of [
      'isSecureContext',
      'location',
      'crypto',
      'WebSocket',
      'Worker',
      'indexedDB',
      'WebAssembly',
      'localStorage',
      'sessionStorage',
      'navigator',
      'document',
      'Notification',
    ]) {
      Object.defineProperty(hostile, key, {
        get: () => {
          throw new Error(`denied: ${key}`)
        },
      })
    }

    const observed = await observeBrowserCapabilities(hostile)

    expect(observed.secureContext).toBeUndefined()
    expect(observed.subtlePresent).toBeUndefined()
    expect(observed.webSocketPresent).toBeUndefined()
    expect(observed.localStorageAccess).toBe('threw')
    expect(observed.engine).toBeUndefined()
  })

  it('does not hang on a storage estimate or a registration query that never settles', async () => {
    const observed = await observeBrowserCapabilities(
      healthyRuntime({
        navigator: healthyNavigator({
          storage: { estimate: () => new Promise(() => undefined), persisted: () => new Promise(() => undefined) },
          serviceWorker: { controller: null, getRegistrations: () => new Promise(() => undefined) },
        }),
      }),
      { timeoutMs: 5 },
    )

    expect(observed.storageEstimate).toBe('timed-out')
    expect(observed.storageUsedFraction).toBeUndefined()
    expect(observed.storagePersisted).toBeUndefined()
    expect(observed.serviceWorkerRegistrations).toBeUndefined()
    expect(observed.serviceWorkerControlling).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* The collector's reductions                                                 */
/* -------------------------------------------------------------------------- */

describe('observeBrowserCapabilities reductions', () => {
  it('reduces the quota to a share and whole gigabytes', async () => {
    const observed = await observeBrowserCapabilities(
      healthyRuntime({
        navigator: healthyNavigator({
          storage: {
            estimate: () => Promise.resolve({ usage: 3.6 * 1024 * 1024 * 1024, quota: 4 * 1024 * 1024 * 1024 }),
          },
        }),
      }),
    )

    expect(observed.storageEstimate).toBe('ok')
    expect(observed.storageUsedFraction).toBeCloseTo(0.9)
    expect(observed.storageQuotaWholeGb).toBe(4)
    expect(observed.storagePersisted).toBeUndefined()
  })

  it('leaves the used share unreported rather than dividing by a zero quota', async () => {
    const observed = await observeBrowserCapabilities(
      healthyRuntime({
        navigator: healthyNavigator({ storage: { estimate: () => Promise.resolve({ usage: 10, quota: 0 }) } }),
      }),
    )

    expect(observed.storageEstimate).toBe('ok')
    expect(observed.storageUsedFraction).toBeUndefined()
    expect(observed.storageQuotaWholeGb).toBe(0)
  })

  it('validates a real WebAssembly module, and separates a refusal from an absence', async () => {
    const real = await observeBrowserCapabilities(healthyRuntime())
    const refusing = await observeBrowserCapabilities(healthyRuntime({ WebAssembly: { validate: () => false } }))
    const throwing = await observeBrowserCapabilities(
      healthyRuntime({
        WebAssembly: {
          validate: () => {
            throw new Error('disabled by policy')
          },
        },
      }),
    )
    const absent = await observeBrowserCapabilities(healthyRuntime({ WebAssembly: undefined }))

    expect(real.wasmPresent).toBe(true)
    expect(real.wasmValidate).toBe('ok')
    expect(refusing.wasmValidate).toBe('mismatch')
    expect(throwing.wasmValidate).toBe('threw')
    expect(absent.wasmPresent).toBe(false)
    expect(absent.wasmValidate).toBe('unavailable')
  })

  it('treats loopback origins as loopback and nothing else', async () => {
    const hosts: [string, boolean][] = [
      ['localhost', true],
      ['app.localhost', true],
      ['127.0.0.1', true],
      ['[::1]', true],
      ['notes.example.test', false],
      ['localhost.attacker.example', false],
    ]

    for (const [hostname, expected] of hosts) {
      const observed = await observeBrowserCapabilities(healthyRuntime({ location: { protocol: 'http:', hostname } }))
      expect(observed.loopbackOrigin).toBe(expected)
    }
  })

  it('buckets the engine from client hints, and from the user agent where there are none', async () => {
    const cases: [Partial<NavigatorLike>, string | undefined][] = [
      [{ userAgentData: { brands: [{ brand: 'Google Chrome' }] } }, 'chromium'],
      [{ userAgentData: { brands: [{ brand: 'Some Other Shell' }] } }, 'unknown'],
      [{ userAgent: 'Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/131.0' }, 'gecko'],
      [{ userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15' }, 'webkit'],
      [{ userAgent: 'Mozilla/5.0 (X11; Linux) AppleWebKit/537.36 Chrome/129.0.0.0 Safari/537.36' }, 'chromium'],
      [{ userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/129.0 Mobile/15E148 Safari/604.1' }, 'webkit'],
      [{ userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 FxiOS/131.0 Mobile/15E148 Safari/605.1.15' }, 'webkit'],
      // The two above reach webkit by TWO routes — the wrapper check and the
      // AppleWebKit fallback — so neither of them can prove the wrapper check
      // exists. These two carry a wrapper token AND the token the chromium and
      // gecko branches match, which is the only shape in which the precedence
      // is observable at all.
      [
        { userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/129.0 Chrome/129.0.0.0 Mobile Safari/604.1' },
        'webkit',
      ],
      [
        { userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 FxiOS/131.0 Firefox/131.0 Mobile Safari/605.1.15' },
        'webkit',
      ],
      [{ userAgent: 'something nobody has ever shipped' }, 'unknown'],
      [{}, undefined],
    ]

    for (const [navigatorOverride, expected] of cases) {
      const observed = await observeBrowserCapabilities(
        healthyRuntime({ navigator: { ...navigatorOverride } as NavigatorLike }),
      )
      expect(observed.engine).toBe(expected)
    }
  })

  it('buckets the platform from client hints, and from the user agent where there are none', async () => {
    const cases: [Partial<NavigatorLike>, string | undefined][] = [
      [{ userAgentData: { platform: 'macOS' } }, 'macos'],
      [{ userAgentData: { platform: 'Chrome OS' } }, 'chromeos'],
      [{ userAgentData: { platform: 'Something New' } }, 'unknown'],
      [{ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel)' }, 'android'],
      [{ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)' }, 'ios'],
      [{ userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)' }, 'chromeos'],
      [{ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, 'windows'],
      [{ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }, 'macos'],
      [{ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }, 'linux'],
      [{}, undefined],
    ]

    for (const [navigatorOverride, expected] of cases) {
      const observed = await observeBrowserCapabilities(
        healthyRuntime({ navigator: { ...navigatorOverride } as NavigatorLike }),
      )
      expect(observed.platform).toBe(expected)
    }
  })

  it('carries neither the user agent string nor the hostname out of the collector', async () => {
    const observed = await observeBrowserCapabilities(
      healthyRuntime({
        location: { protocol: 'https:', hostname: 'vault.PRIVATE-HOST-MARKER.example' },
        navigator: healthyNavigator({
          userAgentData: undefined,
          userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/129.0.0.0 Safari/537.36 PRIVATE-UA-MARKER',
        }),
      }),
    )
    const serialised = JSON.stringify(observed)

    expect(observed.engine).toBe('chromium')
    expect(observed.platform).toBe('windows')
    expect(serialised).not.toContain('PRIVATE-UA-MARKER')
    expect(serialised).not.toContain('PRIVATE-HOST-MARKER')
    expect(serialised).not.toContain('Mozilla')
  })
})

/* -------------------------------------------------------------------------- */
/* The section model: evidence, caps and verdicts                             */
/* -------------------------------------------------------------------------- */

describe('buildBrowserSection on a healthy browser', () => {
  it('reports the operations it attempted as healthy on direct evidence', async () => {
    const model = await sectionFor(healthyRuntime())

    for (const label of [
      'SHA-256 digest of a fixed input',
      'AES-GCM import, encrypt and decrypt',
      'Secure random generation',
      'localStorage write round trip',
      'WebAssembly module validation',
    ]) {
      const row = rowOf(model, label)
      expect(row.value).toBe('ok')
      expect(row.claimed).toBe('healthy')
      expect(row.verdict).toBe('healthy')
      expect(row.evidence.kind).toBe('direct')
      expect(row.caveat).toBeUndefined()
    }
  })

  it('caps every row that could only be feature-detected, one row at a time', async () => {
    const model = await sectionFor(healthyRuntime())

    const subtle = rowOf(model, 'Web Crypto present')
    expect(subtle.value).toBe('set')
    expect(subtle.claimed).toBe('healthy')
    expect(subtle.verdict).toBe('undetermined')
    expect(subtle.tone).toBe('neutral')
    expect(subtle.evidence.kind).toBe('proxy')
    expect(subtle.caveat).toContain('crypto.subtle exists as an object')

    const socket = rowOf(model, 'WebSocket constructor')
    expect(socket.claimed).toBe('healthy')
    expect(socket.verdict).toBe('undetermined')
    expect(socket.caveat).toContain('WebSocket constructor exists')

    const worker = rowOf(model, 'Worker constructor')
    expect(worker.claimed).toBe('healthy')
    expect(worker.verdict).toBe('undetermined')

    const database = rowOf(model, 'IndexedDB present')
    expect(database.claimed).toBe('healthy')
    expect(database.verdict).toBe('undetermined')
    expect(database.caveat).toContain('indexedDB accessor exists')

    const network = rowOf(model, 'Network flag')
    expect(network.value).toBe('online')
    expect(network.claimed).toBe('healthy')
    expect(network.verdict).toBe('undetermined')

    const cookies = rowOf(model, 'Cookies enabled')
    expect(cookies.value).toBe('enabled')
    expect(cookies.claimed).toBe('healthy')
    expect(cookies.verdict).toBe('undetermined')

    const clipboard = rowOf(model, 'Clipboard write')
    expect(clipboard.claimed).toBe('healthy')
    expect(clipboard.verdict).toBe('undetermined')
  })

  it('claims nothing more than informational for the rows that are context', async () => {
    const model = await sectionFor(healthyRuntime())

    for (const label of ['Page scheme', 'Loopback origin', 'Engine', 'Platform', 'Logical CPU cores']) {
      const row = rowOf(model, label)
      expect(row.claimed).toBe('informational')
      expect(row.verdict).toBe('informational')
      expect(row.tone).toBe('neutral')
    }
  })

  it('raises no findings and reports the secure context directly', async () => {
    const model = await sectionFor(healthyRuntime())

    expect(codesOf(model)).toEqual([])
    const secure = rowOf(model, 'Secure context')
    expect(secure.value).toBe('secure')
    expect(secure.verdict).toBe('healthy')
    expect(secure.evidence.kind).toBe('direct')
    expect(model.worstVerdict).toBe('undetermined')
    expect(model.worst).toBe('neutral')
  })

  it('reduces the storage figures the way the report permits', async () => {
    const model = await sectionFor(healthyRuntime())

    const used = rowOf(model, 'Origin storage used')
    expect(used.value).toBe('0-25%')
    expect(used.verdict).toBe('healthy')
    expect(used.evidence.kind).toBe('direct')

    const quota = rowOf(model, 'Origin quota, whole GB')
    expect(quota.value).toBe('8')

    const persisted = rowOf(model, 'Persistent storage')
    expect(persisted.value).toBe('granted')
    expect(persisted.verdict).toBe('healthy')
  })
})

describe('buildBrowserSection when a capability is absent', () => {
  it('does not let a missing capability read as healthy, and keeps the broken verdict on a necessary condition', async () => {
    const model = await sectionFor(healthyRuntime({ crypto: undefined }))

    const subtle = rowOf(model, 'Web Crypto present')
    expect(subtle.value).toBe('not set')
    expect(subtle.claimed).toBe('broken')
    expect(subtle.verdict).toBe('broken')
    expect(subtle.tone).toBe('bad')
    expect(subtle.evidence.kind).toBe('proxy')
    expect(subtle.caveat).toContain('conclusive')

    expect(rowOf(model, 'SHA-256 digest of a fixed input').value).toBe('unavailable')
    expect(rowOf(model, 'SHA-256 digest of a fixed input').verdict).toBe('undetermined')
    expect(rowOf(model, 'SHA-256 digest of a fixed input').evidence.kind).toBe('absent')
    expect(model.worstVerdict).toBe('broken')
  })

  it('names the insecure context as the cause when Web Crypto is missing in plain HTTP', async () => {
    const model = await sectionFor(
      healthyRuntime({
        isSecureContext: false,
        location: { protocol: 'http:', hostname: 'notes.example.test' },
        crypto: undefined,
      }),
    )

    const secure = rowOf(model, 'Secure context')
    expect(secure.value).toBe('not secure')
    expect(secure.verdict).toBe('broken')
    expect(secure.evidence.kind).toBe('direct')

    const insecure = findingOf(model, 'INSECURE_CONTEXT')
    expect(insecure?.verdict).toBe('broken')
    expect(insecure?.remedy?.effort).toBe('restart')
    expect(insecure?.remedy?.steps.join(' ')).toContain('localhost')

    const crypto = findingOf(model, 'WEB_CRYPTO_UNAVAILABLE')
    expect(crypto?.remedy?.effort).toBe('restart')
    expect(crypto?.remedy?.because.join(' ')).toContain('isSecureContext is false')
  })

  it('blames the browser, not the deployment, when Web Crypto is missing in a secure context', async () => {
    const model = await sectionFor(healthyRuntime({ crypto: undefined }))
    const crypto = findingOf(model, 'WEB_CRYPTO_UNAVAILABLE')

    expect(crypto?.remedy?.effort).toBe('device')
    expect(crypto?.remedy?.because.join(' ')).toContain('secure context')
    expect(codesOf(model)).not.toContain('INSECURE_CONTEXT')
  })

  it('reports a present-but-wrong implementation separately from an absent one', async () => {
    const shimmed = await sectionFor(healthyRuntime({ crypto: { subtle: shimmedSubtle() } }))
    const absent = await sectionFor(healthyRuntime({ crypto: undefined }))

    expect(rowOf(shimmed, 'SHA-256 digest of a fixed input').value).toBe('mismatch')
    expect(rowOf(shimmed, 'SHA-256 digest of a fixed input').verdict).toBe('broken')
    expect(rowOf(shimmed, 'Web Crypto present').verdict).toBe('undetermined')
    expect(codesOf(shimmed)).toContain('WEB_CRYPTO_OPERATION_FAILED')
    expect(codesOf(shimmed)).not.toContain('WEB_CRYPTO_UNAVAILABLE')

    expect(codesOf(absent)).toContain('WEB_CRYPTO_UNAVAILABLE')
    expect(codesOf(absent)).not.toContain('WEB_CRYPTO_OPERATION_FAILED')
  })

  it('keeps the transport finding broken on a necessary-condition proxy and names what is missing', async () => {
    const model = await sectionFor(healthyRuntime({ Worker: undefined, indexedDB: undefined }))

    expect(rowOf(model, 'Worker constructor').verdict).toBe('broken')
    expect(rowOf(model, 'IndexedDB present').verdict).toBe('broken')
    expect(rowOf(model, 'WebSocket constructor').verdict).toBe('undetermined')

    const finding = findingOf(model, 'TRANSPORT_UNSUPPORTED_BROWSER')
    expect(finding?.claimed).toBe('broken')
    expect(finding?.verdict).toBe('broken')
    expect(finding?.evidence.kind).toBe('proxy')
    expect(finding?.remedy?.summary).toContain('is missing Worker, IndexedDB.')
  })

  it('reports blocked site data as broken from an attempted write, not from a feature detect', async () => {
    const model = await sectionFor(
      healthyRuntime({
        localStorage: { setItem: () => undefined, getItem: () => null, removeItem: () => undefined },
      }),
    )

    const write = rowOf(model, 'localStorage write round trip')
    expect(write.value).toBe('mismatch')
    expect(write.verdict).toBe('broken')
    expect(write.evidence.kind).toBe('direct')
    expect(findingOf(model, 'LOCAL_STORAGE_UNWRITABLE')?.remedy?.effort).toBe('device')
  })

  it('reports disabled cookies, a missing clipboard and an offline flag as findings', async () => {
    const model = await sectionFor(
      healthyRuntime({
        navigator: healthyNavigator({ cookieEnabled: false, onLine: false, clipboard: undefined }),
      }),
    )

    expect(rowOf(model, 'Cookies enabled').verdict).toBe('broken')
    expect(rowOf(model, 'Network flag').verdict).toBe('broken')
    expect(rowOf(model, 'Clipboard write').verdict).toBe('broken')
    expect(codesOf(model)).toEqual(
      expect.arrayContaining(['COOKIES_DISABLED', 'CLIPBOARD_WRITE_UNAVAILABLE', 'BROWSER_OFFLINE']),
    )
    expect(findingOf(model, 'BROWSER_OFFLINE')?.remedy?.effort).toBe('wait')
  })

  it('warns about a nearly full origin and says whether eviction is possible', async () => {
    const atRisk = await sectionFor(
      healthyRuntime({
        navigator: healthyNavigator({
          storage: {
            estimate: () => Promise.resolve({ usage: 95, quota: 100 }),
            persisted: () => Promise.resolve(false),
          },
        }),
      }),
    )
    const protectedOrigin = await sectionFor(
      healthyRuntime({
        navigator: healthyNavigator({
          storage: {
            estimate: () => Promise.resolve({ usage: 95, quota: 100 }),
            persisted: () => Promise.resolve(true),
          },
        }),
      }),
    )

    expect(rowOf(atRisk, 'Origin storage used').value).toBe('90-100%')
    expect(rowOf(atRisk, 'Origin storage used').verdict).toBe('degraded')
    expect(findingOf(atRisk, 'ORIGIN_STORAGE_NEARLY_FULL')?.detail).toContain('evict')
    expect(findingOf(protectedOrigin, 'ORIGIN_STORAGE_NEARLY_FULL')?.detail).toContain('refuse writes')
  })

  it('degrades rather than breaks when only the non-essential capabilities fail', async () => {
    const model = await sectionFor(
      healthyRuntime({
        WebAssembly: { validate: () => false },
        sessionStorage: { setItem: () => undefined, getItem: () => null, removeItem: () => undefined },
      }),
    )

    expect(rowOf(model, 'WebAssembly module validation').verdict).toBe('degraded')
    expect(rowOf(model, 'sessionStorage write round trip').verdict).toBe('degraded')
    expect(model.worstVerdict).toBe('degraded')
  })

  /**
   * The renderer keys rows on their label, blocks on their heading and findings
   * on their code. A duplicate in any of the three silently drops a row from the
   * screen — the section would be correct and partly invisible, which is the
   * failure mode a model-only test is otherwise blind to. Asserted on the worst
   * browser this suite can describe, because that is the model with the most of
   * everything in it.
   */
  it('keys every row, block and finding uniquely, even with everything wrong at once', async () => {
    const model = await sectionFor(
      healthyRuntime({
        isSecureContext: false,
        location: { protocol: 'http:', hostname: 'notes.example.test' },
        crypto: undefined,
        Worker: undefined,
        indexedDB: undefined,
        localStorage: { setItem: () => undefined, getItem: () => null, removeItem: () => undefined },
        WebAssembly: undefined,
        navigator: healthyNavigator({
          cookieEnabled: false,
          onLine: false,
          clipboard: undefined,
          storage: {
            estimate: () => Promise.resolve({ usage: 99, quota: 100 }),
            persisted: () => Promise.resolve(false),
          },
        }),
      }),
    )

    const labels = allRows(model).map((row) => String(row.label))
    const headings = model.blocks.map((block) => String(block.heading))
    const codes = codesOf(model)

    expect(new Set(labels).size).toBe(labels.length)
    expect(new Set(headings).size).toBe(headings.length)
    expect(codes.length).toBeGreaterThanOrEqual(7)
    expect(new Set(codes).size).toBe(codes.length)
    expect(model.worstVerdict).toBe('broken')
    expect(model.headline?.verdict).toBe('broken')
  })

  /**
   * The effort chip is the first thing read on a remedy and for most of this
   * section it is the whole instruction, so it has to be the right word.
   *
   * Nothing here waits on a newer build of this app: every finding is either a
   * change on this device, a serving decision, or something to wait out. This
   * asserts that over every finding at once rather than per remedy, because the
   * way `client-update` got used for nine of them was one shared alias, and one
   * shared alias is exactly what a per-remedy test leaves room for.
   */
  it('labels every finding by where its fix actually lives, and waits on no client release', async () => {
    const model = await sectionFor(
      healthyRuntime({
        isSecureContext: false,
        location: { protocol: 'http:', hostname: 'notes.example.test' },
        crypto: undefined,
        Worker: undefined,
        indexedDB: undefined,
        localStorage: { setItem: () => undefined, getItem: () => null, removeItem: () => undefined },
        WebAssembly: undefined,
        navigator: healthyNavigator({
          cookieEnabled: false,
          onLine: false,
          clipboard: undefined,
          storage: {
            estimate: () => Promise.resolve({ usage: 99, quota: 100 }),
            persisted: () => Promise.resolve(false),
          },
        }),
      }),
    )

    const findings = allFindings(model)
    expect(findings.length).toBeGreaterThanOrEqual(7)

    for (const finding of findings) {
      expect(finding.remedy).toBeDefined()
      expect(finding.remedy?.effort).not.toBe('client-update')
      expect(['device', 'restart', 'wait']).toContain(finding.remedy?.effort)
    }

    // The three that are deliberately not device-side, named so that moving one
    // onto `device` has to be a deliberate edit here too.
    expect(findingOf(model, 'INSECURE_CONTEXT')?.remedy?.effort).toBe('restart')
    expect(findingOf(model, 'WEB_CRYPTO_UNAVAILABLE')?.remedy?.effort).toBe('restart')
    expect(findingOf(model, 'BROWSER_OFFLINE')?.remedy?.effort).toBe('wait')

    for (const code of [
      'TRANSPORT_UNSUPPORTED_BROWSER',
      'LOCAL_STORAGE_UNWRITABLE',
      'ORIGIN_STORAGE_NEARLY_FULL',
      'COOKIES_DISABLED',
      'CLIPBOARD_WRITE_UNAVAILABLE',
    ]) {
      expect(findingOf(model, code)?.remedy?.effort).toBe('device')
    }

    // The chip text, not just the key: "Client update" beside "allow site data"
    // was the mismatch this member exists to end.
    expect(EFFORT_LABEL.device).toBe('On this device')
    expect(EFFORT_LABEL.device).not.toBe(EFFORT_LABEL['client-update'])
  })

  /**
   * The summaries no longer have to apologise for their own chip.
   *
   * Every device-side summary used to carry a sentence saying no server change
   * helps, because the chip said "Client update" and the sentence was the only
   * place the truth could go. The chip says it now, so a summary that still says
   * it is saying it twice.
   */
  it('leaves the "no server change helps" disclaimer to the chip', async () => {
    const model = await sectionFor(
      healthyRuntime({
        crypto: undefined,
        navigator: healthyNavigator({ cookieEnabled: false, clipboard: undefined }),
      }),
    )
    const clockModel = buildBrowserSection({
      observations: await observeBrowserCapabilities(healthyRuntime()),
      clock: { serverCapturedAtMs: 1_000_000, localReceivedAtMs: 1_000_000 + 600_000 },
    })

    for (const finding of [...allFindings(model), ...allFindings(clockModel)]) {
      if (finding.remedy?.effort !== 'device') {
        continue
      }
      expect(finding.remedy.summary).not.toContain('no server setting')
      expect(finding.remedy.summary).not.toContain('nothing on the server')
      expect(finding.remedy.summary).not.toContain('no server change')
    }

    expect(findingOf(clockModel, 'CLIENT_CLOCK_SKEW')?.remedy?.effort).toBe('device')
    expect(findingOf(clockModel, 'CLIENT_CLOCK_SKEW')?.remedy?.summary).toContain('Fix the clock on this device')
  })
})

/* -------------------------------------------------------------------------- */
/* Absent is not false                                                        */
/* -------------------------------------------------------------------------- */

describe('buildBrowserSection with nothing observed', () => {
  it('claims absent evidence and no verdict for every single row', () => {
    const model = buildBrowserSection()
    const rows = allRows(model)

    expect(rows).toHaveLength(36)
    for (const row of rows) {
      expect({ label: String(row.label), kind: row.evidence.kind, verdict: row.verdict }).toEqual({
        label: String(row.label),
        kind: 'absent',
        verdict: 'undetermined',
      })
    }
  })

  it('reads "not reported" rather than a negative answer', () => {
    const model = buildBrowserSection()

    expect(rowOf(model, 'Secure context').value).toBe('not reported')
    expect(rowOf(model, 'Web Crypto present').value).toBe('not reported')
    expect(rowOf(model, 'Loopback origin').value).toBe('not reported')
    expect(rowOf(model, 'Origin storage used').value).toBe('not reported')
    expect(rowOf(model, 'Offset from the server clock').value).toBe('not reported')
    expect(codesOf(model)).toEqual([])
    expect(model.worstVerdict).toBe('undetermined')
  })

  it('leaves the probe-outcome rows unavailable rather than failed when nothing was attempted', async () => {
    const model = await sectionFor(healthyRuntime({ crypto: undefined, WebAssembly: undefined }))

    for (const label of [
      'SHA-256 digest of a fixed input',
      'AES-GCM import, encrypt and decrypt',
      'Secure random generation',
      'WebAssembly module validation',
    ]) {
      const row = rowOf(model, label)
      expect(row.value).toBe('unavailable')
      expect(row.verdict).toBe('undetermined')
      expect(row.evidence.kind).toBe('absent')
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Closed enums, and what reaches the report                                  */
/* -------------------------------------------------------------------------- */

describe('buildBrowserSection output discipline', () => {
  it('refuses an unexpected enum value instead of echoing it', async () => {
    const model = await sectionFor(
      healthyRuntime({
        location: { protocol: 'javascript:ECHOED-SCHEME-MARKER', hostname: 'localhost' },
        document: { visibilityState: 'ECHOED-VISIBILITY-MARKER' },
        Notification: { permission: 'ECHOED-PERMISSION-MARKER' },
        navigator: healthyNavigator({ deviceMemory: 3 }),
      }),
    )

    expect(rowOf(model, 'Page scheme').value).toBe('other (unrecognised)')
    expect(rowOf(model, 'Page visibility').value).toBe('other (unrecognised)')
    expect(rowOf(model, 'Notification permission').value).toBe('other (unrecognised)')
    expect(rowOf(model, 'Device memory, GB').value).toBe('other (unrecognised)')

    const everything = [...model.reportLines, ...allRows(model).map((row) => `${row.label}${row.value}${row.note}`)]
    for (const marker of ['ECHOED-SCHEME-MARKER', 'ECHOED-VISIBILITY-MARKER', 'ECHOED-PERMISSION-MARKER']) {
      expect(everything.join('\n')).not.toContain(marker)
    }
  })

  it('admits the coarse device-memory figures the API is specified to report', async () => {
    const half = await sectionFor(healthyRuntime({ navigator: healthyNavigator({ deviceMemory: 0.5 }) }))
    const four = await sectionFor(healthyRuntime({ navigator: healthyNavigator({ deviceMemory: 4 }) }))

    expect(rowOf(half, 'Device memory, GB').value).toBe('0.5')
    expect(rowOf(four, 'Device memory, GB').value).toBe('4')
  })

  it('keeps the user agent and the hostname out of the copyable report, and says so', async () => {
    const model = await sectionFor(
      healthyRuntime({
        location: { protocol: 'https:', hostname: 'vault.PRIVATE-HOST-MARKER.example' },
        navigator: healthyNavigator({
          userAgentData: undefined,
          userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/129.0.0.0 PRIVATE-UA-MARKER',
        }),
      }),
    )
    const report = model.reportLines.join('\n')

    expect(report).not.toContain('PRIVATE-UA-MARKER')
    expect(report).not.toContain('PRIVATE-HOST-MARKER')
    expect(report).toContain('- User agent string: withheld from this report on purpose')
    expect(report).toContain('- Local database open test: operator-triggered on the Checks sub-tab')
    expect(report).toContain('## Browser')
    expect(report).toContain('- [v] Engine: chromium')
  })

  it('builds the five blocks it always builds, in order', () => {
    const model = buildBrowserSection()

    expect(model.id).toBe('browser')
    expect(model.title).toBe('Browser')
    expect(model.blocks.map((block) => String(block.heading))).toEqual([
      'Hard requirements',
      'Storage',
      'Supporting capabilities',
      'Browser identity',
      'Clock',
    ])
  })

  it('shows only the probe results tagged for this section, and only when there are some', () => {
    const none = buildBrowserSection({
      outcomes: [{ name: 'Ticket mint', passed: true, detail: 'd', reportDetail: 'r', section: 'websocket' }],
    })
    const some = buildBrowserSection({
      outcomes: [
        { name: 'Ticket mint', passed: true, detail: 'd', reportDetail: 'r', section: 'websocket' },
        { name: 'Local database open', passed: false, detail: 'd', reportDetail: 'r', section: 'browser' },
      ],
    })

    expect(none.blocks.map((block) => String(block.heading))).not.toContain('Operator-triggered checks')
    const checks = some.blocks.find((block) => String(block.heading) === 'Operator-triggered checks')
    expect(checks?.outcomes).toHaveLength(1)
    expect(checks?.outcomes?.[0]?.name).toBe('Local database open')
  })
})

/* -------------------------------------------------------------------------- */
/* The clock                                                                  */
/* -------------------------------------------------------------------------- */

describe('buildBrowserSection clock block', () => {
  const observations: BrowserObservations = {}

  it('reports an aligned clock as healthy on direct evidence', () => {
    const model = buildBrowserSection({
      observations,
      clock: { serverCapturedAtMs: 1_700_000_000_000, localReceivedAtMs: 1_700_000_000_400 },
    })
    const row = rowOf(model, 'Offset from the server clock')

    expect(row.value).toBe('under 1s aligned')
    expect(row.verdict).toBe('healthy')
    expect(row.evidence.kind).toBe('direct')
    expect(codesOf(model)).toEqual([])
  })

  it('degrades past a minute and breaks past five, naming the direction', () => {
    const degraded = buildBrowserSection({
      observations,
      clock: { serverCapturedAtMs: 1_700_000_000_000, localReceivedAtMs: 1_700_000_090_000 },
    })
    const broken = buildBrowserSection({
      observations,
      clock: { serverCapturedAtMs: 1_700_000_600_000, localReceivedAtMs: 1_700_000_000_000 },
    })

    expect(rowOf(degraded, 'Offset from the server clock').value).toBe('1m 30s ahead of the server')
    expect(rowOf(degraded, 'Offset from the server clock').verdict).toBe('degraded')
    expect(findingOf(degraded, 'CLIENT_CLOCK_SKEW')?.verdict).toBe('degraded')

    expect(rowOf(broken, 'Offset from the server clock').value).toBe('10m 0s behind the server')
    expect(rowOf(broken, 'Offset from the server clock').verdict).toBe('broken')
    expect(findingOf(broken, 'CLIENT_CLOCK_SKEW')?.verdict).toBe('broken')
    expect(findingOf(broken, 'CLIENT_CLOCK_SKEW')?.remedy?.effort).toBe('device')
  })

  it('invents no request when there is no server timestamp to compare against', () => {
    const model = buildBrowserSection({ observations })
    const row = rowOf(model, 'Offset from the server clock')

    expect(row.value).toBe('not reported')
    expect(row.verdict).toBe('undetermined')
    expect(row.evidence.kind).toBe('absent')
    expect(codesOf(model)).toEqual([])
  })
})
