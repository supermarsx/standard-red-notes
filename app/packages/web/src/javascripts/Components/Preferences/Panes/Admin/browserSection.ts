import type { Remedy, RemedyEffort } from './diagnosticRemedies'
import {
  buildSectionModel,
  diagnosticFinding,
  diagnosticRow,
  EVIDENCE_ABSENT,
  EVIDENCE_DIRECT,
  evidenceProxy,
  outcomesForSection,
  reportLine,
  safeConstant,
  safeCount,
  safeDuration,
  safeEnum,
  safePercentBucket,
  safePresence,
  safeState,
  safeTokens,
  safeYesNo,
  type DiagnosticBlock,
  type DiagnosticFinding,
  type DiagnosticRow,
  type Evidence,
  type SafeValue,
  type SectionModel,
  type SectionTaggedOutcome,
  type Verdict,
} from './diagnosticsSections'

/**
 * Standard Red Notes: the Browser section of the admin diagnostics pane.
 *
 * This is the one section with no server payload, so it is the one section that
 * can be exhaustive about its own subject without a secrecy budget to spend. It
 * is also the section an operator reaches when the app is broken on THIS machine
 * and nowhere else, which is the case the rest of the pane cannot see at all.
 *
 * -------------------------------------------------------------------------------
 * Presence is not support. The whole file is organised around that.
 * -------------------------------------------------------------------------------
 *
 * The cheap way to write this section is `typeof crypto.subtle !== 'undefined'`
 * per row, a green chip each, done. That produces the exact failure the contract
 * in `diagnosticsSections.ts` exists to prevent: a confident claim resting on a
 * signal that does not establish it. A hardened profile, a content blocker, an
 * old WebView and a shimmed `crypto` all expose the object and fail the call.
 *
 * So every capability here is reported in one of two ways, never muddled:
 *
 *   - **An attempted operation.** A real SHA-256 over a fixed input compared with
 *     a constant digest, a real AES-GCM import/encrypt/decrypt round trip, a real
 *     `localStorage` write-read-delete, a real `WebAssembly.validate`. These carry
 *     `EVIDENCE_DIRECT`, because the row describes exactly what was done.
 *   - **A feature detect**, which is a PROXY and says so. `evidenceProxy` caps any
 *     positive claim to `undetermined` and prints the caveat, so "the WebSocket
 *     constructor exists" can never render as "WebSocket works". The absent arm of
 *     the same proxy is marked `necessaryCondition: true` and survives as `broken`
 *     on purpose: a missing constructor IS conclusive, while a present one is not.
 *
 * Reading the chips that follows from that: several rows on a perfectly healthy
 * browser read `Unknown`. That is the intended output, not a defect. The pane is
 * saying "this was detected, not tested", and the rows that WERE tested are the
 * ones beside them reading `OK`.
 *
 * -------------------------------------------------------------------------------
 * No globals, and no user agent string anywhere near the report.
 * -------------------------------------------------------------------------------
 *
 * `observeBrowserCapabilities` takes an injected runtime object and reads nothing
 * from the ambient scope (`setTimeout`, used to bound two calls that are known to
 * hang in private windows, is the sole exception and is confined to one helper).
 * That is not test convenience: this repo has already shipped four
 * `hasSubtle ? describe : describe.skip` suites that passed while asserting
 * nothing, because jsdom has no `crypto.subtle`. A probe that reads globals can
 * only be tested by a suite that skips itself.
 *
 * Every property read is wrapped, because several of these ACCESSORS throw rather
 * than return: `window.localStorage` throws outright in a Firefox private window
 * and under Chrome's "block all site data", so `'localStorage' in window` is not
 * a safe test and neither is reading it.
 *
 * `BrowserObservations` has no field for the user-agent string and no field for a
 * hostname, deliberately, so neither can reach the copyable report through this
 * module even by accident. The engine and platform are reduced to closed buckets
 * INSIDE the collector and the string they were derived from is discarded there.
 * The report is written to be pasted in public and a UA string is fingerprinting
 * material; `extraReportLines` states that withholding, so a reader of the report
 * can tell the difference between "not collected" and "not disclosed".
 */

/* -------------------------------------------------------------------------- */
/* The injected runtime                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every member is optional and every one of them may THROW on access. The shapes
 * are structural and minimal rather than the DOM's own types so that a spec can
 * build a runtime that is missing exactly one capability, which is the only way
 * to prove an absent capability does not read as healthy.
 *
 * The methods are declared with method syntax, not as function-typed properties,
 * so a real `SubtleCrypto` — or Node's `webcrypto`, which is what the spec
 * installs — is assignable without a cast.
 */
/**
 * `Uint8Array<ArrayBuffer>`, never a bare `Uint8Array`.
 *
 * Under the generic typed arrays this toolchain ships, a bare `Uint8Array` widens
 * to `ArrayBufferLike` — which includes `SharedArrayBuffer` — and is then NOT
 * assignable to the DOM's `BufferSource`. A real `SubtleCrypto` would therefore
 * fail to satisfy the shapes below, and the spec could only inject one through a
 * cast, which is exactly the fixture that proves nothing.
 */
export type ProbeBytes = Uint8Array<ArrayBuffer>

export type SubtleCryptoLike = {
  digest?(algorithm: string, data: ProbeBytes): Promise<ArrayBuffer>
  importKey?(
    format: string,
    keyData: ProbeBytes,
    algorithm: unknown,
    extractable: boolean,
    usages: readonly string[],
  ): Promise<unknown>
  encrypt?(algorithm: unknown, key: unknown, data: ProbeBytes): Promise<ArrayBuffer>
  decrypt?(algorithm: unknown, key: unknown, data: ProbeBytes): Promise<ArrayBuffer>
}

export type CryptoLike = {
  subtle?: SubtleCryptoLike
  getRandomValues?(array: ProbeBytes): unknown
}

export type WebStorageLike = {
  setItem?(key: string, value: string): void
  getItem?(key: string): string | null
  removeItem?(key: string): void
}

export type StorageManagerLike = {
  estimate?(): Promise<{ usage?: number; quota?: number }>
  persisted?(): Promise<boolean>
}

export type ServiceWorkerContainerLike = {
  controller?: unknown
  getRegistrations?(): Promise<readonly unknown[]>
}

export type UserAgentDataLike = {
  brands?: readonly { brand?: string; version?: string }[]
  platform?: string
  mobile?: boolean
}

export type NavigatorLike = {
  onLine?: boolean
  cookieEnabled?: boolean
  hardwareConcurrency?: number
  deviceMemory?: number
  storage?: StorageManagerLike
  serviceWorker?: ServiceWorkerContainerLike
  clipboard?: { writeText?: unknown }
  userAgentData?: UserAgentDataLike
  /** Read to derive a closed bucket and then discarded. Never stored, never reported. */
  userAgent?: string
}

export type BrowserRuntime = {
  isSecureContext?: boolean
  location?: { protocol?: string; hostname?: string }
  crypto?: CryptoLike
  WebSocket?: unknown
  Worker?: unknown
  indexedDB?: unknown
  WebAssembly?: { validate?(bytes: ProbeBytes): boolean }
  localStorage?: WebStorageLike
  sessionStorage?: WebStorageLike
  navigator?: NavigatorLike
  document?: { visibilityState?: string }
  Notification?: { permission?: string }
}

/* -------------------------------------------------------------------------- */
/* What an observation may say                                                */
/* -------------------------------------------------------------------------- */

/**
 * The result of one attempted operation.
 *
 * `mismatch` is not a pedantic extra state. A shimmed or polyfilled `crypto` that
 * resolves with the wrong bytes is a real thing, and it is strictly worse than an
 * absent one because it fails silently; `unavailable` is the honest word for "the
 * API this probe needs was not there, so nothing was attempted", which is
 * `undetermined` rather than a failure. `timed-out` is separated from `threw`
 * because a hanging storage call in a private window is a different fault from a
 * refused one.
 */
export const PROBE_OUTCOMES = ['ok', 'mismatch', 'threw', 'timed-out', 'unavailable'] as const

export type ProbeOutcome = (typeof PROBE_OUTCOMES)[number]

/** Whether a property that may throw on access was reachable at all. */
export const ACCESS_OUTCOMES = ['reachable', 'threw', 'absent'] as const

export type AccessOutcome = (typeof ACCESS_OUTCOMES)[number]

export const PAGE_SCHEMES = ['https:', 'http:', 'file:', 'capacitor:', 'ionic:', 'app:', 'chrome-extension:'] as const

export const NOTIFICATION_PERMISSIONS = ['default', 'granted', 'denied'] as const

export const VISIBILITY_STATES = ['visible', 'hidden', 'prerender', 'unloaded'] as const

