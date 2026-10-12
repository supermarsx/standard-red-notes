import { randomUUID } from 'crypto'
import { isIP } from 'net'

import { isBlockedIp, isOperatorAllowablePrivateIp } from '@standardnotes/domain-core'

import { SERVER_SETTINGS_BOUNDS, isExactHttpOrigin } from '../ServerSettings/ServerSettingsStore'
import {
  DAV_ACCOUNT_LIMITS,
  DavAccountKind,
  DavAccountLimitError,
  DavAccountStore,
  DavAccountStoreError,
  DavCredentialKind,
  PersistedDavAccount,
} from './DavAccountStore'
import { DavBridgeRefusal, davRefusal } from './DavBridgeRefusal'
import {
  DAV_BRIDGE_IMPLEMENTED_MODES,
  DavBridgeSettings,
  DavBridgeSettingsPatch,
  DavBridgeSettingsView,
  ResolvedDavBridgeSettings,
} from './DavBridgeSettings'
import { DAV_OWN_SERVICE_NAMES, DavNetworkPolicy } from './DavNetworkPolicy'
import {
  assertValidDavPath,
  assertValidDavPinPath,
  DAV_READ_METHODS,
  DAV_RELAY_LIMITS,
  DAV_RELAY_WRITE_ENABLED,
  DavRelay,
  DavRelayAbortedError,
  DavRelayOutcome,
  DavRemoteAnswer,
  parseDavRelayEnvelope,
} from './DavRelay'
import { DavRelayLimiter, DEFAULT_DAV_RELAY_LIMITS } from './DavRelayLimiter'
import { DavSecretCipher, DavSecretStoreUnavailableError, DavSecretUnreadableError } from './DavSecretCipher'
import { SecretString } from './SecretString'

/**
 * Standard Red Notes: the DAV bridge, as the rest of the gateway sees it.
 *
 * Every decision about who may do what is made HERE, not in a controller and
 * not in middleware: the two gates, the session rules, the per-user budget.
 * A route added later cannot forget them, and on the all-in-one container,
 * where a guard that lives only in Express middleware has been absent before,
 * there is nothing to be absent.
 *
 * The seam for a second mode is `ResolvedDavBridgeSettings.mode`. `relay` is the
 * only mode this build implements: the server forwards requests and keeps no
 * calendar content. A mode in which the server also keeps a copy would add its
 * own store and scheduler behind the same gates, accounts, credential store and
 * network policy; nothing here would have to be redone for it.
 */

/** Who is asking. Built by the controller from the verified session, never from a request body. */
export interface DavBridgeCaller {
  userUuid: string
  /** The administrator-set DAV_BRIDGE_ALLOWED permission, as carried by the session token. */
  permitted: boolean
  readOnlySession: boolean
  mcpScoped: boolean
}

export type DavAccountStatus = 'unverified' | 'ok' | 'password-rejected' | 'secret-unreadable'

/**
 * The only shape an account is ever returned in. Built field by field from a
 * fixed list in `toView`; there is no object spread anywhere on that path, and
 * there is no field here that could hold the secret.
 */
export interface DavAccountView {
  id: string
  kind: DavAccountKind
  origin: string
  entryPath: string
  username: string
  credentialKind: DavCredentialKind
  secretConfigured: true
  status: DavAccountStatus
  pin: { principalPath: string; calendarHomePath: string } | null
  discoveryOpenUntil: string | null
  createdAt: string
  updatedAt: string
}

export interface DavBridgeConfigView {
  enabled: boolean
  allowed: boolean
  available: boolean
  mode: string
  writeEnabled: boolean
  methods: string[]
  limits: {
    maxAccounts: number
    requestBodyBytes: number
    responseBodyBytes: number
    requestTimeoutMs: number
    pathLength: number
    discoveryWindowSeconds: number
    requestsPerTenMinutes: number
    writesPerMinute: number
    accountValidationsPerHour: number
  }
}

export interface DavBridgeAdminView extends DavBridgeSettingsView {
  secretStoreReady: boolean
  writeEnabled: boolean
  limits: DavBridgeConfigView['limits']
  activeRequests: number
  users: Array<{
    userUuid: string
    accounts: Array<{
      id: string
      kind: DavAccountKind
      origin: string
      status: DavAccountStatus
      lastResult: string | null
      requests: number
    }>
  }>
  usersTruncated: boolean
}

/**
 * The logger the bridge needs. Every call site passes a message from a fixed
 * set and metadata built from the closed field list in `relayLogFields`.
 */
