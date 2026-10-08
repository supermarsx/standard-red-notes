/**
 * Standard Red Notes: the ADMISSION half of the admin Diagnostics payload —
 * whether clients arrive at the socket, and whether they are being turned away.
 *
 * The panel's "Gateway admission and traffic" block rendered one sentence
 * saying nothing populated it, because every one of its eight counters lives
 * inside the attached WebSocket gateway: a refusal happens at the upgrade, the
 * client is closed with a 1008 no screen reads, and the browser that was
 * refused is by definition not the browser reading this pane. This module is
 * the boundary that carries those eight to the client, and nothing else with
 * them.
 *
 * *** WHY THE BLOCK IS ALL OR NOTHING ***
 *
 * `admissionReported()` on the client renders all ten rows as soon as ONE
 * member is defined. A partial fill is therefore worse than none: nine rows
 * would read "not reported" as though they had been measured and found empty.
 * So either the gateway is attached and every member is reported, or the whole
 * block is omitted and the panel keeps its one honest sentence. There is no
 * arm in here that emits some of it.
 *
 * *** THE SECURITY BOUNDARY ***
 *
 * The subject is an ALLOWLIST and a stream of refused clients, which is the
 * most disclosure-shaped material in the whole payload. Two rules, held
 * structurally rather than by care:
 *
 *   1. NEVER AN IDENTIFIED CLIENT. A refusal is a count against a closed
 *      cause. No origin, address, port, ticket, session, device or user
 *      identifier appears in any type this module exports, and there is no
 *      `string` field for one to travel in. The question "would my browser be
 *      let on" is answered by ONE BOOLEAN about an origin the asking client
 *      already possesses; the list's contents never leave the gateway, only
 *      how many rules it holds.
 *   2. READ BY ALLOWLIST, field by field. The gateway is in-process today, so
 *      this is not a wire boundary — but the gateway is a separately versioned
 *      package behind an interface, and a field it grows later must not reach
 *      a client by riding along in a spread. Every field here is reconstructed
 *      from an admitted value: a count must be a whole number within a bound
 *      this build declares (one outside it is DROPPED, not clamped into a
 *      reading no process measured), a boolean must be a boolean, and no other
 *      key is copied at all.
 */

/* -------------------------------------------------------------------------- */
/* Bounds this build declares                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The ceiling on the origin-RULE count. Mirrors the gateway's own
 * `MAX_REPORTED_ORIGIN_RULES`: an allowlist larger than this is not a
 * deployment, and the bound is what makes the field a bounded count.
 */
export const MAX_REPORTED_ORIGIN_RULES = 1_024

/** The ceiling on the live-socket gauge, mirroring the gateway's. */
export const MAX_REPORTED_LIVE_SOCKETS = 1_000_000

/** The ceiling on every since-attach event counter, mirroring the gateway's. */
export const MAX_REPORTED_ADMISSION_EVENTS = 1_000_000_000

/**
 * The ceiling on the advertisable-operation count: the number of operations the
 * sync protocol defines, mirroring the gateway's own
 * `MAX_REPORTED_ADVERTISABLE_OPERATIONS`. No handshake can advertise an
 * operation that does not exist, so a figure above this is malformed by the
 * contract rather than merely large, and is DROPPED.
 *
 * Mirrored rather than imported, like every bound above it, so this module
 * stays a pure reader with no reach into the gateway package — and pinned to
 * the gateway's own constant by a spec, because a mirror nobody compares is a
 * bound that drifts.
 */
export const MAX_REPORTED_ADVERTISABLE_OPERATIONS = 6

/* -------------------------------------------------------------------------- */
/* Closed vocabulary                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The three closed causes an upgrade is refused for, in the camelCase spelling
 * the panel already declares (`SOCKET_REJECTION_CAUSES`), member for member, so
 * a count served from here cannot arrive under a name the client has no row
 * for. A cause outside this tuple is not read: a count with no row is a count
 * nobody sees, and inventing a row for it client-side is not possible from
 * here.
 */
export const SOCKET_REJECTION_COUNTER_KEYS = ['originNotAllowed', 'queryStringNotPermitted', 'unavailable'] as const

export type SocketRejectionCounterKey = (typeof SOCKET_REJECTION_COUNTER_KEYS)[number]

/* -------------------------------------------------------------------------- */
/* The view this module serves                                                */
/* -------------------------------------------------------------------------- */

/**
 * The admission block as it is published, with the member names the panel's
 * `SocketGatewayCountersView` declares.
 *
 * Each member says, in its own doc, whether it is MONOTONIC SINCE ATTACH or
 * WINDOWED, because a counter whose lifetime is unstated is a counter an
 * operator cannot read: "3 refusals" means nothing until you know whether it
 * is three since the process started or three since the last reconnect.
 */