/** The six magnitudes `navigator.deviceMemory` is specified to report. */
export const DEVICE_MEMORY_VALUES = ['0.25', '0.5', '1', '2', '4', '8'] as const

export const ENGINE_BUCKETS = ['chromium', 'gecko', 'webkit', 'unknown'] as const

export type EngineBucket = (typeof ENGINE_BUCKETS)[number]

export const PLATFORM_BUCKETS = ['windows', 'macos', 'linux', 'android', 'ios', 'chromeos', 'unknown'] as const

export type PlatformBucket = (typeof PLATFORM_BUCKETS)[number]

export const CLOCK_DIRECTIONS = ['ahead of the server', 'behind the server', 'aligned'] as const

export type ClockDirection = (typeof CLOCK_DIRECTIONS)[number]

/**
 * What one collection run observed. Booleans, closed unions, bounded counts and
 * fractions — nothing else fits in this shape, which is the point: there is no
 * member here that could carry a user-agent string, a hostname or an origin, so
 * the report path cannot be handed one from this module.
 *
 * The few plain `string` members are values destined for `safeEnum`, which admits
 * them only against a declared tuple and never echoes anything else.
 */
export type BrowserObservations = {
  secureContext?: boolean
  pageScheme?: string
  loopbackOrigin?: boolean
  subtlePresent?: boolean
  digest?: ProbeOutcome
  aesRoundTrip?: ProbeOutcome
  randomValues?: ProbeOutcome
  webSocketPresent?: boolean
  workerPresent?: boolean
  indexedDbPresent?: boolean
  localStorageAccess?: AccessOutcome
  localStorageWrite?: ProbeOutcome
  sessionStorageAccess?: AccessOutcome
  sessionStorageWrite?: ProbeOutcome
  storageManagerPresent?: boolean
  storageEstimate?: ProbeOutcome
  storageUsedFraction?: number
  storageQuotaWholeGb?: number
  storagePersisted?: boolean
  wasmPresent?: boolean
  wasmValidate?: ProbeOutcome
  serviceWorkerPresent?: boolean
  serviceWorkerControlling?: boolean
  serviceWorkerRegistrations?: number
  notificationPermission?: string
  online?: boolean
  visibilityState?: string
  cookiesEnabled?: boolean
  clipboardWritePresent?: boolean
  logicalCores?: number
  deviceMemoryGb?: number
  engine?: EngineBucket
  platform?: PlatformBucket
  mobileFormFactor?: boolean
  userAgentDataPresent?: boolean
}

/**
 * The one server-sourced number this section reads, supplied by the caller rather
 * than fetched: `capturedAt` from the diagnostics payload, plus the local instant
 * the payload ARRIVED.
 *
 * Both halves are required, and that is the whole design. Comparing a server
 * capture instant against `Date.now()` at render time measures the age of the
 * payload as much as the skew of the clock, which would make every verdict here
 * indirect and therefore `undetermined` — useless. Pinning the local instant to
 * arrival bounds the error at one response's latency, which is what makes
 * `EVIDENCE_DIRECT` honest at a 60-second threshold. If the caller has no payload
 * it passes nothing and the rows read "not reported"; no request is invented to
 * fill them.
 */
export type BrowserClockReading = {
  serverCapturedAtMs: number
  localReceivedAtMs: number
}

/* -------------------------------------------------------------------------- */
/* Probe inputs                                                               */
/* -------------------------------------------------------------------------- */

const PROBE_INPUT = [0x53, 0x52, 0x4e, 0x2d, 0x64, 0x69, 0x61, 0x67, 0x6e, 0x6f, 0x73, 0x74, 0x69, 0x63, 0x73, 0x00]

/** A fresh copy every call: a probe must never hand a caller's buffer around. */
export function probeInputBytes(): ProbeBytes {
  return new Uint8Array(PROBE_INPUT)
}

/**
 * SHA-256 of exactly those bytes.
 *
 * Hardcoding the expectation is what turns the digest row from "the call
 * resolved" into "the call resolved with the right answer", which is the only
 * version of the row that catches a shim. `browserSection.spec.ts` recomputes it
 * with a real implementation, so the constant cannot silently go stale and start
 * reporting `mismatch` on a healthy browser.
 */
export const PROBE_DIGEST_SHA256_HEX = 'cd9249cfa64f1b6fdabebd9ddc78808fc72d54e128483f408a550ab9d5b154e3'

const AES_PROBE_KEY = Array.from({ length: 32 }, () => 0x07)

const AES_PROBE_IV = Array.from({ length: 12 }, () => 0x03)

/** The 8-byte header of a valid, empty WebAssembly module: magic plus version. */
const WASM_EMPTY_MODULE = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]

/** Bound on the two calls that are known to hang rather than reject. */
export const DEFAULT_PROBE_TIMEOUT_MS = 2000

const STORAGE_PROBE_KEY = '__srn_diagnostics_storage_probe__'

const STORAGE_PROBE_VALUE = 'ok'

const BYTES_PER_GB = 1024 * 1024 * 1024

/**
 * The share of quota at which an origin is reported as nearly full. Kept in step
 * with `HIGH_USAGE_THRESHOLD` in `Utils/StorageQuota.ts`, declared here rather
 * than imported so that this module stays free of side-effecting imports.
 */
export const NEAR_FULL_FRACTION = 0.8

/** Offsets at which a client clock starts to break token and ticket expiry. */
export const CLOCK_SKEW_DEGRADED_SECONDS = 60

export const CLOCK_SKEW_BROKEN_SECONDS = 300

/* -------------------------------------------------------------------------- */
/* Reading a runtime that bites                                               */
/* -------------------------------------------------------------------------- */

/**
 * `value` is declared on both arms so that a caller who does not care WHY a read
 * came back empty can use `.value` without narrowing, while one that does — the
 * difference between "the accessor threw" and "the property is absent" is a real
 * diagnostic distinction — can still branch on `ok`.
 */
type Reading<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly value?: undefined }

function reading<T>(read: () => T): Reading<T> {
  try {
    return { ok: true, value: read() }
  } catch {
    return { ok: false }
  }
}