export interface DavBridgeLogger {
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  debug(message: string, meta?: Record<string, unknown>): void
}

export interface DavBridgeServiceDependencies {
  settings: DavBridgeSettings
  store: DavAccountStore
  cipher: DavSecretCipher
  policy: DavNetworkPolicy
  relay: DavRelay
  limiter: DavRelayLimiter
  logger: DavBridgeLogger
  now?: () => number
  newId?: () => string
}

const MAX_URL_LENGTH = 2048
const MAX_SECRET_LENGTH = 4096
const MAX_ADMIN_VIEW_USERS = 500
const MAX_TRACKED_ACCOUNT_STATS = 20_000

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const hasControlCharacter = (value: string): boolean => /[\u0000-\u001f\u007f]/.test(value)

interface AccountStats {
  requests: number
  lastResult: string
}

export class DavBridgeService {
  private readonly settings: DavBridgeSettings
  private readonly store: DavAccountStore
  private readonly cipher: DavSecretCipher
  private readonly policy: DavNetworkPolicy
  private readonly relayTransport: DavRelay
  private readonly limiter: DavRelayLimiter
  private readonly logger: DavBridgeLogger
  private readonly now: () => number
  private readonly newId: () => string
  /** Requests in flight per account, so that removing an account can stop them. */
  private readonly inFlight = new Map<string, Set<AbortController>>()
  /** Per-process counters for the administrator's view. Never persisted. */
  private readonly stats = new Map<string, AccountStats>()

  constructor(dependencies: DavBridgeServiceDependencies) {
    this.settings = dependencies.settings
    this.store = dependencies.store
    this.cipher = dependencies.cipher
    this.policy = dependencies.policy
    this.relayTransport = dependencies.relay
    this.limiter = dependencies.limiter
    this.logger = dependencies.logger
    this.now = dependencies.now ?? ((): number => Date.now())
    this.newId = dependencies.newId ?? ((): string => randomUUID())
  }

  /**
   * Whether the bridge is usable for this caller, and its limits. Never
   * refuses: the pane needs this to explain WHY sync is off.
   */
  async config(caller: DavBridgeCaller): Promise<DavBridgeConfigView> {
    let resolved: ResolvedDavBridgeSettings | undefined
    try {
      resolved = await this.settings.resolve()
    } catch {
      resolved = undefined
    }
    const enabled = resolved?.enabled ?? false
    const allowed = !caller.mcpScoped && (resolved?.allowAllUsers === true || caller.permitted)

    return {
      enabled,
      allowed,
      available: enabled && allowed && resolved?.modeImplemented === true,
      mode: resolved?.mode ?? DAV_BRIDGE_IMPLEMENTED_MODES[0],
      writeEnabled: DAV_RELAY_WRITE_ENABLED,
      methods: [...DAV_READ_METHODS],
      limits: this.limitsView(resolved?.maxAccountsPerUser ?? 0),
    }
  }

  /** No gates: a user can always see what the server holds for them. */
  async listAccounts(caller: DavBridgeCaller): Promise<DavAccountView[]> {
    this.assertSessionMayRead(caller)
    const accounts = await this.guardStore(() => this.store.list(caller.userUuid))
    return [...accounts]
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((account) => this.toView(account, caller.userUuid))
  }

  async createAccount(caller: DavBridgeCaller, input: unknown): Promise<DavAccountView> {
    const settings = await this.requireGates(caller, true)
    const parsed = this.parseAccountInput(input)
    await this.limiter.consume(caller.userUuid, 'validations')
    this.assertSecretStoreReady()

    await this.policy.assertSavable(new URL(parsed.origin), new Set(settings.allowedPrivateOrigins))

    const now = this.now()
    const id = this.newId()
    const secret = this.cipher.seal(parsed.secret, caller.userUuid.toLowerCase(), id)
    let created: PersistedDavAccount
    try {
      created = await this.store.create(caller.userUuid, settings.maxAccountsPerUser, () => ({
        id,
        kind: parsed.kind,
        origin: parsed.origin,
        entryPath: parsed.entryPath,
        username: parsed.username,
        credentialKind: parsed.credentialKind,
        secret,
        secretSetAt: now,
        secretState: 'unverified',
        pin: null,
        createdAt: now,
        updatedAt: now,
      }))
    } catch (error) {
      if (error instanceof DavAccountLimitError) {
        throw davRefusal.accountLimit(error.limit)
      }
      throw this.storeRefusal(error)
    }

    this.logger.info('dav bridge account created', { userId: caller.userUuid, accountId: created.id })
    return this.toView(created, caller.userUuid)
  }