export type AdmissionDiagnosticsView = {
  /**
   * Whether the gateway would admit the origin THIS admin request arrived
   * from. PER REQUEST — neither a counter nor a snapshot.
   *
   * Absent when the request named no origin (a non-browser caller, or a
   * referrer policy that strips both headers), which is NOT `false`: the
   * panel renders a no as a conclusive fault with a finding behind it, so an
   * unasked question must never arrive as one.
   */
  originAdmitted?: boolean
  /**
   * How many ORIGIN RULES admit a client: each allowlist entry, plus one for
   * the derived same-origin rule when it is on. CONFIGURATION, not a counter.
   * See the gateway's own doc for why rules and not list entries.
   */
  allowedOriginCount?: number
  /** Whether the derived same-origin rule is on. CONFIGURATION, not a counter. */
  allowsSameOrigin?: boolean
  /** Open sockets the gateway holds at the instant of capture. WINDOWED — a gauge, never a total. */
  liveSockets?: number
  /** Sync tickets minted. MONOTONIC SINCE ATTACH. */
  ticketsIssued?: number
  /**
   * Mint requests that reached the gateway's issuer and produced no ticket.
   * MONOTONIC SINCE ATTACH.
   *
   * A mint made while the lane advertises no capability at all is refused
   * before it reaches that issuer, so this stays `0` on a structurally-down
   * lane — which `live.unavailabilityReasons` already names. See the gateway's
   * own doc on the member.
   */
  ticketsRefused?: number
  /** Handshakes that presented a ticket the gateway did not accept. MONOTONIC SINCE ATTACH. */
  handshakeRejected?: number
  /**
   * Upgrades refused at the door, by closed cause. MONOTONIC SINCE ATTACH.
   * Omitted entirely rather than emitted empty: an empty record would make the
   * panel render all ten rows on the strength of a block that reported nothing.
   */
  rejections?: Partial<Record<SocketRejectionCounterKey, number>>
  /**
   * How many operations a socket authenticating right now would be advertised.
   * CONFIGURATION-AND-READINESS, read per question — neither a counter nor a
   * total.
   *
   * A COUNT AND NEVER THE NAMES. The panel's capability block had no producer
   * for this at all and rendered its own empty note; an operation NAME is a
   * server-chosen string and this report is written to be pasted in public, so
   * what travels is a cardinality the client compares against the operation
   * list it already holds.
   *
   * ZERO IS A REAL READING and the one worth having: a lane whose socket opens
   * and advertises nothing refuses every mint before the gateway's issuer, so
   * `ticketsRefused` above reads 0 while every client is being turned away.
   */
  advertisableOperationCount?: number
}

/* -------------------------------------------------------------------------- */
/* Admission                                                                  */
/* -------------------------------------------------------------------------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A boolean, or `undefined` for anything else — including a string `'true'`. */
const admitBoolean = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined)

/**
 * A whole, non-negative count within a bound this build declared, or
 * `undefined`.
 *
 * `undefined` rather than `0`, and `undefined` rather than the bound, for the
 * same reason the runtime reader does it: a zero is a MEASUREMENT here (zero
 * refusals is the healthy reading an operator acts on) and a clamp would put a
 * figure on a screen that no process measured. A conforming gateway cannot
 * exceed these bounds — it saturates its own counters at exactly them — so a
 * figure above one is malformed by this contract, not merely large.
 */
const admitCount = (value: unknown, max: number): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined
  }

  const whole = Math.floor(value)

  return whole > max ? undefined : whole
}

/* -------------------------------------------------------------------------- */
/* Reading the gateway's admission block                                      */
/* -------------------------------------------------------------------------- */

/**
 * Read the attached gateway's admission block by allowlist.
 *
 * `undefined` — the whole block omitted, the panel's one sentence preserved —
 * when no gateway is attached or the value is not a record at all. That is the
 * NOTHING half of the all-or-nothing contract, and it is the honest answer for
 * a process that holds no socket: a gateway that never attached refused
 * nothing, and publishing zeros for it would be a measurement nobody took.
 *
 * NOTHING is copied through. Each field is reconstructed from an admitted
 * value, so a key this build has never heard of cannot reach a client by
 * riding along in an object spread.
 */