function booleanOf(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

const TIMED_OUT: unique symbol = Symbol('srn-probe-timed-out')

type Attempted<T> = { readonly kind: 'ok'; readonly value: T } | { readonly kind: 'threw' | 'timed-out' }

/**
 * Run one operation, and never let it decide how long the pane waits.
 *
 * `navigator.storage.estimate()` and `serviceWorker.getRegistrations()` are both
 * documented to hang in private windows rather than reject. A diagnostics pane
 * that hangs while diagnosing a hang is the worst available outcome, so the race
 * is not optional. The timer is always cleared: a dangling one keeps a jest
 * worker alive and turns this file into somebody else's flake.
 */
async function attempt<T>(operation: () => Promise<T> | T, timeoutMs: number): Promise<Attempted<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    const raced = await Promise.race<T | typeof TIMED_OUT>([
      Promise.resolve().then(operation),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs)
      }),
    ])

    return raced === TIMED_OUT ? { kind: 'timed-out' } : { kind: 'ok', value: raced }
  } catch {
    return { kind: 'threw' }
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

function hexOf(value: unknown): string | undefined {
  try {
    const bytes = new Uint8Array(value as ArrayBuffer)
    let hex = ''
    for (const byte of bytes) {
      hex += byte.toString(16).padStart(2, '0')
    }
    return hex
  } catch {
    return undefined
  }
}

function matchesProbeInput(value: unknown): boolean {
  const hex = hexOf(value)
  return hex !== undefined && hex === hexOf(probeInputBytes().buffer)
}

/* -------------------------------------------------------------------------- */
/* The collector                                                              */
/* -------------------------------------------------------------------------- */

function observeSecureContext(runtime: BrowserRuntime): Partial<BrowserObservations> {
  const hostname = stringOf(reading(() => runtime.location?.hostname).value)
  const loopback =
    hostname === undefined
      ? undefined
      : hostname === 'localhost' ||
        hostname.endsWith('.localhost') ||
        hostname === '127.0.0.1' ||
        hostname === '::1' ||
        hostname === '[::1]'

  return {
    secureContext: booleanOf(reading(() => runtime.isSecureContext).value),
    pageScheme: stringOf(reading(() => runtime.location?.protocol).value),
    loopbackOrigin: loopback,
  }
}

async function observeWebCrypto(runtime: BrowserRuntime, timeoutMs: number): Promise<Partial<BrowserObservations>> {
  const read = reading(() => runtime.crypto)
  if (!read.ok) {
    return {}
  }

  const cryptoLike = read.value
  const subtle = reading(() => cryptoLike?.subtle).value
  const subtlePresent = subtle !== undefined && subtle !== null

  const digestFn = subtle?.digest
  let digest: ProbeOutcome = 'unavailable'
  if (typeof digestFn === 'function') {
    const attempted = await attempt(() => digestFn.call(subtle, 'SHA-256', probeInputBytes()), timeoutMs)
    digest =
      attempted.kind === 'ok'
        ? hexOf(attempted.value) === PROBE_DIGEST_SHA256_HEX
          ? 'ok'
          : 'mismatch'
        : attempted.kind
  }

  const importFn = subtle?.importKey
  const encryptFn = subtle?.encrypt
  const decryptFn = subtle?.decrypt
  let aesRoundTrip: ProbeOutcome = 'unavailable'
  if (typeof importFn === 'function' && typeof encryptFn === 'function' && typeof decryptFn === 'function') {
    const attempted = await attempt(async () => {
      const algorithm = { name: 'AES-GCM', iv: new Uint8Array(AES_PROBE_IV) }
      const key = await importFn.call(subtle, 'raw', new Uint8Array(AES_PROBE_KEY), { name: 'AES-GCM' }, false, [
        'encrypt',
        'decrypt',
      ])
      const sealed = await encryptFn.call(subtle, algorithm, key, probeInputBytes())
      return decryptFn.call(subtle, algorithm, key, new Uint8Array(sealed))
    }, timeoutMs)
    aesRoundTrip = attempted.kind === 'ok' ? (matchesProbeInput(attempted.value) ? 'ok' : 'mismatch') : attempted.kind
  }

  const randomFn = cryptoLike?.getRandomValues
  let randomValues: ProbeOutcome = 'unavailable'
  if (typeof randomFn === 'function') {
    try {
      const buffer = new Uint8Array(16)
      randomFn.call(cryptoLike, buffer)
      randomValues = buffer.some((byte) => byte !== 0) ? 'ok' : 'mismatch'
    } catch {
      randomValues = 'threw'
    }
  }

  return { subtlePresent, digest, aesRoundTrip, randomValues }
}

function observeWebStorage(read: () => WebStorageLike | undefined): {
  access: AccessOutcome
  write: ProbeOutcome
} {
  const attempted = reading(read)
  if (!attempted.ok) {
    return { access: 'threw', write: 'unavailable' }
  }

  const store = attempted.value
  if (store === undefined || store === null) {
    return { access: 'absent', write: 'unavailable' }
  }

  const setItem = store.setItem
  const getItem = store.getItem
  const removeItem = store.removeItem
  if (typeof setItem !== 'function' || typeof getItem !== 'function' || typeof removeItem !== 'function') {
    return { access: 'reachable', write: 'unavailable' }
  }

  try {
    setItem.call(store, STORAGE_PROBE_KEY, STORAGE_PROBE_VALUE)
    const echoed = getItem.call(store, STORAGE_PROBE_KEY)
    return { access: 'reachable', write: echoed === STORAGE_PROBE_VALUE ? 'ok' : 'mismatch' }
  } catch {
    return { access: 'reachable', write: 'threw' }
  } finally {
    try {
      removeItem.call(store, STORAGE_PROBE_KEY)
    } catch {
      /* A probe that cannot clean up must still not throw into the pane. */
    }
  }
}

async function observeStorageManager(
  navigatorLike: NavigatorLike | undefined,
  timeoutMs: number,
): Promise<Partial<BrowserObservations>> {
  const manager = reading(() => navigatorLike?.storage).value
  const storageManagerPresent = manager !== undefined && manager !== null

  const estimateFn = manager?.estimate
  let storageEstimate: ProbeOutcome = 'unavailable'
  let storageUsedFraction: number | undefined
  let storageQuotaWholeGb: number | undefined
  if (typeof estimateFn === 'function') {
    const attempted = await attempt(() => estimateFn.call(manager), timeoutMs)
    if (attempted.kind === 'ok') {
      const usage = countOf(attempted.value?.usage)
      const quota = countOf(attempted.value?.quota)
      storageEstimate = 'ok'
      storageQuotaWholeGb = quota === undefined ? undefined : Math.floor(quota / BYTES_PER_GB)
      storageUsedFraction = quota !== undefined && quota > 0 && usage !== undefined ? usage / quota : undefined
    } else {
      storageEstimate = attempted.kind
    }
  }

  const persistedFn = manager?.persisted
  let storagePersisted: boolean | undefined
  if (typeof persistedFn === 'function') {
    const attempted = await attempt(() => persistedFn.call(manager), timeoutMs)
    storagePersisted = attempted.kind === 'ok' ? booleanOf(attempted.value) : undefined
  }

  return { storageManagerPresent, storageEstimate, storageUsedFraction, storageQuotaWholeGb, storagePersisted }
}

async function observeServiceWorker(
  navigatorLike: NavigatorLike | undefined,
  timeoutMs: number,
): Promise<Partial<BrowserObservations>> {
  const read = reading(() => navigatorLike?.serviceWorker)
  if (!read.ok) {
    return {}
  }

  const container = read.value
  if (container === undefined || container === null) {
    return { serviceWorkerPresent: false }
  }

  const controller = reading(() => container.controller)
  const registrationsFn = container.getRegistrations
  let serviceWorkerRegistrations: number | undefined
  if (typeof registrationsFn === 'function') {
    const attempted = await attempt(() => registrationsFn.call(container), timeoutMs)
    serviceWorkerRegistrations =
      attempted.kind === 'ok' && Array.isArray(attempted.value) ? attempted.value.length : undefined
  }

  return {
    serviceWorkerPresent: true,
    serviceWorkerControlling: controller.ok ? controller.value !== undefined && controller.value !== null : undefined,
    serviceWorkerRegistrations,
  }
}

/**
 * The engine, as one of four buckets.
 *
 * Client hints first, because `userAgentData.brands` is the supported way to ask
 * and is the only one a browser is not actively trying to make unreliable. The
 * user-agent fallback exists because Firefox and Safari ship no client hints at
 * all, and an operator on either would otherwise get `unknown` for the row whose
 * entire purpose is to say which browser this is.
 *
 * The iOS wrappers are tested FIRST on purpose: Chrome and Firefox on iOS are
 * WebKit underneath, and reporting `chromium` for a browser that cannot have a
 * Chromium bug is worse than reporting nothing. The string itself is read here
 * and discarded here; it is not part of `BrowserObservations`.
 */
function engineBucket(navigatorLike: NavigatorLike | undefined): EngineBucket | undefined {
  const brands = reading(() => navigatorLike?.userAgentData?.brands).value
  if (Array.isArray(brands) && brands.length > 0) {
    return brands.some((entry) => /chrom/i.test(stringOf(entry?.brand) ?? '')) ? 'chromium' : 'unknown'
  }

  const agent = stringOf(reading(() => navigatorLike?.userAgent).value)
  if (agent === undefined) {
    return undefined
  }
  if (/FxiOS|CriOS|EdgiOS/.test(agent)) {
    return 'webkit'
  }
  if (/Firefox\//.test(agent)) {
    return 'gecko'
  }
  if (/Edg\/|Chrome\/|Chromium\//.test(agent)) {
    return 'chromium'
  }
  if (/AppleWebKit\//.test(agent)) {
    return 'webkit'
  }
  return 'unknown'
}

const PLATFORM_HINTS: Readonly<Record<string, PlatformBucket>> = {
  windows: 'windows',
  macos: 'macos',
  linux: 'linux',
  android: 'android',
  ios: 'ios',
  'chrome os': 'chromeos',
  'chromium os': 'chromeos',
  unknown: 'unknown',
}

function platformBucket(navigatorLike: NavigatorLike | undefined): PlatformBucket | undefined {
  const hint = stringOf(reading(() => navigatorLike?.userAgentData?.platform).value)
  if (hint !== undefined) {
    return PLATFORM_HINTS[hint.toLowerCase()] ?? 'unknown'
  }

  const agent = stringOf(reading(() => navigatorLike?.userAgent).value)
  if (agent === undefined) {
    return undefined
  }
  if (/Android/.test(agent)) {
    return 'android'
  }
  if (/iPhone|iPad|iPod/.test(agent)) {
    return 'ios'
  }
  if (/CrOS/.test(agent)) {
    return 'chromeos'
  }
  if (/Windows/.test(agent)) {
    return 'windows'
  }
  if (/Macintosh|Mac OS X/.test(agent)) {
    return 'macos'
  }
  if (/Linux|X11/.test(agent)) {
    return 'linux'
  }
  return 'unknown'
}

/**
 * Observe this browser once.
 *
 * Reads nothing from the ambient scope and resolves whatever happens: every
 * property access, every call and every comparison is contained, because a
 * diagnostics collector that throws takes down the only screen that could have
 * explained why.
 */
export async function observeBrowserCapabilities(
  runtime: BrowserRuntime,
  options: { timeoutMs?: number } = {},
): Promise<BrowserObservations> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const navigatorLike = reading(() => runtime.navigator).value

  const local = observeWebStorage(() => runtime.localStorage)
  const session = observeWebStorage(() => runtime.sessionStorage)
  const wasm = reading(() => runtime.WebAssembly).value
  const validateFn = wasm?.validate

  let wasmValidate: ProbeOutcome = 'unavailable'
  if (typeof validateFn === 'function') {
    try {
      wasmValidate = validateFn.call(wasm, new Uint8Array(WASM_EMPTY_MODULE)) === true ? 'ok' : 'mismatch'
    } catch {
      wasmValidate = 'threw'
    }
  }

  return {
    ...observeSecureContext(runtime),
    ...(await observeWebCrypto(runtime, timeoutMs)),
    ...(await observeStorageManager(navigatorLike, timeoutMs)),
    ...(await observeServiceWorker(navigatorLike, timeoutMs)),
    webSocketPresent: booleanOf(reading(() => typeof runtime.WebSocket === 'function').value),
    workerPresent: booleanOf(reading(() => typeof runtime.Worker === 'function').value),
    indexedDbPresent: booleanOf(reading(() => runtime.indexedDB !== undefined && runtime.indexedDB !== null).value),
    localStorageAccess: local.access,
    localStorageWrite: local.write,
    sessionStorageAccess: session.access,
    sessionStorageWrite: session.write,
    wasmPresent: booleanOf(reading(() => wasm !== undefined && wasm !== null).value),
    wasmValidate,
    notificationPermission: stringOf(reading(() => runtime.Notification?.permission).value),
    online: booleanOf(reading(() => navigatorLike?.onLine).value),
    visibilityState: stringOf(reading(() => runtime.document?.visibilityState).value),
    cookiesEnabled: booleanOf(reading(() => navigatorLike?.cookieEnabled).value),
    clipboardWritePresent: booleanOf(reading(() => typeof navigatorLike?.clipboard?.writeText === 'function').value),
    logicalCores: countOf(reading(() => navigatorLike?.hardwareConcurrency).value),
    deviceMemoryGb: countOf(reading(() => navigatorLike?.deviceMemory).value),
    engine: engineBucket(navigatorLike),
    platform: platformBucket(navigatorLike),
    mobileFormFactor: booleanOf(reading(() => navigatorLike?.userAgentData?.mobile).value),
    userAgentDataPresent: booleanOf(
      reading(() => {
        const data = navigatorLike?.userAgentData
        return data !== undefined && data !== null
      }).value,
    ),
  }
}