  /** Replaces the stored secret. Nothing reads the old one back. Reopens the discovery window. */
  async replaceSecret(caller: DavBridgeCaller, accountId: string, input: unknown): Promise<DavAccountView> {
    await this.requireGates(caller, true)
    const existing = await this.requireAccount(caller.userUuid, accountId)
    if (!isJsonObject(input)) {
      throw davRefusal.invalidInput('body')
    }
    const credentialKind =
      input.credentialKind === undefined ? existing.credentialKind : this.parseCredentialKind(input.credentialKind)
    const username =
      input.username === undefined ? existing.username : this.parseUsername(input.username, credentialKind)
    // Re-checked against the kind that will be stored: a username kept from a
    // bearer account may be empty, and Basic needs one.
    this.parseUsername(username, credentialKind)
    const secret = this.parseSecret(input.secret, credentialKind)

    await this.limiter.consume(caller.userUuid, 'validations')
    this.assertSecretStoreReady()

    const now = this.now()
    const sealed = this.cipher.seal(secret, caller.userUuid.toLowerCase(), existing.id)
    const updated = await this.guardStore(() =>
      this.store.update(caller.userUuid, existing.id, (account) => ({
        id: account.id,
        kind: account.kind,
        origin: account.origin,
        entryPath: account.entryPath,
        username,
        credentialKind,
        secret: sealed,
        // Strictly after any existing pin, so "a secret was entered since the
        // pin was set" is decidable even inside one millisecond.
        secretSetAt: Math.max(now, (account.pin?.setAt ?? 0) + 1),
        secretState: 'unverified',
        pin: account.pin,
        createdAt: account.createdAt,
        updatedAt: now,
      })),
    )
    if (updated === null) {
      throw davRefusal.accountNotFound()
    }

    this.logger.info('dav bridge account secret replaced', { userId: caller.userUuid, accountId: updated.id })
    return this.toView(updated, caller.userUuid)
  }

  /**
   * Fixes which part of the remote this account may reach. Allowed only while
   * the discovery window is open, that is, shortly after the password was
   * entered; setting it closes the window. So moving the pin takes the
   * password, which a stolen session does not have.
   */
  async setPin(caller: DavBridgeCaller, accountId: string, input: unknown): Promise<DavAccountView> {
    await this.requireGates(caller, true)
    const existing = await this.requireAccount(caller.userUuid, accountId)
    if (!isJsonObject(input)) {
      throw davRefusal.invalidInput('body')
    }
    const principalPath = assertValidDavPinPath(input.principalPath, 'principalPath')
    const calendarHomePath = assertValidDavPinPath(input.calendarHomePath, 'calendarHomePath')

    const now = this.now()
    let locked = false
    const updated = await this.guardStore(() =>
      this.store.update(caller.userUuid, existing.id, (account) => {
        // Decided inside the file lock, on the account as it is now: two
        // requests cannot both find the window open.
        if (!this.isDiscoveryOpen(account, now)) {
          locked = true
          return account
        }
        return {
          id: account.id,
          kind: account.kind,
          origin: account.origin,
          entryPath: account.entryPath,
          username: account.username,
          credentialKind: account.credentialKind,
          secret: account.secret,
          secretSetAt: account.secretSetAt,
          secretState: account.secretState,
          pin: { principalPath, calendarHomePath, setAt: Math.max(now, account.secretSetAt) },
          createdAt: account.createdAt,
          updatedAt: now,
        }
      }),
    )
    if (updated === null) {
      throw davRefusal.accountNotFound()
    }
    if (locked) {
      throw davRefusal.pinLocked()
    }

    this.logger.info('dav bridge account pinned', { userId: caller.userUuid, accountId: updated.id })
    return this.toView(updated, caller.userUuid)
  }

  /** No gates: removing what the server holds must work after the feature is switched off. */
  async deleteAccount(caller: DavBridgeCaller, accountId: string): Promise<void> {
    this.assertSessionMayWrite(caller)
    const removed = await this.guardStore(() => this.store.remove(caller.userUuid, accountId))
    if (!removed) {
      throw davRefusal.accountNotFound()
    }
    this.abortInFlight(this.accountKey(caller.userUuid, accountId))
    this.stats.delete(this.accountKey(caller.userUuid, accountId))
    this.logger.info('dav bridge account removed', { userId: caller.userUuid, accountId })
  }