export function readGatewayAdmission(value: unknown): AdmissionDiagnosticsView | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  const view: AdmissionDiagnosticsView = {}

  const originAdmitted = admitBoolean(value.originAdmitted)
  if (originAdmitted !== undefined) {
    view.originAdmitted = originAdmitted
  }

  const allowedOriginCount = admitCount(value.allowedOriginCount, MAX_REPORTED_ORIGIN_RULES)
  if (allowedOriginCount !== undefined) {
    view.allowedOriginCount = allowedOriginCount
  }

  const allowsSameOrigin = admitBoolean(value.allowsSameOrigin)
  if (allowsSameOrigin !== undefined) {
    view.allowsSameOrigin = allowsSameOrigin
  }

  const liveSockets = admitCount(value.liveSockets, MAX_REPORTED_LIVE_SOCKETS)
  if (liveSockets !== undefined) {
    view.liveSockets = liveSockets
  }

  const ticketsIssued = admitCount(value.ticketsIssued, MAX_REPORTED_ADMISSION_EVENTS)
  if (ticketsIssued !== undefined) {
    view.ticketsIssued = ticketsIssued
  }

  const ticketsRefused = admitCount(value.ticketsRefused, MAX_REPORTED_ADMISSION_EVENTS)
  if (ticketsRefused !== undefined) {
    view.ticketsRefused = ticketsRefused
  }

  const handshakeRejected = admitCount(value.handshakeRejected, MAX_REPORTED_ADMISSION_EVENTS)
  if (handshakeRejected !== undefined) {
    view.handshakeRejected = handshakeRejected
  }

  const advertisableOperationCount = admitCount(value.advertisableOperationCount, MAX_REPORTED_ADVERTISABLE_OPERATIONS)
  if (advertisableOperationCount !== undefined) {
    view.advertisableOperationCount = advertisableOperationCount
  }

  const rejections = isRecord(value.rejections) ? value.rejections : {}
  const admitted: Partial<Record<SocketRejectionCounterKey, number>> = {}
  let anyCause = false
  for (const key of SOCKET_REJECTION_COUNTER_KEYS) {
    const count = admitCount(rejections[key], MAX_REPORTED_ADMISSION_EVENTS)
    if (count !== undefined) {
      admitted[key] = count
      anyCause = true
    }
  }
  if (anyCause) {
    view.rejections = admitted
  }

  return view
}

/* -------------------------------------------------------------------------- */
/* Building the probe from the asking request                                 */
/* -------------------------------------------------------------------------- */

/** The headers shape an Express/Node request carries, with nothing assumed present. */
export type AdmissionProbeHeaders = Record<string, string | string[] | undefined> | undefined

/**
 * What the gateway's origin decision reads, built from the ADMIN request.
 *
 * Mirrors the gateway's `AdmissionProbe` structurally rather than importing a
 * value, so this module stays a pure reader; the shape is pinned by a spec on
 * both sides.
 */
export type AdmissionProbeInput = {
  origin?: string
  host?: string
  forwardedProto?: string | string[]
  encrypted?: boolean
  proxyNormalizedHostPort?: boolean
}

/** Header values arrive as `string | string[]`; only a single value is an origin. */
const single = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined

/**
 * The origin this request came from, as the browser declared it.
 *
 * `Origin` first. Then the ORIGIN of `Referer`, because the deployment this
 * row matters most on is the one where it is absent: the bundled single
 * container serves the app and the API from ONE origin through nginx, so the
 * pane's `fetch` is same-origin and a same-origin GET carries no `Origin`
 * header at all. Without the fallback the headline row — "would this browser
 * be let onto the socket" — would read "not reported" on exactly the
 * deployment an operator is most likely to be debugging.
 *
 * Only the ORIGIN of the referrer is taken, never its path or query, and
 * neither header's value is emitted, logged or echoed: the whole of what
 * leaves this process is one boolean.
 */
function declaredOrigin(headers: Record<string, string | string[] | undefined>): string | undefined {
  const origin = single(headers.origin)
  if (origin !== undefined && origin.length > 0) {
    return origin
  }

  const referer = single(headers.referer) ?? single(headers.referrer)
  if (referer === undefined || referer.length === 0) {
    return undefined
  }

  try {
    const parsed = new URL(referer)

    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined
  } catch {
    return undefined
  }
}

/**
 * Build the admission probe for the request asking the diagnostics question.
 *
 * `proxyNormalizedHostPort` is set HERE and only here. A reverse proxy may
 * forward the API under a host whose port it normalised away while forwarding
 * the socket under the host the browser actually used — this repo's own
 * single-container nginx does exactly that, `Host $host` for `/v1` against
 * `Host $http_host` for `/sockets`, thirty lines apart — so a strict
 * comparison of THIS request's host would answer a conclusive "no" about a
 * socket the same deployment admits. The widening can only turn an ambiguous
 * no into a yes, and the panel renders a yes as `undetermined` while a no is
 * conclusive and raises a finding; the bias is deliberately toward the
 * caveated answer. The real upgrade path never sets it.
 */
export function admissionProbeFromHeaders(headers: AdmissionProbeHeaders, encrypted = false): AdmissionProbeInput {
  const present = headers ?? {}
  const origin = declaredOrigin(present)
  const host = single(present.host)
  const forwardedProto = present['x-forwarded-proto']

  return {
    ...(origin === undefined ? {} : { origin }),
    ...(host === undefined ? {} : { host }),
    ...(forwardedProto === undefined ? {} : { forwardedProto }),
    encrypted,
    proxyNormalizedHostPort: true,
  }
}