/* -------------------------------------------------------------------------- */
/* Remedies, owned by this module                                             */
/* -------------------------------------------------------------------------- */

/**
 * Almost every remedy in this section is a change the person at the keyboard
 * makes, not a change to the deployment — allow site data, leave the private
 * window, update the browser, turn on network time, free some disk. That is what
 * `device` means, and the chip reading "On this device" is the whole instruction
 * before the operator has read a word of the steps.
 *
 * Three findings are deliberately NOT device-side. `INSECURE_CONTEXT` and the
 * insecure-context arm of `WEB_CRYPTO_UNAVAILABLE` are a serving decision, so they
 * are `restart`; `BROWSER_OFFLINE` is `wait`. None of the ten is `client-update`:
 * nothing here is waiting on a newer build of this app.
 */
const BROWSER_SIDE: RemedyEffort = 'device'

function remedyForInsecureContext(loopback: boolean | undefined): Remedy {
  return {
    code: 'INSECURE_CONTEXT',
    summary:
      'Serve this app over HTTPS, or open it on localhost. Almost everything this section reports as missing is missing for this one reason, and no browser setting overrides it.',
    steps: [
      'Put TLS in front of the container — a reverse proxy with a real certificate is the usual answer — and reach the app over https://.',
      'For a local trial, open the app on http://localhost or http://127.0.0.1 instead of a LAN address: loopback origins are treated as secure contexts over plain HTTP, which is why the same build works there and not here.',
      'A LAN hostname needs a certificate the browser actually trusts. A self-signed certificate that the browser only warns about does NOT restore the secure context, so clicking through the warning will not fix these rows.',
    ],
    effort: 'restart',
    basis: 'verified',
    because: [
      'This page reports window.isSecureContext as false, which is the browser itself refusing the powerful APIs rather than any of them being absent.',
      loopback === true
        ? 'The origin is a loopback host, so a false secure context here is unusual and worth checking against a proxy or extension that is rewriting the page.'
        : 'The origin is not a loopback host, so plain HTTP cannot be a secure context no matter how the browser is configured.',
    ],
  }
}

function remedyForMissingWebCrypto(secureContext: boolean | undefined): Remedy {
  if (secureContext === false) {
    return {
      code: 'WEB_CRYPTO_UNAVAILABLE',
      summary:
        'Web Crypto is withheld because this page is not a secure context. Fix the context and this returns; nothing in the browser itself needs changing.',
      steps: [
        'Serve the app over HTTPS, or open it on localhost. See the insecure-context finding above, which is the same cause.',
      ],
      effort: 'restart',
      basis: 'verified',
      because: [
        'crypto.subtle is absent AND window.isSecureContext is false. Browsers remove crypto.subtle outside a secure context, so the context is the cause and the missing object is the symptom.',
      ],
    }
  }

  return {
    code: 'WEB_CRYPTO_UNAVAILABLE',
    summary:
      'This browser exposes no crypto.subtle in a context that should have it. The app cannot encrypt or decrypt anything without it, so this browser cannot open a vault until it is updated or whatever replaced window.crypto is removed.',
    steps: [
      'Update the browser. Web Crypto has shipped everywhere for years, so an absence in a secure context usually means a browser or WebView old enough that other things will break too.',
      'Try a clean profile with extensions disabled. A content blocker or hardening extension that replaces window.crypto is the other common cause.',
      'On an embedded WebView, check the host application: some expose a cut-down crypto object.',
    ],
    effort: BROWSER_SIDE,
    basis: 'verified',
    because: [
      'crypto.subtle is absent while the page reports a secure context, so the usual cause — an insecure origin — is ruled out.',
    ],
  }
}

function remedyForFailingWebCrypto(): Remedy {
  return {
    code: 'WEB_CRYPTO_OPERATION_FAILED',
    summary:
      'crypto.subtle is present and a real operation against it did not produce the right answer. This is worse than an absent API, because everything that feature-detects it will believe it works.',
    steps: [
      'Try a clean profile with every extension disabled. A shim that stands in for window.crypto is the most common cause of a present-but-wrong implementation.',
      'Update the browser, then re-run this pane: the row says which operation failed and whether it threw, timed out or returned the wrong bytes.',
      'If this is an embedded WebView, report it to whoever ships the host application — a partial Web Crypto is a defect in the host, not in this app.',
    ],
    effort: BROWSER_SIDE,
    basis: 'verified',
    because: [
      'A fixed-input SHA-256 digest, an AES-GCM round trip, or secure random generation was attempted against this browser and did not return the expected result. These are the primitives the app encrypts items with.',
    ],
  }
}

function remedyForUnsupportedTransport(missing: readonly string[]): Remedy {
  return {
    code: 'TRANSPORT_UNSUPPORTED_BROWSER',
    summary: `The realtime sync lane needs Worker, WebSocket and IndexedDB, and this browser is missing ${missing.join(', ')}. The transport refuses to build the lane and syncs over HTTP instead.`,
    steps: [
      'Expect the WebSocket section to report the lane as unavailable with the reason unsupported-browser. That is this row restated, not a second fault, and the fix for both is here.',
      'Leave private browsing, or allow site data for this origin: a private window is the usual reason IndexedDB disappears from an otherwise capable browser.',
      'Update the browser if the Worker or WebSocket constructor is the missing one; both have been universal for a decade and their absence means something is stripping them.',
    ],
    effort: BROWSER_SIDE,
    basis: 'verified',
    because: [
      'The transport builds its lane only when all three of Worker, WebSocket and IndexedDB are present, and at least one of them is not.',
      'Note syncing itself keeps working over HTTP, which is why this is easy to miss: the symptom is latency and missing live updates, not an error.',
    ],
  }
}

function remedyForBlockedLocalStorage(): Remedy {
  return {
    code: 'LOCAL_STORAGE_UNWRITABLE',
    summary:
      'This origin cannot write to localStorage, so preferences and local settings cannot persist. The usual cause is blocked site data, not a missing feature.',
    steps: [
      'Allow site data (cookies and storage) for this origin in the browser settings. A "block all cookies" setting makes the localStorage accessor itself throw, which is what this row observed.',
      'Leave the private window. Firefox private windows and some locked-down profiles present storage that refuses every write.',
      'On a managed device, check the enterprise policy: a site-data block applied by policy cannot be overridden from the settings UI.',
    ],
    effort: BROWSER_SIDE,
    basis: 'verified',
    because: [
      'A write-read-delete round trip under a throwaway key was attempted against this origin and did not complete, so this is an observed refusal rather than a feature detect.',
    ],
  }
}