  async deleteAllAccounts(caller: DavBridgeCaller): Promise<number> {
    this.assertSessionMayWrite(caller)
    return this.forgetUser(caller.userUuid)
  }

  /**
   * Removes everything held for a user. Called when a user removes all their
   * accounts, when an administrator purges a user, and when an SRN account is
   * deleted: a stored password must not outlive the account it belonged to.
   */
  async forgetUser(userUuid: string): Promise<number> {
    const removed = await this.guardStore(() => this.store.removeAllForUser(userUuid))
    const prefix = `${userUuid.toLowerCase()}|`
    for (const key of [...this.inFlight.keys()]) {
      if (key.startsWith(prefix)) {
        this.abortInFlight(key)
      }
    }
    for (const key of [...this.stats.keys()]) {
      if (key.startsWith(prefix)) {
        this.stats.delete(key)
      }
    }
    if (removed > 0) {
      this.logger.info('dav bridge accounts purged for user', { userId: userUuid, accounts: removed })
    }
    return removed
  }

  /** Forwards one request to the caller's own account, or throws the refusal. */
  async relay(
    caller: DavBridgeCaller,
    accountId: string,
    envelope: unknown,
    signal?: AbortSignal,
  ): Promise<{ remote: DavRemoteAnswer }> {
    const startedAt = this.now()
    let method = 'invalid'
    try {
      const settings = await this.requireGates(caller, true)
      await this.limiter.consume(caller.userUuid, 'requests')
      const request = parseDavRelayEnvelope(envelope)
      method = request.method
      const account = await this.requireAccount(caller.userUuid, accountId)
      const key = this.accountKey(caller.userUuid, account.id)

      if (account.secretState === 'rejected') {
        // Not forwarded, not retried: the remote slows down the SOURCE ADDRESS
        // after failed sign-ins, and that address is this server's, shared by
        // every user of the instance.
        throw davRefusal.passwordRejected()
      }
      const secret = this.openSecret(account, caller.userUuid)
      this.limiter.assertCircuitClosed(caller.userUuid, account.origin)

      const release = this.limiter.acquire(key, account.origin)
      const controller = this.track(key, signal)
      let outcome: DavRelayOutcome
      try {
        outcome = await this.relayTransport.forward(
          {
            origin: account.origin,
            credentialKind: account.credentialKind,
            username: account.username,
            secret,
            pin: account.pin,
            discoveryOpen: this.isDiscoveryOpen(account, startedAt),
            allowedPrivateOrigins: new Set(settings.allowedPrivateOrigins),
          },
          request,
          controller.signal,
        )
      } catch (error) {
        if (error instanceof DavRelayAbortedError) {
          // Cancelled from this side. If that was because the account went
          // away, say so; otherwise the caller has left and nobody is listening.
          throw (await this.store.get(caller.userUuid, account.id).catch(() => null)) === null
            ? davRefusal.accountNotFound()
            : error
        }
        if (error instanceof DavBridgeRefusal && REMOTE_FAILURE_TAGS.has(error.tag)) {
          this.limiter.recordFailure(caller.userUuid, account.origin)
        }
        throw error
      } finally {
        release()
        this.untrack(key, controller)
      }

      if (outcome.kind === 'unauthorized') {
        await this.markSecretState(caller.userUuid, account.id, 'rejected')
        this.logger.warn('dav bridge account password rejected', { userId: caller.userUuid, accountId: account.id })
        throw davRefusal.passwordRejected()
      }

      const status = outcome.answer.status
      if (status >= 500) {
        this.limiter.recordFailure(caller.userUuid, account.origin)
      } else {
        this.limiter.recordSuccess(caller.userUuid, account.origin)
      }
      if (status >= 200 && status < 300 && account.secretState === 'unverified') {
        // One write per password, on the first answer that proves it works.
        await this.markSecretState(caller.userUuid, account.id, 'accepted')
      }

      this.count(key, status >= 500 ? 'remote-error' : 'ok')
      this.logger.debug('dav bridge request relayed', {
        userId: caller.userUuid,
        accountId: account.id,
        method,
        status,
        durationMs: this.now() - startedAt,
        requestBytes: outcome.requestBytes,
        responseBytes: outcome.responseBytes,
      })
      return { remote: outcome.answer }
    } catch (error) {
      if (error instanceof DavBridgeRefusal) {
        if (this.loggableAccountId(accountId) !== 'invalid') {
          this.count(this.accountKey(caller.userUuid, accountId), error.tag)
        }
        this.logger.info('dav bridge request refused', {
          userId: caller.userUuid,
          accountId: this.loggableAccountId(accountId),
          method,
          durationMs: this.now() - startedAt,
          tag: error.tag,
          reason: error.logTag,
        })
      }
      throw error
    }
  }

