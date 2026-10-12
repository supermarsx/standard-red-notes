/**
 * Standard Red Notes: every way the DAV bridge says no.
 *
 * The bridge has two kinds of answer and a client must never confuse them:
 *
 *   - "the remote said X" is HTTP 200 with a `remote` object, whatever X was;
 *   - "the relay refused" is one of the refusals below: never HTTP 200, always
 *     `error.tag` beginning `dav-`.
 *
 * The tags are a CLOSED list. A client switches on them to decide whether to
 * pause a linked calendar, wait, or ask for the password again, so a tag is a
 * contract: it is added here, in the client's catalogue and in the docs
 * together, and never renamed.
 *
 * `logTag` is separate on purpose. A user is told one sentence for every
 * blocked address, whatever the reason, so that the answer cannot be used to
 * map a network. The reason goes to the server log as a tag from a second
 * closed list, and to nobody else.
 */

export const DAV_REFUSAL_TAGS = [
  'dav-bridge-disabled',
  'dav-bridge-not-allowed',
  'dav-session-not-permitted',
  'dav-bridge-mode-unsupported',
  'dav-settings-unavailable',
  'dav-invalid-input',
  'dav-https-required',
  'dav-address-not-allowed',
  'dav-host-not-found',
  'dav-account-limit',
  'dav-rate-limited',
  'dav-busy',
  'dav-secret-store-unavailable',
  'dav-account-not-found',
  'dav-pin-locked',
  'dav-discovery-closed',
  'dav-path-not-allowed',
  'dav-invalid-path',
  'dav-method-not-allowed',
  'dav-header-not-allowed',
  'dav-writes-disabled',
  'dav-password-rejected',
  'dav-secret-unreadable',
  'dav-redirect-other-origin',
  'dav-request-too-large',
  'dav-response-too-large',
  'dav-tls-failed',
  'dav-remote-unreachable',
  'dav-remote-timeout',
  'dav-too-many-redirects',
  'dav-remote-circuit-open',
  'dav-allowlist-env-only',
] as const

export type DavRefusalTag = (typeof DAV_REFUSAL_TAGS)[number]

/** Values a refusal may carry beside its message. Never a secret, never remote text. */
export type DavRefusalExtra = Readonly<Record<string, string | number | Readonly<Record<string, string>>>>

export class DavBridgeRefusal extends Error {
  constructor(
    readonly httpStatus: number,
    readonly tag: DavRefusalTag,
    message: string,
    readonly extra: DavRefusalExtra = {},
    /** Why, for the server log only. From a closed list; never shown to the caller. */
    readonly logTag: string = tag,
  ) {
    super(message)
    this.name = 'DavBridgeRefusal'
  }

  /** The body a controller sends. Built field by field; nothing is spread from an input. */
  toBody(): { error: Record<string, unknown> } {
    return { error: { tag: this.tag, message: this.message, ...this.extra } }
  }

  /** Seconds to wait, when the refusal names one. Mirrored into a `Retry-After` header. */
  get retryAfterSeconds(): number | undefined {
    const value = this.extra.retryAfterSeconds
    return typeof value === 'number' ? value : undefined
  }
}

/**
 * One sentence for every blocked target. The origin is the caller's own input,
 * echoed so that they can forward the sentence to the administrator.
 */
const addressNotAllowedMessage = (origin: string): string =>
  `This address is not allowed by this server's network policy. Ask the administrator to allow ${origin}.`