function remedyForNearlyFullStorage(persisted: boolean | undefined): Remedy {
  return {
    code: 'ORIGIN_STORAGE_NEARLY_FULL',
    summary:
      'This origin is close to the storage quota the browser gives it. Writes start failing mid-load at the ceiling, and on a large vault that looks like corruption rather than a full disk.',
    steps: [
      'Free space on the device. A browser quota is a share of free disk, so the quota itself grows again once the disk does.',
      'Delete large attachments from the vault, or move them to a server with a larger file quota. Attachments dominate origin storage on any vault that has them.',
      persisted === true
        ? 'Persistent storage IS granted for this origin, so the browser will not evict the local database to reclaim space — it will refuse writes instead. That is the safer of the two failures.'
        : 'Persistent storage is NOT granted for this origin, so the browser may evict the local database under pressure rather than refuse a write. On a large vault that is data loss, and it is the reason this row is worth acting on rather than watching.',
    ],
    effort: BROWSER_SIDE,
    basis: 'verified',
    because: [
      'navigator.storage.estimate() was called and reported usage at or above the near-full share of quota this build warns at.',
    ],
  }
}

function remedyForClockSkew(): Remedy {
  return {
    code: 'CLIENT_CLOCK_SKEW',
    summary:
      "This device's clock disagrees with the server's by enough to break token and ticket expiry. Fix the clock on this device and the symptom goes with it.",
    steps: [
      'Turn on automatic date and time (network time) on this device and let it resync.',
      'In a container or VM, check the host clock as well: a suspended host resumes with a clock that is behind by exactly the time it slept.',
      'Re-read this pane afterwards. Sessions and socket tickets issued while the clock was wrong may still be rejected until they are reissued.',
    ],
    effort: BROWSER_SIDE,
    basis: 'verified',
    because: [
      "The offset between this browser's clock and the instant the server captured its diagnostics exceeds the threshold this build warns at.",
      'A skewed client clock expires sessions and socket tickets early and otherwise presents as random, unexplained re-authentication.',
    ],
  }
}

function remedyForBlockedCookies(): Remedy {
  return {
    code: 'COOKIES_DISABLED',
    summary:
      'Cookies are disabled in this browser. Every web sign-in on this fork is cookie-based, so the session cannot be held at all — this is a sign-in failure, not a missing convenience.',
    steps: [
      'Allow cookies for this origin, at minimum as a per-site exception.',
      'Leave the private window, or allow site data within it.',
      'On a managed device, check the enterprise policy before changing anything locally: a policy block reapplies itself.',
    ],
    effort: BROWSER_SIDE,
    basis: 'verified',
    because: [
      "navigator.cookieEnabled reads false, which is the browser's own report that it will not store a cookie for this page.",
    ],
  }
}

function remedyForMissingClipboard(): Remedy {
  return {
    code: 'CLIPBOARD_WRITE_UNAVAILABLE',
    summary:
      'The Copy report button cannot work in this browser, and it fails silently when it cannot. Select the report text instead — the textarea on the Copyable report sub-tab is always rendered.',
    steps: [
      'Use the Copyable report sub-tab and select the text directly. Nothing is lost: the textarea holds exactly what the button would have copied.',
      'If the page is not a secure context, fix that first — the Clipboard API is one of the things withheld outside one, so this row may clear on its own.',
    ],
    effort: BROWSER_SIDE,
    basis: 'verified',
    because: [
      'navigator.clipboard.writeText is absent, and the pane swallows a failed copy rather than reporting it, so without this row the button would appear to do nothing for no reason.',
    ],
  }
}

function remedyForOffline(): Remedy {
  return {
    code: 'BROWSER_OFFLINE',
    summary:
      'The browser reports no network connection. Nothing else in this pane can be trusted until that clears, because every server-sourced row was read over the connection that is missing.',
    steps: [],
    effort: 'wait',
    basis: 'verified',
    because: [
      'navigator.onLine reads false. The flag is only a hint when it reads true, but a false reading means the browser has no network interface it is willing to use.',
    ],
  }
}

/* -------------------------------------------------------------------------- */
/* Row builders                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A feature detect, reported as one.
 *
 * `evidenceProxy` does the work: the positive arm claims the capability functions
 * and gets capped to `undetermined` with the caveat printed, the negative arm
 * claims `broken` and SURVIVES because a missing constructor is a necessary
 * condition failing. That asymmetry is the whole reason the row is written this
 * way instead of as a boolean with a tone.
 */
function presenceRow(input: {
  label: SafeValue
  present: boolean | undefined
  observed: string
  cannotConfirm: string
  note: string
  absentVerdict?: Verdict
}): DiagnosticRow {
  const evidence: Evidence = evidenceProxy({
    observed: input.observed,
    cannotConfirm: input.cannotConfirm,
    necessaryCondition: true,
  })

  return diagnosticRow({
    label: input.label,
    value: safePresence(input.present),
    verdict:
      input.present === true ? 'healthy' : input.present === false ? (input.absentVerdict ?? 'broken') : 'undetermined',
    evidence: input.present === undefined ? EVIDENCE_ABSENT : evidence,
    note: input.note,
  })
}

/**
 * An attempted operation, reported as one.
 *
 * `EVIDENCE_DIRECT` is used here and only here, because the row describes the
 * operation that was actually performed. `unavailable` means the API the probe
 * needed was absent, so nothing was attempted and the row is `undetermined` on
 * absent evidence — never a failure, which is rule 3 of the contract.
 */
function probeRow(input: {
  label: SafeValue
  outcome: ProbeOutcome | undefined
  failureVerdict: Verdict
  successVerdict?: Verdict
  note: string
}): DiagnosticRow {
  const attempted = input.outcome !== undefined && input.outcome !== 'unavailable'

  return diagnosticRow({
    label: input.label,
    value: safeEnum(input.outcome, PROBE_OUTCOMES),
    verdict: !attempted
      ? 'undetermined'
      : input.outcome === 'ok'
        ? (input.successVerdict ?? 'healthy')
        : input.failureVerdict,
    evidence: attempted ? EVIDENCE_DIRECT : EVIDENCE_ABSENT,
    note: input.note,
  })
}

/**
 * Absent is not false, held structurally rather than remembered.
 *
 * Every row in this file routes its evidence through here or through one of the
 * two builders above, so a row CANNOT claim direct evidence for an observation
 * that was never made. The failure this prevents is small and extremely easy to
 * ship: a row reading "not reported" with a confident `informational` tone and
 * `EVIDENCE_DIRECT` behind it, which is the panel asserting it looked when it did
 * not. `browserSection.spec.ts` asserts the invariant over every row at once by
 * building the section with no observations at all.
 */
function absentOr(observed: unknown, verdict: Verdict): { verdict: Verdict; evidence: Evidence } {
  return observed === undefined
    ? { verdict: 'undetermined', evidence: EVIDENCE_ABSENT }
    : { verdict, evidence: EVIDENCE_DIRECT }
}

/**
 * A row whose source is a single directly observed value: the row describes what
 * was read, so the evidence is direct when there was something to read and absent
 * when there was not.
 */
function observedRow(input: {
  label: SafeValue
  observed: unknown
  value: SafeValue
  verdict: Verdict
  note: string
}): DiagnosticRow {
  return diagnosticRow({
    label: input.label,
    value: input.value,
    ...absentOr(input.observed, input.verdict),
    note: input.note,
  })
}

/* -------------------------------------------------------------------------- */
/* The section                                                                */
/* -------------------------------------------------------------------------- */

export type BrowserSectionInput = {
  /** Absent until the first collection run resolves; every row then reads "not reported". */
  observations?: BrowserObservations
  clock?: BrowserClockReading
  outcomes?: readonly SectionTaggedOutcome[]
}

const PROBE_FAILURES: readonly ProbeOutcome[] = ['mismatch', 'threw', 'timed-out']

function failed(outcome: ProbeOutcome | undefined): boolean {
  return outcome !== undefined && PROBE_FAILURES.includes(outcome)
}