  // ---------------------------------------------------------------- administrator

  async adminView(): Promise<DavBridgeAdminView> {
    const view = await this.settings.view()
    const userUuids = await this.guardStore(() => this.store.listUserUuids())
    const users: DavBridgeAdminView['users'] = []
    for (const userUuid of userUuids.slice(0, MAX_ADMIN_VIEW_USERS)) {
      let accounts: PersistedDavAccount[]
      try {
        accounts = await this.store.list(userUuid)
      } catch {
        // One unreadable file must not hide every other user from the view.
        accounts = []
      }
      users.push({
        userUuid,
        // Field by field. No username, no path, no content.
        accounts: accounts.map((account) => {
          const stats = this.stats.get(this.accountKey(userUuid, account.id))
          return {
            id: account.id,
            kind: account.kind,
            origin: account.origin,
            status: this.statusOf(account, userUuid),
            lastResult: stats?.lastResult ?? null,
            requests: stats?.requests ?? 0,
          }
        }),
      })
    }

    return {
      settings: view.settings,
      sources: view.sources,
      modes: view.modes,
      modeImplemented: view.modeImplemented,
      allowlistEditable: view.allowlistEditable,
      secretStoreReady: this.cipher.isReady(),
      writeEnabled: DAV_RELAY_WRITE_ENABLED,
      limits: this.limitsView(view.settings.maxAccountsPerUser),
      activeRequests: this.limiter.activeRequests(),
      users,
      usersTruncated: userUuids.length > MAX_ADMIN_VIEW_USERS,
    }
  }

  /** Validates and saves administrator overrides. Returns the names that changed, for the audit line. */
  async adminUpdate(input: unknown): Promise<string[]> {
    if (!isJsonObject(input)) {
      throw davRefusal.invalidInput('body')
    }
    const patch: DavBridgeSettingsPatch = {}
    const changed: string[] = []

    for (const key of ['enabled', 'allowAllUsers'] as const) {
      const value = input[key]
      if (value === undefined) {
        continue
      }
      if (value !== null && typeof value !== 'boolean') {
        throw davRefusal.invalidInput(key, `${key} must be true, false, or null to clear it.`)
      }
      patch[key] = value
      changed.push(`davBridge.${key}`)
    }

    if (input.mode !== undefined) {
      if (
        input.mode !== null &&
        !(typeof input.mode === 'string' && DAV_BRIDGE_IMPLEMENTED_MODES.includes(input.mode))
      ) {
        throw davRefusal.invalidInput(
          'mode',
          `mode must be one of: ${DAV_BRIDGE_IMPLEMENTED_MODES.join(', ')}; or null to clear it.`,
        )
      }
      patch.mode = input.mode as string | null
      changed.push('davBridge.mode')
    }

    if (input.maxAccountsPerUser !== undefined) {
      const value = input.maxAccountsPerUser
      const bounds = SERVER_SETTINGS_BOUNDS.davBridgeAccountsPerUser
      if (
        value !== null &&
        !(
          typeof value === 'number' &&
          Number.isSafeInteger(value) &&
          value >= bounds.minimum &&
          value <= bounds.maximum
        )
      ) {
        throw davRefusal.invalidInput(
          'maxAccountsPerUser',
          `maxAccountsPerUser must be a whole number from ${bounds.minimum} to ${bounds.maximum}, or null to clear it.`,
        )
      }
      patch.maxAccountsPerUser = value as number | null
      changed.push('davBridge.maxAccountsPerUser')
    }

    if (input.allowedPrivateOrigins !== undefined) {
      const value = input.allowedPrivateOrigins
      if (value !== null) {
        if (!Array.isArray(value) || value.length > SERVER_SETTINGS_BOUNDS.davBridgeAllowedOrigins.maximum) {
          throw davRefusal.invalidInput('allowedPrivateOrigins', 'allowedPrivateOrigins must be a list of origins.')
        }
        for (const entry of value) {
          this.assertListableOrigin(entry)
        }
        if (new Set(value).size !== value.length) {
          throw davRefusal.invalidInput('allowedPrivateOrigins', 'allowedPrivateOrigins lists an origin twice.')
        }
      }
      patch.allowedPrivateOrigins = value as string[] | null
      changed.push('davBridge.allowedPrivateOrigins')
    }

    if (changed.length === 0) {
      throw davRefusal.invalidInput('body', 'No recognized settings provided.')
    }

    try {
      await this.settings.applyPatch(patch)
    } catch (error) {
      if (error instanceof DavBridgeRefusal) {
        throw error
      }
      throw davRefusal.settingsUnavailable()
    }
    return changed
  }