export const davRefusal = {
  bridgeDisabled: (): DavBridgeRefusal =>
    new DavBridgeRefusal(403, 'dav-bridge-disabled', 'Calendar sync is switched off on this server.'),

  bridgeNotAllowed: (): DavBridgeRefusal =>
    new DavBridgeRefusal(403, 'dav-bridge-not-allowed', 'Calendar sync is not enabled for your account.'),

  sessionNotPermitted: (logTag: string): DavBridgeRefusal =>
    new DavBridgeRefusal(403, 'dav-session-not-permitted', 'This session cannot use calendar sync.', {}, logTag),

  modeUnsupported: (): DavBridgeRefusal =>
    new DavBridgeRefusal(
      503,
      'dav-bridge-mode-unsupported',
      'This server is configured with a calendar sync mode that this version does not support.',
    ),

  settingsUnavailable: (): DavBridgeRefusal =>
    new DavBridgeRefusal(
      503,
      'dav-settings-unavailable',
      'Calendar sync is unavailable because this server could not read its own settings.',
    ),

  invalidInput: (field: string, message = 'The request is not valid.'): DavBridgeRefusal =>
    new DavBridgeRefusal(400, 'dav-invalid-input', message, { field }),

  httpsRequired: (origin: string): DavBridgeRefusal =>
    new DavBridgeRefusal(400, 'dav-https-required', 'This server only connects over HTTPS.', { origin }),

  addressNotAllowed: (origin: string, logTag: string): DavBridgeRefusal =>
    new DavBridgeRefusal(403, 'dav-address-not-allowed', addressNotAllowedMessage(origin), { origin }, logTag),

  /** `whileSaving` is the form's answer (the address was just typed); otherwise the relay's. */
  hostNotFound: (host: string, whileSaving: boolean): DavBridgeRefusal =>
    new DavBridgeRefusal(
      whileSaving ? 400 : 502,
      'dav-host-not-found',
      `The server could not find ${host}. Check the address.`,
      { host },
    ),

  accountLimit: (limit: number): DavBridgeRefusal =>
    new DavBridgeRefusal(409, 'dav-account-limit', `You can connect at most ${limit} accounts.`, { limit }),

  rateLimited: (budget: 'requests' | 'writes' | 'validations', retryAfterSeconds: number): DavBridgeRefusal =>
    new DavBridgeRefusal(429, 'dav-rate-limited', 'Too many calendar sync requests. Try again later.', {
      budget,
      retryAfterSeconds,
    }),

  busy: (scope: 'account' | 'origin' | 'server'): DavBridgeRefusal =>
    new DavBridgeRefusal(
      429,
      'dav-busy',
      'Calendar sync is busy. Try again in a moment.',
      { retryAfterSeconds: 1 },
      `busy-${scope}`,
    ),

  secretStoreUnavailable: (logTag: string): DavBridgeRefusal =>
    new DavBridgeRefusal(
      503,
      'dav-secret-store-unavailable',
      'This server cannot read or store connected accounts right now. Ask the administrator.',
      {},
      logTag,
    ),

  accountNotFound: (): DavBridgeRefusal =>
    new DavBridgeRefusal(404, 'dav-account-not-found', 'Connected account not found.'),

  pinLocked: (): DavBridgeRefusal =>
    new DavBridgeRefusal(
      409,
      'dav-pin-locked',
      'Enter the password again to change which calendars this account can reach.',
    ),

  discoveryClosed: (): DavBridgeRefusal =>
    new DavBridgeRefusal(409, 'dav-discovery-closed', 'Enter the password again to finish connecting this account.'),

  pathNotAllowed: (logTag: string): DavBridgeRefusal =>
    new DavBridgeRefusal(
      403,
      'dav-path-not-allowed',
      'This account is limited to its calendars. That address is outside them.',
      {},
      logTag,
    ),

  invalidPath: (logTag: string): DavBridgeRefusal =>
    new DavBridgeRefusal(400, 'dav-invalid-path', 'The requested path is not valid.', {}, logTag),

  methodNotAllowed: (method: string): DavBridgeRefusal =>
    new DavBridgeRefusal(400, 'dav-method-not-allowed', 'That request method is not forwarded.', { method }),

  headerNotAllowed: (header: string, logTag: string): DavBridgeRefusal =>
    new DavBridgeRefusal(400, 'dav-header-not-allowed', 'That request header is not forwarded.', { header }, logTag),

  writesDisabled: (method: string): DavBridgeRefusal =>
    new DavBridgeRefusal(403, 'dav-writes-disabled', 'This server does not write to connected accounts.', { method }),

  passwordRejected: (): DavBridgeRefusal =>
    new DavBridgeRefusal(
      409,
      'dav-password-rejected',
      'The account no longer accepts the stored password. Sync is paused so that the account is not locked.',
    ),

  secretUnreadable: (): DavBridgeRefusal =>
    new DavBridgeRefusal(409, 'dav-secret-unreadable', 'The stored password can no longer be read. Enter it again.'),

  redirectOtherOrigin: (host: string, location: { origin: string; path: string }): DavBridgeRefusal =>
    new DavBridgeRefusal(409, 'dav-redirect-other-origin', `${host} points to another address.`, { location }),

  requestTooLarge: (limit: number): DavBridgeRefusal =>
    new DavBridgeRefusal(413, 'dav-request-too-large', 'The request is too large to forward.', { limit }),

  responseTooLarge: (limit: number): DavBridgeRefusal =>
    new DavBridgeRefusal(502, 'dav-response-too-large', 'The answer was too large to pass on.', { limit }),

  tlsFailed: (host: string): DavBridgeRefusal =>
    new DavBridgeRefusal(502, 'dav-tls-failed', `${host} presented a certificate this server does not trust.`, {
      host,
    }),

  remoteUnreachable: (host: string, logTag: string): DavBridgeRefusal =>
    new DavBridgeRefusal(502, 'dav-remote-unreachable', `${host} did not answer.`, { host }, logTag),

  remoteTimeout: (host: string): DavBridgeRefusal =>
    new DavBridgeRefusal(504, 'dav-remote-timeout', `${host} took too long to answer.`, { host }),

  tooManyRedirects: (): DavBridgeRefusal =>
    new DavBridgeRefusal(502, 'dav-too-many-redirects', 'The account kept redirecting the request.'),

  circuitOpen: (retryAfterSeconds: number): DavBridgeRefusal =>
    new DavBridgeRefusal(
      503,
      'dav-remote-circuit-open',
      'The account has not answered several times in a row. Trying again later.',
      { retryAfterSeconds },
    ),

  allowlistEnvOnly: (): DavBridgeRefusal =>
    new DavBridgeRefusal(
      409,
      'dav-allowlist-env-only',
      'The allowed-origin list is set in the server environment and cannot be changed here.',
    ),
}