function buildRequirementsBlock(observed: BrowserObservations): DiagnosticBlock {
  const rows: DiagnosticRow[] = [
    diagnosticRow({
      label: safeConstant('Secure context'),
      value: safeState(observed.secureContext, 'secure', 'not secure'),
      verdict:
        observed.secureContext === true ? 'healthy' : observed.secureContext === false ? 'broken' : 'undetermined',
      evidence: observed.secureContext === undefined ? EVIDENCE_ABSENT : EVIDENCE_DIRECT,
      note: 'The single highest-value row here. Outside a secure context the browser withholds Web Crypto, service workers, passkeys, the Clipboard API and persistent storage all at once, so one cause produces a screen full of unrelated-looking failures. Plain HTTP on a LAN address is the common way to land here; loopback addresses count as secure even over HTTP.',
    }),
    observedRow({
      label: safeConstant('Page scheme'),
      observed: observed.pageScheme,
      value: safeEnum(observed.pageScheme, PAGE_SCHEMES),
      verdict: 'informational',
      note: 'How this page was loaded. Context, not a verdict: http: is perfectly fine on a loopback address and fatal on anything else, which is why the secure-context row above is the one to read first.',
    }),
    observedRow({
      label: safeConstant('Loopback origin'),
      observed: observed.loopbackOrigin,
      value: safeYesNo(observed.loopbackOrigin),
      verdict: 'informational',
      note: 'Whether this page was loaded from localhost, 127.0.0.1 or [::1]. Those origins are treated as secure contexts over plain HTTP, so http there needs no fixing. The host name itself is never read into this panel or the report.',
    }),
    presenceRow({
      label: safeConstant('Web Crypto present'),
      present: observed.subtlePresent,
      observed: 'whether crypto.subtle exists as an object on this page',
      cannotConfirm: 'a cryptographic operation actually succeeding here',
      note: 'Presence only. This row is capped on purpose: the rows below it ran real operations, and they are the ones that establish Web Crypto works. A shimmed or cut-down implementation passes this row and fails those.',
    }),
    probeRow({
      label: safeConstant('SHA-256 digest of a fixed input'),
      outcome: observed.digest,
      failureVerdict: 'broken',
      note: 'A real SHA-256 was computed over 16 constant bytes and compared against a constant digest. "mismatch" means the call resolved with the wrong answer, which is a replaced or broken implementation rather than a missing one — the dangerous case, because everything that feature-detects Web Crypto will believe it works.',
    }),
    probeRow({
      label: safeConstant('AES-GCM import, encrypt and decrypt'),
      outcome: observed.aesRoundTrip,
      failureVerdict: 'broken',
      note: 'The exact primitive the app encrypts items with: a raw 256-bit key imported as AES-GCM, used to seal 16 bytes and open them again. A failure here means this browser cannot read or write your notes at all, whatever the server reports.',
    }),
    probeRow({
      label: safeConstant('Secure random generation'),
      outcome: observed.randomValues,
      failureVerdict: 'broken',
      note: 'crypto.getRandomValues was called over a 16-byte buffer and the result checked for any non-zero byte. Key generation, nonces and item identifiers all rest on it.',
    }),
    presenceRow({
      label: safeConstant('WebSocket constructor'),
      present: observed.webSocketPresent,
      observed: 'whether the WebSocket constructor exists on this page',
      cannotConfirm: "this client's socket actually connecting",
      note: 'The browser-capability half only. Whether the socket is connected, and why it is not, belongs to the WebSocket section and is not restated here — one defect reported twice in different words is how an operator stops believing a panel.',
    }),
    presenceRow({
      label: safeConstant('Worker constructor'),
      present: observed.workerPresent,
      observed: 'whether the Worker constructor exists on this page',
      cannotConfirm: 'a worker actually starting',
      note: 'The sync transport runs in a worker and the decryption pool is sized from this too. Without it the realtime lane is never built and decryption falls back to the main thread, which a large vault feels immediately.',
    }),
    presenceRow({
      label: safeConstant('IndexedDB present'),
      present: observed.indexedDbPresent,
      observed: 'whether the indexedDB accessor exists on this page',
      cannotConfirm: 'a database actually opening',
      note: 'Presence is explicitly NOT the test here: Firefox private windows and locked-down profiles expose indexedDB and then reject open(), which the transport reports as outbox-unavailable and which closes the lane. A real open-and-close of a throwaway database is operator-triggered and lives on the Checks sub-tab, because a render path must not create databases.',
    }),
  ]

  const findings: DiagnosticFinding[] = []

  if (observed.secureContext === false) {
    findings.push(
      diagnosticFinding({
        code: safeConstant('INSECURE_CONTEXT'),
        title: 'This page is not a secure context',
        detail:
          'The browser is withholding its powerful APIs from this origin. Expect Web Crypto, service workers, passkeys, the clipboard and persistent storage to be missing together, and fix this before chasing any of them individually.',
        verdict: 'broken',
        evidence: EVIDENCE_DIRECT,
        remedy: remedyForInsecureContext(observed.loopbackOrigin),
      }),
    )
  }

  if (observed.subtlePresent === false) {
    findings.push(
      diagnosticFinding({
        code: safeConstant('WEB_CRYPTO_UNAVAILABLE'),
        title: 'Web Crypto is not available in this browser',
        detail:
          'The app encrypts and decrypts every item with Web Crypto. Without it this browser cannot open an existing vault or write to one, so this is a hard stop rather than a degraded feature.',
        verdict: 'broken',
        evidence: EVIDENCE_DIRECT,
        remedy: remedyForMissingWebCrypto(observed.secureContext),
      }),
    )
  }

  if (
    observed.subtlePresent === true &&
    (failed(observed.digest) || failed(observed.aesRoundTrip) || failed(observed.randomValues))
  ) {
    findings.push(
      diagnosticFinding({
        code: safeConstant('WEB_CRYPTO_OPERATION_FAILED'),
        title: 'Web Crypto is present but a real operation failed',
        detail:
          'The API exists and an attempted operation against it did not return the expected result. This is the state every feature detect in every library will read as working, which is what makes it worth a finding of its own.',
        verdict: 'broken',
        evidence: EVIDENCE_DIRECT,
        remedy: remedyForFailingWebCrypto(),
      }),
    )
  }

  const missingTransportPieces = [
    observed.workerPresent === false ? 'Worker' : undefined,
    observed.webSocketPresent === false ? 'WebSocket' : undefined,
    observed.indexedDbPresent === false ? 'IndexedDB' : undefined,
  ].filter((name): name is string => name !== undefined)

  if (missingTransportPieces.length > 0) {
    findings.push(
      diagnosticFinding({
        code: safeConstant('TRANSPORT_UNSUPPORTED_BROWSER'),
        title: 'This browser cannot carry the realtime sync lane',
        detail:
          'The transport requires Worker, WebSocket and IndexedDB together and at least one is missing, so the lane is never built. Note syncing continues over HTTP, which is why this presents as missing live updates rather than as an error.',
        verdict: 'broken',
        evidence: evidenceProxy({
          observed: 'that at least one of the Worker, WebSocket and IndexedDB constructors is absent',
          cannotConfirm: "the socket lane being built by this client's transport",
          necessaryCondition: true,
        }),
        remedy: remedyForUnsupportedTransport(missingTransportPieces),
      }),
    )
  }

  return {
    heading: safeConstant('Hard requirements'),
    description:
      'What this browser must provide for the app to work at all. Rows that ran a real operation carry a verdict; rows that could only be feature-detected say so and are reported as undetermined rather than claiming more than was tested.',
    rows,
    findings,
  }
}