  async purgeUser(userUuid: string): Promise<{ purgedUsers: number; purgedAccounts: number }> {
    const accounts = await this.forgetUser(userUuid)
    return { purgedUsers: accounts > 0 ? 1 : 0, purgedAccounts: accounts }
  }

  async purgeAll(): Promise<{ purgedUsers: number; purgedAccounts: number }> {
    let purgedUsers = 0
    let purgedAccounts = 0
    for (const userUuid of await this.guardStore(() => this.store.listUserUuids())) {
      const accounts = await this.forgetUser(userUuid)
      if (accounts > 0) {
        purgedUsers += 1
        purgedAccounts += accounts
      }
    }
    return { purgedUsers, purgedAccounts }
  }

  // ------------------------------------------------------------------- internals

  /**
   * The two gates and the session rules. `mutating` covers everything except
   * looking: creating, replacing, pinning and relaying.
   */
  private async requireGates(caller: DavBridgeCaller, mutating: boolean): Promise<ResolvedDavBridgeSettings> {
    if (mutating) {
      this.assertSessionMayWrite(caller)
    } else {
      this.assertSessionMayRead(caller)
    }
    const settings = await this.settings.resolve()
    if (!settings.enabled) {
      throw davRefusal.bridgeDisabled()
    }
    if (!settings.modeImplemented) {
      throw davRefusal.modeUnsupported()
    }
    if (!settings.allowAllUsers && !caller.permitted) {
      throw davRefusal.bridgeNotAllowed()
    }
    return settings
  }

  /** An automation token is scoped to notes. It has no business with an external account. */
  private assertSessionMayRead(caller: DavBridgeCaller): void {
    if (caller.mcpScoped) {
      throw davRefusal.sessionNotPermitted('mcp-scope')
    }
  }

  private assertSessionMayWrite(caller: DavBridgeCaller): void {
    this.assertSessionMayRead(caller)
    if (caller.readOnlySession) {
      throw davRefusal.sessionNotPermitted('read-only-session')
    }
  }

  private assertSecretStoreReady(): void {
    if (!this.cipher.isReady()) {
      throw davRefusal.secretStoreUnavailable('no-encryption-key')
    }
  }

  /** An id that belongs to someone else and one that does not exist give the same answer. */
  private async requireAccount(userUuid: string, accountId: string): Promise<PersistedDavAccount> {
    const account = await this.guardStore(() => this.store.get(userUuid, accountId))
    if (account === null) {
      throw davRefusal.accountNotFound()
    }
    return account
  }

  private openSecret(account: PersistedDavAccount, userUuid: string): SecretString {
    try {
      return this.cipher.open(account.secret, userUuid.toLowerCase(), account.id)
    } catch (error) {
      if (error instanceof DavSecretStoreUnavailableError) {
        throw davRefusal.secretStoreUnavailable('no-encryption-key')
      }
      if (error instanceof DavSecretUnreadableError) {
        throw davRefusal.secretUnreadable()
      }
      throw error
    }
  }

  private async markSecretState(userUuid: string, accountId: string, state: 'accepted' | 'rejected'): Promise<void> {
    try {
      await this.store.update(userUuid, accountId, (account) => {
        // A rejection is never downgraded by a slower request that started
        // before it, and a transition that already happened is not rewritten.
        if (account.secretState === state || account.secretState === 'rejected') {
          return account
        }
        return {
          id: account.id,
          kind: account.kind,
          origin: account.origin,
          entryPath: account.entryPath,
          username: account.username,
          credentialKind: account.credentialKind,
          secret: account.secret,
          secretSetAt: account.secretSetAt,
          secretState: state,
          pin: account.pin,
          createdAt: account.createdAt,
          updatedAt: this.now(),
        }
      })
    } catch (error) {
      if (state === 'rejected') {
        // Failing to RECORD a rejection must not turn into retrying the
        // password: surface the failure instead of the answer.
        throw this.storeRefusal(error)
      }
      // Failing to record a first success costs one more write attempt later.
    }
  }