function buildStorageBlock(observed: BrowserObservations): DiagnosticBlock {
  const usage = observed.storageUsedFraction
  const nearlyFull = usage !== undefined && usage >= NEAR_FULL_FRACTION

  const rows: DiagnosticRow[] = [
    observedRow({
      label: safeConstant('localStorage accessor'),
      observed: observed.localStorageAccess,
      value: safeEnum(observed.localStorageAccess, ACCESS_OUTCOMES),
      verdict: observed.localStorageAccess === 'threw' ? 'broken' : 'informational',
      note: 'Whether reading the property itself worked. "threw" is a real state and the reason every access in this module is wrapped: under "block all site data", and in a Firefox private window, the accessor raises rather than returning an empty store.',
    }),
    probeRow({
      label: safeConstant('localStorage write round trip'),
      outcome: observed.localStorageWrite,
      failureVerdict: 'broken',
      note: 'A throwaway key was written, read back, compared and deleted. Preferences and local settings live here, so a failure means settings silently stop persisting between loads.',
    }),
    observedRow({
      label: safeConstant('sessionStorage accessor'),
      observed: observed.sessionStorageAccess,
      value: safeEnum(observed.sessionStorageAccess, ACCESS_OUTCOMES),
      verdict: observed.sessionStorageAccess === 'threw' ? 'degraded' : 'informational',
      note: 'The same probe against per-tab storage. Less load-bearing than localStorage, and useful mainly as a second data point: both throwing points at a site-data block rather than at one quirky store.',
    }),
    probeRow({
      label: safeConstant('sessionStorage write round trip'),
      outcome: observed.sessionStorageWrite,
      failureVerdict: 'degraded',
      note: 'A throwaway key written and removed again. A failure costs per-tab state only, which is why it is degraded rather than broken.',
    }),
    observedRow({
      label: safeConstant('Storage manager present'),
      observed: observed.storageManagerPresent,
      value: safePresence(observed.storageManagerPresent),
      verdict: 'informational',
      note: 'navigator.storage, which is where the quota figures and the eviction grant below come from. Without it those rows cannot be filled and the app cannot ask to be protected from eviction.',
    }),
    probeRow({
      label: safeConstant('Storage estimate call'),
      outcome: observed.storageEstimate,
      failureVerdict: 'degraded',
      successVerdict: 'informational',
      note: 'navigator.storage.estimate() was actually called. It is here so that a blank quota row below reads as "the call did not answer" rather than as "this origin has no quota" — and so a call that hangs, which happens in private windows, is reported as a timeout instead of waiting.',
    }),
  ]

  rows.push(
    diagnosticRow({
      label: safeConstant('Origin storage used'),
      value: safePercentBucket(usage),
      ...absentOr(usage, nearlyFull ? 'degraded' : 'healthy'),
      note: 'The share of this origin\'s quota in use, as a bucket. A bucket rather than a byte count on purpose: this is the first genuinely user-specific figure in the pane and the report is written to be pasted in public, so the question "is this origin about to be evicted?" is answered without disclosing the size of anyone\'s vault.',
    }),
    diagnosticRow({
      label: safeConstant('Origin quota, whole GB'),
      value: safeCount(observed.storageQuotaWholeGb),
      ...absentOr(observed.storageQuotaWholeGb, 'informational'),
      note: 'What the browser currently offers this origin, rounded down, so 0 means under one gigabyte. It is a share of free disk rather than a fixed allowance, which is why it moves when the device fills up.',
    }),
    diagnosticRow({
      label: safeConstant('Persistent storage'),
      value: safeState(observed.storagePersisted, 'granted', 'not granted'),
      ...absentOr(observed.storagePersisted, observed.storagePersisted === true ? 'healthy' : 'informational'),
      note: 'Whether this origin is exempt from eviction under storage pressure. Not granted is normal and not a fault on its own — browsers grant it on engagement — but combined with a nearly-full origin it is the difference between a refused write and a silently emptied local database.',
    }),
  )

  const findings: DiagnosticFinding[] = []

  if (observed.localStorageAccess === 'threw' || failed(observed.localStorageWrite)) {
    findings.push(
      diagnosticFinding({
        code: safeConstant('LOCAL_STORAGE_UNWRITABLE'),
        title: 'This origin cannot write to localStorage',
        detail:
          'An attempted write did not survive a read back. Preferences and local settings cannot persist, so the app will appear to forget every choice between loads.',
        verdict: 'broken',
        evidence: EVIDENCE_DIRECT,
        remedy: remedyForBlockedLocalStorage(),
      }),
    )
  }

  if (nearlyFull) {
    findings.push(
      diagnosticFinding({
        code: safeConstant('ORIGIN_STORAGE_NEARLY_FULL'),
        title: 'This origin is close to its storage quota',
        detail:
          observed.storagePersisted === true
            ? 'Writes will start failing at the ceiling. Persistent storage is granted, so the browser will refuse writes rather than evict the local database — the safer of the two failures, and still worth clearing before a large sync.'
            : 'Writes will start failing at the ceiling, and because persistent storage is not granted the browser may instead evict this origin entirely. On a large vault that is data loss, not a slowdown.',
        verdict: 'degraded',
        evidence: EVIDENCE_DIRECT,
        remedy: remedyForNearlyFullStorage(observed.storagePersisted),
      }),
    )
  }

  return {
    heading: safeConstant('Storage'),
    description:
      'Whether this browser will actually hold data for this origin. Every row here attempted a real operation rather than detecting a feature, because the stores that fail do so on use, not on inspection. Opening the local database itself is deliberately not done from a render path: that check is operator-triggered on the Checks sub-tab.',
    rows,
    findings,
  }
}

function buildSupportingBlock(observed: BrowserObservations): DiagnosticBlock {
  const rows: DiagnosticRow[] = [
    observedRow({
      label: safeConstant('WebAssembly present'),
      observed: observed.wasmPresent,
      value: safePresence(observed.wasmPresent),
      verdict: 'informational',
      note: 'Context only, and claimed as nothing more: the row below it actually validated a module. Key derivation prefers a WebAssembly build and falls back to a slower pure-JavaScript one, so an absence here costs time rather than correctness.',
    }),
    probeRow({
      label: safeConstant('WebAssembly module validation'),
      outcome: observed.wasmValidate,
      failureVerdict: 'degraded',
      note: 'A minimal, valid module was handed to WebAssembly.validate. A failure means key derivation takes the pure-JavaScript path: sign-in and vault unlock get noticeably slower, and nothing breaks.',
    }),
    observedRow({
      label: safeConstant('Service worker API'),
      observed: observed.serviceWorkerPresent,
      value: safePresence(observed.serviceWorkerPresent),
      verdict: 'informational',
      note: 'Offline app shell only. Deliberately NOT a requirement for sync, and stated that way so that an operator with a broken socket does not spend an evening on this row. Registration additionally requires a secure context.',
    }),
    observedRow({
      label: safeConstant('Service worker controlling this page'),
      observed: observed.serviceWorkerControlling,
      value: safeState(observed.serviceWorkerControlling, 'controlling', 'not controlling'),
      verdict: 'informational',
      note: 'Whether this page load is being served through a worker. "not controlling" on a first load is normal. It matters when a stale worker is serving an old bundle, which presents as a client that keeps behaving like a version you no longer have deployed.',
    }),
    diagnosticRow({
      label: safeConstant('Service worker registrations'),
      value: safeCount(observed.serviceWorkerRegistrations),
      ...absentOr(observed.serviceWorkerRegistrations, 'informational'),
      note: 'How many registrations this origin holds. More than one is the signature of an older deployment path left behind at a different scope, which is worth knowing when a stale bundle is the complaint.',
    }),
    observedRow({
      label: safeConstant('Notification permission'),
      observed: observed.notificationPermission,
      value: safeEnum(observed.notificationPermission, NOTIFICATION_PERMISSIONS),
      verdict: 'informational',
      note: 'The permission state only. Nothing in sync depends on it; it explains why a notification-based feature is silent, and "denied" cannot be undone from the page — only from the browser\'s own site settings.',
    }),
    diagnosticRow({
      label: safeConstant('Network flag'),
      value: safeState(observed.online, 'online', 'offline'),
      verdict: observed.online === true ? 'healthy' : observed.online === false ? 'broken' : 'undetermined',
      evidence:
        observed.online === undefined
          ? EVIDENCE_ABSENT
          : evidenceProxy({
              observed: "the browser's own navigator.onLine flag",
              cannotConfirm: 'this deployment actually being reachable',
              necessaryCondition: true,
            }),
      note: 'Asymmetric on purpose, and the clearest small example of why this pane derives verdicts from evidence. A true reading proves nothing — a captive portal and a dead server both read online — so it is reported as undetermined. A false reading means the browser has no usable interface at all, which is conclusive.',
    }),
    observedRow({
      label: safeConstant('Page visibility'),
      observed: observed.visibilityState,
      value: safeEnum(observed.visibilityState, VISIBILITY_STATES),
      verdict: 'informational',
      note: 'Whether this tab was in the foreground when the panel read it. A hidden tab has its timers throttled, which is the ordinary explanation for sync that looks stalled in a background tab and recovers the moment it is focused.',
    }),
    diagnosticRow({
      label: safeConstant('Cookies enabled'),
      value: safeState(observed.cookiesEnabled, 'enabled', 'disabled'),
      verdict:
        observed.cookiesEnabled === true ? 'healthy' : observed.cookiesEnabled === false ? 'broken' : 'undetermined',
      evidence:
        observed.cookiesEnabled === undefined
          ? EVIDENCE_ABSENT
          : evidenceProxy({
              observed: "the browser's own navigator.cookieEnabled flag",
              cannotConfirm: "this origin's session cookie being stored and sent back",
              necessaryCondition: true,
            }),
      note: 'Every web sign-in on this fork is cookie-based, so a false reading is a sign-in failure rather than a missing feature. The honest limitation, stated rather than hidden: the flag does not reflect per-site or third-party blocking, and a page cannot test that about itself — so a true reading is reported as undetermined.',
    }),
    presenceRow({
      label: safeConstant('Clipboard write'),
      present: observed.clipboardWritePresent,
      observed: 'whether navigator.clipboard.writeText exists on this page',
      cannotConfirm: 'a clipboard write actually succeeding, which also needs a user gesture and permission',
      absentVerdict: 'broken',
      note: "This pane's own Copy report button depends on it, and that button swallows its failure — it silently reports nothing copied. A diagnostics panel that cannot report its own broken button is the exact failure class this pane exists to end, which is why a convenience gets a verdict here.",
    }),
    diagnosticRow({
      label: safeConstant('Logical CPU cores'),
      value: safeCount(observed.logicalCores),
      ...absentOr(observed.logicalCores, 'informational'),
      note: 'Sizes the decryption worker pool. Context for "why is this machine slow to open a large vault", never a fault.',
    }),
    diagnosticRow({
      label: safeConstant('Device memory, GB'),
      value: safeEnum(
        observed.deviceMemoryGb === undefined ? undefined : String(observed.deviceMemoryGb),
        DEVICE_MEMORY_VALUES,
      ),
      ...absentOr(observed.deviceMemoryGb, 'informational'),
      note: 'The browser reports this only as one of six coarse values, and only some browsers report it at all. Admitted against exactly those six so an unexpected figure is refused rather than printed.',
    }),
  ]

  const findings: DiagnosticFinding[] = []

  if (observed.cookiesEnabled === false) {
    findings.push(
      diagnosticFinding({
        code: safeConstant('COOKIES_DISABLED'),
        title: 'Cookies are disabled in this browser',
        detail:
          'Sign-in on this fork is cookie-based, so a session cannot be held at all. Expect sign-in to appear to succeed and then immediately drop back, with nothing wrong on the server.',
        verdict: 'broken',
        evidence: EVIDENCE_DIRECT,
        remedy: remedyForBlockedCookies(),
      }),
    )
  }

  if (observed.clipboardWritePresent === false) {
    findings.push(
      diagnosticFinding({
        code: safeConstant('CLIPBOARD_WRITE_UNAVAILABLE'),
        title: 'The Copy report button cannot work here',
        detail:
          'navigator.clipboard.writeText is absent, and the copy handler reports nothing when it fails. The report text itself is unaffected and can be selected directly.',
        verdict: 'broken',
        evidence: EVIDENCE_DIRECT,
        remedy: remedyForMissingClipboard(),
      }),
    )
  }

  if (observed.online === false) {
    findings.push(
      diagnosticFinding({
        code: safeConstant('BROWSER_OFFLINE'),
        title: 'The browser reports no network connection',
        detail:
          'Read the rest of this pane with that in mind: every server-sourced section was filled over the connection this row says is missing, so their verdicts describe a failed read rather than a broken server.',
        verdict: 'broken',
        evidence: EVIDENCE_DIRECT,
        remedy: remedyForOffline(),
      }),
    )
  }

  return {
    heading: safeConstant('Supporting capabilities'),
    description:
      'Capabilities that shape how well the app works rather than whether it works. Each row says what breaks without it, including the ones that break nothing — a row that cannot name a consequence is a row an operator will waste an evening on.',
    rows,
    findings,
  }
}

function buildIdentityBlock(observed: BrowserObservations): DiagnosticBlock {
  return {
    heading: safeConstant('Browser identity'),
    description:
      'Enough to tell which engine this is. The user-agent string is read to derive these buckets and then discarded: it is fingerprinting material, the copyable report is written to be pasted in public, and the bucket answers every question the report needs to answer.',
    rows: [
      diagnosticRow({
        label: safeConstant('Engine'),
        value: safeEnum(observed.engine, ENGINE_BUCKETS),
        ...absentOr(observed.engine, 'informational'),
        note: 'Derived from client hints where the browser offers them and from the user-agent string otherwise, with the iOS wrappers resolved to webkit — Chrome and Firefox on iOS are WebKit underneath, and calling either chromium would send a reader after a bug it cannot have.',
      }),
      diagnosticRow({
        label: safeConstant('Platform'),
        value: safeEnum(observed.platform, PLATFORM_BUCKETS),
        ...absentOr(observed.platform, 'informational'),
        note: 'A closed bucket, not the platform string. It is here because several of the rows above behave differently per platform — notably iOS, where storage eviction is far more aggressive than anywhere else.',
      }),
      diagnosticRow({
        label: safeConstant('Mobile form factor'),
        value: safeYesNo(observed.mobileFormFactor),
        ...absentOr(observed.mobileFormFactor, 'informational'),
        note: "The browser's own answer, reported only where client hints exist. Not inferred from a screen size, which would be a guess dressed up as an observation.",
      }),
      diagnosticRow({
        label: safeConstant('Client hints available'),
        value: safePresence(observed.userAgentDataPresent),
        ...absentOr(observed.userAgentDataPresent, 'informational'),
        note: 'Whether navigator.userAgentData answered. When it does not, the two buckets above come from the user-agent string instead, which is weaker — worth knowing before trusting them.',
      }),
    ],
    findings: [],
  }
}

function buildClockBlock(clock: BrowserClockReading | undefined): DiagnosticBlock {
  const offsetMs = clock === undefined ? undefined : clock.localReceivedAtMs - clock.serverCapturedAtMs
  const offsetSeconds = offsetMs === undefined ? undefined : Math.abs(offsetMs) / 1000
  const direction: ClockDirection | undefined =
    offsetMs === undefined
      ? undefined
      : Math.abs(offsetMs) < 1000
        ? 'aligned'
        : offsetMs > 0
          ? 'ahead of the server'
          : 'behind the server'

  const verdict: Verdict =
    offsetSeconds === undefined
      ? 'undetermined'
      : offsetSeconds >= CLOCK_SKEW_BROKEN_SECONDS
        ? 'broken'
        : offsetSeconds >= CLOCK_SKEW_DEGRADED_SECONDS
          ? 'degraded'
          : 'healthy'

  const rows: DiagnosticRow[] = [
    diagnosticRow({
      label: safeConstant('Offset from the server clock'),
      value:
        offsetSeconds === undefined
          ? safeDuration(undefined)
          : safeTokens(safeDuration(offsetSeconds), safeEnum(direction, CLOCK_DIRECTIONS)),
      ...absentOr(offsetSeconds, verdict),
      note: 'Measured against the instant the server stamped its own diagnostics, compared with the local clock at the moment that payload arrived rather than at render time — so this is an offset between two clocks, not the age of a cached payload. It includes one response\'s travel time, which is immaterial at this threshold. A skewed clock expires sessions and socket tickets early and otherwise presents as unexplained re-authentication. No request is made to fill this row: when the payload has not been read, it reads "not reported".',
    }),
  ]

  const findings: DiagnosticFinding[] =
    offsetSeconds !== undefined && offsetSeconds >= CLOCK_SKEW_DEGRADED_SECONDS
      ? [
          diagnosticFinding({
            code: safeConstant('CLIENT_CLOCK_SKEW'),
            title: "This device's clock disagrees with the server's",
            detail:
              'Tokens and socket tickets are validated against expiry instants, so a clock this far out rejects credentials that are actually valid — or accepts ones that are not. It is invisible from every other screen in this pane.',
            verdict: offsetSeconds >= CLOCK_SKEW_BROKEN_SECONDS ? 'broken' : 'degraded',
            evidence: EVIDENCE_DIRECT,
            remedy: remedyForClockSkew(),
          }),
        ]
      : []

  return {
    heading: safeConstant('Clock'),
    description:
      'A client clock is the one browser fact that breaks authentication while every other row reads healthy. This block is filled from a timestamp the pane already has; nothing extra is requested to populate it.',
    rows,
    findings,
  }
}

const REPORT_UA_WITHHELD = reportLine(
  safeConstant('User agent string'),
  safeConstant('withheld from this report on purpose'),
)

const REPORT_DB_OPEN = reportLine(
  safeConstant('Local database open test'),
  safeConstant('operator-triggered on the Checks sub-tab'),
)

/**
 * Build the Browser section.
 *
 * Pure and synchronous: the collection run happens before this is called, and
 * `observations` being absent is a legitimate state — the first render, before
 * the probes resolve. Every row then reads "not reported" on absent evidence,
 * which is the contract's third rule holding by construction rather than by
 * remembering to write it.
 */
export function buildBrowserSection(input: BrowserSectionInput = {}): SectionModel {
  const observed = input.observations ?? {}
  const outcomes = outcomesForSection(input.outcomes ?? [], 'browser')

  const blocks: DiagnosticBlock[] = [
    buildRequirementsBlock(observed),
    buildStorageBlock(observed),
    buildSupportingBlock(observed),
    buildIdentityBlock(observed),
    buildClockBlock(input.clock),
  ]

  if (outcomes.length > 0) {
    blocks.push({
      heading: safeConstant('Operator-triggered checks'),
      description:
        'Results from the last run on the Checks sub-tab. Read-only here: the one place a run can be started is that tab, so the paragraph explaining what a run does to your own account appears exactly once.',
      rows: [],
      findings: [],
      outcomes,
    })
  }

  return buildSectionModel({
    id: 'browser',
    blocks,
    extraReportLines: [REPORT_UA_WITHHELD, REPORT_DB_OPEN],
  })
}