  /**
   * Open while the password was entered recently AND no pin has been set since.
   * The window exists so that discovery can look around before anything is
   * pinned; it must not be a standing permission.
   */
  private isDiscoveryOpen(account: PersistedDavAccount, now: number): boolean {
    if (account.pin !== null && account.pin.setAt >= account.secretSetAt) {
      return false
    }
    return now < account.secretSetAt + DAV_RELAY_LIMITS.discoveryWindowSeconds * 1000
  }

  private statusOf(account: PersistedDavAccount, userUuid: string): DavAccountStatus {
    try {
      this.cipher.open(account.secret, userUuid.toLowerCase(), account.id)
    } catch {
      return 'secret-unreadable'
    }
    if (account.secretState === 'rejected') {
      return 'password-rejected'
    }
    return account.secretState === 'accepted' ? 'ok' : 'unverified'
  }

  private toView(account: PersistedDavAccount, userUuid: string): DavAccountView {
    const now = this.now()
    return {
      id: account.id,
      kind: account.kind,
      origin: account.origin,
      entryPath: account.entryPath,
      username: account.username,
      credentialKind: account.credentialKind,
      secretConfigured: true,
      status: this.statusOf(account, userUuid),
      pin:
        account.pin === null
          ? null
          : { principalPath: account.pin.principalPath, calendarHomePath: account.pin.calendarHomePath },
      discoveryOpenUntil: this.isDiscoveryOpen(account, now)
        ? new Date(account.secretSetAt + DAV_RELAY_LIMITS.discoveryWindowSeconds * 1000).toISOString()
        : null,
      createdAt: new Date(account.createdAt).toISOString(),
      updatedAt: new Date(account.updatedAt).toISOString(),
    }
  }

  private limitsView(maxAccounts: number): DavBridgeConfigView['limits'] {
    return {
      maxAccounts,
      requestBodyBytes: DAV_RELAY_LIMITS.requestBodyBytes,
      responseBodyBytes: DAV_RELAY_LIMITS.responseBodyBytes,
      requestTimeoutMs: DAV_RELAY_LIMITS.requestTimeoutMs,
      pathLength: DAV_RELAY_LIMITS.pathLength,
      discoveryWindowSeconds: DAV_RELAY_LIMITS.discoveryWindowSeconds,
      requestsPerTenMinutes: DEFAULT_DAV_RELAY_LIMITS.budgets.requests.max,
      writesPerMinute: DEFAULT_DAV_RELAY_LIMITS.budgets.writes.max,
      accountValidationsPerHour: DEFAULT_DAV_RELAY_LIMITS.budgets.validations.max,
    }
  }

  private parseAccountInput(input: unknown): {
    kind: DavAccountKind
    origin: string
    entryPath: string
    username: string
    credentialKind: DavCredentialKind
    secret: SecretString
  } {
    if (!isJsonObject(input)) {
      throw davRefusal.invalidInput('body')
    }
    if (input.kind !== 'nextcloud' && input.kind !== 'caldav') {
      throw davRefusal.invalidInput('kind')
    }
    const credentialKind = input.credentialKind === undefined ? 'basic' : this.parseCredentialKind(input.credentialKind)
    // The secret is wrapped before anything else is looked at, so no later
    // failure on this path has a bare password within reach.
    const secret = this.parseSecret(input.secret, credentialKind)
    const username = this.parseUsername(input.username ?? '', credentialKind)

    if (typeof input.url !== 'string' || input.url.length === 0 || input.url.length > MAX_URL_LENGTH) {
      throw davRefusal.invalidInput('url')
    }
    let url: URL
    try {
      url = new URL(input.url)
    } catch {
      throw davRefusal.invalidInput('url')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw davRefusal.invalidInput('url')
    }
    // A password in the address would be stored and shown as part of it.
    // Refused, not stripped: the user should know it was not used.
    if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
      throw davRefusal.invalidInput('url')
    }
    if (url.hostname === '' || url.origin === 'null' || url.origin.length > DAV_ACCOUNT_LIMITS.originLength) {
      throw davRefusal.invalidInput('url')
    }
    let entryPath: string
    try {
      entryPath = assertValidDavPath(url.pathname)
    } catch {
      throw davRefusal.invalidInput('url')
    }

    return { kind: input.kind, origin: url.origin, entryPath, username, credentialKind, secret }
  }

  private parseCredentialKind(value: unknown): DavCredentialKind {
    if (value !== 'basic' && value !== 'bearer') {
      throw davRefusal.invalidInput('credentialKind')
    }
    return value
  }

  private parseUsername(value: unknown, credentialKind: DavCredentialKind): string {
    if (typeof value !== 'string' || value.length > DAV_ACCOUNT_LIMITS.usernameLength || hasControlCharacter(value)) {
      throw davRefusal.invalidInput('username')
    }
    // Basic joins the two with a colon, so a colon in the name would move the
    // boundary between name and password.
    if (credentialKind === 'basic' && (value.length === 0 || value.includes(':'))) {
      throw davRefusal.invalidInput('username')
    }
    return value
  }

  private parseSecret(value: unknown, credentialKind: DavCredentialKind): SecretString {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SECRET_LENGTH) {
      throw davRefusal.invalidInput('secret')
    }
    // A bearer token goes into a header as it is.
    if (credentialKind === 'bearer' && !/^[\x21-\x7e]+$/.test(value)) {
      throw davRefusal.invalidInput('secret')
    }
    return new SecretString(value)
  }

  /**
   * What an administrator may put on the allowed-origin list. The classes that
   * the relay refuses whatever the list says are refused HERE too, with a
   * sentence, so that the list never shows an entry that silently does nothing.
   */
  private assertListableOrigin(entry: unknown): void {
    if (!isExactHttpOrigin(entry)) {
      throw davRefusal.invalidInput(
        'allowedPrivateOrigins',
        'Each allowed origin must be a scheme, a host and an optional port, with nothing after it (for example http://nextcloud or https://cloud.home.lan:8443).',
      )
    }
    const host = new URL(entry).hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '')
    const neverReachable =
      DAV_OWN_SERVICE_NAMES.includes(host) ||
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      (isIP(host) !== 0 && isBlockedIp(host) && !isOperatorAllowablePrivateIp(host))
    if (neverReachable) {
      throw davRefusal.invalidInput(
        'allowedPrivateOrigins',
        `${entry} can never be allowed: it is this server itself, one of its own services, or an address that is not on a network.`,
      )
    }
  }

  private accountKey(userUuid: string, accountId: string): string {
    return `${userUuid.toLowerCase()}|${accountId}`
  }

  /** An account id as supplied by a caller is logged or counted only when it has the shape of one. */
  private loggableAccountId(accountId: unknown): string {
    return typeof accountId === 'string' && /^[0-9a-f-]{36}$/.test(accountId) ? accountId : 'invalid'
  }

  private track(key: string, signal: AbortSignal | undefined): AbortController {
    const controller = new AbortController()
    if (signal?.aborted === true) {
      controller.abort()
    } else {
      signal?.addEventListener('abort', () => controller.abort(), { once: true })
    }
    const active = this.inFlight.get(key) ?? new Set<AbortController>()
    active.add(controller)
    this.inFlight.set(key, active)
    return controller
  }

  private untrack(key: string, controller: AbortController): void {
    const active = this.inFlight.get(key)
    if (!active) {
      return
    }
    active.delete(controller)
    if (active.size === 0) {
      this.inFlight.delete(key)
    }
  }

  private abortInFlight(key: string): void {
    for (const controller of this.inFlight.get(key) ?? []) {
      controller.abort()
    }
    this.inFlight.delete(key)
  }

  private count(key: string, result: string): void {
    const existing = this.stats.get(key)
    if (existing) {
      existing.requests += 1
      existing.lastResult = result
      return
    }
    if (this.stats.size >= MAX_TRACKED_ACCOUNT_STATS) {
      this.stats.clear()
    }
    this.stats.set(key, { requests: 1, lastResult: result })
  }

  private async guardStore<R>(action: () => Promise<R>): Promise<R> {
    try {
      return await action()
    } catch (error) {
      throw this.storeRefusal(error)
    }
  }

  private storeRefusal(error: unknown): unknown {
    if (error instanceof DavBridgeRefusal) {
      return error
    }
    if (error instanceof DavAccountStoreError) {
      return davRefusal.secretStoreUnavailable(`store-${error.reason}`)
    }
    if (error instanceof DavSecretStoreUnavailableError) {
      return davRefusal.secretStoreUnavailable('no-encryption-key')
    }
    return error
  }
}

/** Refusals that mean "the remote did not give a usable answer". They count toward the breaker. */
const REMOTE_FAILURE_TAGS: ReadonlySet<string> = new Set([
  'dav-remote-unreachable',
  'dav-remote-timeout',
  'dav-tls-failed',
  'dav-host-not-found',
])
