import { injectable } from 'inversify'

import { ChatGptOAuthConfig, buildAuthorizeUrl } from './oauthConfig'
import {
  isValidAdminUuid,
  isValidAuthorizationCode,
  isValidPairingState,
  isValidSubscriptionId,
} from './pairingValidation'
import { codeChallengeS256, generateCodeVerifier, generateState } from './pkce'
import {
  ClaimedPairing,
  DEFAULT_SUBSCRIPTION_ID,
  MAX_PENDING_PAIRINGS,
  MAX_PENDING_PAIRINGS_PER_ADMIN,
  SubscriptionStatus,
  SubscriptionStatusEntry,
  SubscriptionTokenRecord,
  SubscriptionTokenStore,
} from './SubscriptionTokenStore'
import { exchangeCodeForToken, OAuthTokenRequestError, refreshAccessToken } from './tokenExchange'

/**
 * Owns the runtime lifecycle of the ChatGPT / Codex subscription credential:
 * begin/complete pairing (PKCE state lifecycle) and hand a FRESH access token to
 * the Assistant proxy on demand, transparently refreshing it when it is near
 * expiry.
 *
 * PKCE verifier/state and short exchange claims are encrypted in the same
 * durable, lock-serialized local store as subscription credentials. This
 * survives gateway restarts and coordinates processes sharing that file.
 * Separate hosts still require a genuinely shared filesystem/store.
 */

/** Fresh credential handed to the proxy for a single upstream request. */
export interface SubscriptionCredential {
  token: string
  accountId?: string
}

/** Result of starting a pairing: where to send the admin + the CSRF state. */
export interface BeginPairingResult {
  authorizeUrl: string
  state: string
}

export interface SubscriptionCredentialProviderInterface {
  /**
   * Returns a currently-valid credential for a paired subscription (the DEFAULT
   * one when no id is given), refreshing if it is within the skew window, or null
   * when unpaired / in need of repair. Callers with durable pairing configured
   * must fail closed; the legacy env bearer is not a repair fallback.
   */
  getFreshCredential(subscriptionId?: string): Promise<SubscriptionCredential | null>

  /**
   * Generates PKCE + state (tied to the admin uuid) and the authorize URL. The
   * optional subscriptionId names WHICH pairing slot the completed exchange is
   * saved under (default when omitted), enabling MULTIPLE paired subscriptions.
   */
  beginPairing(adminUuid: string, subscriptionId?: string): Promise<BeginPairingResult>

  /**
   * Verifies+consumes the state, exchanges the code, and persists the encrypted
   * credential under the pairing's target subscription id. Throws on
   * invalid/expired/replayed state or a failed exchange.
   */
  completePairing(state: string, code: string, expectedAdminUuid?: string): Promise<SubscriptionTokenRecord>

  /** Removes exactly one stored credential (DEFAULT when omitted). */
  unpair(subscriptionId?: string): Promise<void>

  /** Removes one explicitly confirmed historical id that runtime will not use. */
  unpairLegacy(subscriptionId: string): Promise<void>

  /** Explicit destructive cleanup of every pairing and pending attempt. */
  unpairAll(): Promise<void>

  /** Non-secret pairing status for one subscription (DEFAULT when omitted). */
  getStatus(subscriptionId?: string): Promise<SubscriptionStatus>

  /** Non-secret status for EVERY paired subscription. Never returns a token. */
  listStatuses(): Promise<SubscriptionStatusEntry[]>
}

/**
 * Durable encrypted, single-use PKCE lifecycle. `claim` atomically consumes
 * state into a short lease before network I/O; `commit` succeeds only if no
 * unpair/new attempt/restart-time expiry invalidated that lease.
 */
export class PairingStateStore {
  constructor(
    private readonly store: SubscriptionTokenStore,
    private readonly ttlMs: number = 10 * 60 * 1000,
    private readonly claimTtlMs: number = 2 * 60 * 1000,
    private readonly now: () => number = () => Date.now(),
    private readonly maximumTotal: number = MAX_PENDING_PAIRINGS,
    private readonly maximumPerAdmin: number = MAX_PENDING_PAIRINGS_PER_ADMIN,
  ) {
    if (
      !Number.isSafeInteger(ttlMs) ||
      ttlMs <= 0 ||
      !Number.isSafeInteger(claimTtlMs) ||
      claimTtlMs <= 0 ||
      !Number.isSafeInteger(maximumTotal) ||
      maximumTotal <= 0 ||
      maximumTotal > MAX_PENDING_PAIRINGS ||
      !Number.isSafeInteger(maximumPerAdmin) ||
      maximumPerAdmin <= 0 ||
      maximumPerAdmin > MAX_PENDING_PAIRINGS_PER_ADMIN
    ) {
      throw new Error('Pairing state TTLs and lifecycle limits must be valid positive integers.')
    }
  }

  async put(
    state: string,
    verifier: string,
    adminUuid: string,
    subscriptionId: string = DEFAULT_SUBSCRIPTION_ID,
  ): Promise<void> {
    const now = this.now()
    await this.store.putPendingPairing(
      state,
      { verifier, adminUuid, subscriptionId, expiresAt: now + this.ttlMs },
      now,
      this.maximumTotal,
      this.maximumPerAdmin,
    )
  }

  claim(state: string, expectedAdminUuid?: string): Promise<ClaimedPairing | null> {
    return this.store.claimPendingPairing(state, expectedAdminUuid, this.now(), this.claimTtlMs)
  }

  commit(claimId: string, record: SubscriptionTokenRecord): Promise<boolean> {
    return this.store.commitPairingClaim(claimId, record, this.now())
  }

  abort(claimId: string): Promise<void> {
    return this.store.abortPairingClaim(claimId)
  }
}

// Refresh the access token when it is within this window of expiring (or already
// expired). One minute of skew tolerates clock drift and request latency.
const REFRESH_SKEW_MS = 60 * 1000
const MAX_TRANSIENT_BACKOFF_MS = 15 * 60 * 1000

@injectable()
export class SubscriptionCredentialProvider implements SubscriptionCredentialProviderInterface {
  private readonly refreshes = new Map<string, Promise<SubscriptionCredential | null>>()
  private readonly pairingState: PairingStateStore

  constructor(
    private readonly store: SubscriptionTokenStore,
    private readonly config: ChatGptOAuthConfig,
    pairingState?: PairingStateStore,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.pairingState = pairingState ?? new PairingStateStore(store, 10 * 60 * 1000, 2 * 60 * 1000, now)
  }

  async beginPairing(adminUuid: string, subscriptionId: string = DEFAULT_SUBSCRIPTION_ID): Promise<BeginPairingResult> {
    if (!isValidAdminUuid(adminUuid)) {
      throw new Error('A valid authenticated administrator UUID is required to begin pairing.')
    }
    if (!isValidSubscriptionId(subscriptionId)) {
      throw new Error('Subscription id must use 1-128 letters, numbers, dots, underscores, or hyphens.')
    }
    const verifier = generateCodeVerifier()
    const state = generateState()
    const authorizeUrl = buildAuthorizeUrl(this.config, {
      state,
      codeChallenge: codeChallengeS256(verifier),
    })
    await this.pairingState.put(state, verifier, adminUuid, subscriptionId)
    return { authorizeUrl, state }
  }

  async completePairing(state: string, code: string, expectedAdminUuid?: string): Promise<SubscriptionTokenRecord> {
    if (
      !isValidPairingState(state) ||
      !isValidAuthorizationCode(code) ||
      (expectedAdminUuid !== undefined && !isValidAdminUuid(expectedAdminUuid))
    ) {
      throw new Error('Invalid, expired, or already-used pairing state.')
    }

    const pending = await this.pairingState.claim(state, expectedAdminUuid)
    if (!pending) {
      throw new Error('Invalid, expired, superseded, or already-used pairing state.')
    }

    let exchanged
    try {
      exchanged = await exchangeCodeForToken(this.config, code, pending.verifier, this.now)
    } catch {
      await this.pairingState.abort(pending.claimId).catch(() => undefined)
      // Never expose an upstream body/fetch error: it may echo the code/verifier.
      throw new Error(
        'The OAuth provider could not complete this one-time exchange. Generate a new authorization link.',
      )
    }
    const record: SubscriptionTokenRecord = {
      accessToken: exchanged.accessToken,
      refreshToken: exchanged.refreshToken,
      idToken: exchanged.idToken,
      expiresAt: exchanged.expiresAt,
      accountId: exchanged.accountId,
      accountLabel: exchanged.accountId,
      pairedAt: this.now(),
      needsRepair: false,
    }
    if (!(await this.pairingState.commit(pending.claimId, record))) {
      throw new Error('This pairing attempt expired, was revoked, or was superseded before it could be saved.')
    }
    return record
  }

  async unpair(subscriptionId: string = DEFAULT_SUBSCRIPTION_ID): Promise<void> {
    if (!isValidSubscriptionId(subscriptionId)) {
      throw new Error('A valid subscription id is required to unpair.')
    }
    await this.store.removeRecord(subscriptionId)
  }

  async unpairLegacy(subscriptionId: string): Promise<void> {
    await this.store.removeLegacyRecord(subscriptionId)
  }

  async unpairAll(): Promise<void> {
    await this.store.clear()
  }

  getStatus(subscriptionId: string = DEFAULT_SUBSCRIPTION_ID): Promise<SubscriptionStatus> {
    return this.store.getStatus(subscriptionId)
  }

  listStatuses(): Promise<SubscriptionStatusEntry[]> {
    return this.store.listStatuses()
  }

  async getFreshCredential(subscriptionId: string = DEFAULT_SUBSCRIPTION_ID): Promise<SubscriptionCredential | null> {
    if (!isValidSubscriptionId(subscriptionId)) {
      return null
    }
    const existingRefresh = this.refreshes.get(subscriptionId)
    if (existingRefresh) {
      return existingRefresh
    }

    let record: SubscriptionTokenRecord | null
    try {
      record = await this.store.loadRecord(subscriptionId)
    } catch {
      // Undecryptable store — treat as unusable; status surfaces needsRepair.
      return null
    }
    if (!record || record.needsRepair) {
      return null
    }

    const now = this.now()
    if (record.expiresAt - now > REFRESH_SKEW_MS) {
      return { token: record.accessToken, accountId: record.accountId }
    }
    if (record.refreshRetryAt && record.refreshRetryAt > now) {
      return null
    }

    const refreshAlreadyStarted = this.refreshes.get(subscriptionId)
    if (refreshAlreadyStarted) {
      return refreshAlreadyStarted
    }
    const refresh = this.refreshCredential(subscriptionId)
    this.refreshes.set(subscriptionId, refresh)
    try {
      return await refresh
    } finally {
      if (this.refreshes.get(subscriptionId) === refresh) {
        this.refreshes.delete(subscriptionId)
      }
    }
  }

  private async refreshCredential(subscriptionId: string): Promise<SubscriptionCredential | null> {
    // Re-read after acquiring the per-id singleflight lane. Another process may
    // already have rotated or re-paired the slot.
    let record: SubscriptionTokenRecord | null
    try {
      record = await this.store.loadRecord(subscriptionId)
    } catch {
      return null
    }
    if (!record || record.needsRepair) {
      return null
    }
    const now = this.now()
    if (record.expiresAt - now > REFRESH_SKEW_MS) {
      return { token: record.accessToken, accountId: record.accountId }
    }
    if (record.refreshRetryAt && record.refreshRetryAt > now) {
      return null
    }

    if (!record.refreshToken) {
      await this.markNeedsRepair(subscriptionId, record, 'refresh-token-missing')
      return null
    }

    try {
      const refreshed = await refreshAccessToken(this.config, record.refreshToken, this.now)
      const rotated: SubscriptionTokenRecord = {
        ...record,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? record.refreshToken,
        idToken: refreshed.idToken ?? record.idToken,
        expiresAt: refreshed.expiresAt,
        accountId: refreshed.accountId ?? record.accountId,
        needsRepair: false,
        needsRepairReason: undefined,
        refreshRetryAt: undefined,
        refreshFailureCode: undefined,
        refreshFailureCount: undefined,
      }
      if (await this.store.replaceRecordAfterSuccessfulRefresh(subscriptionId, record, rotated)) {
        return { token: rotated.accessToken, accountId: rotated.accountId }
      }
      return this.latestUsableCredential(subscriptionId)
    } catch (error) {
      if (this.isPermanentRefreshFailure(error)) {
        await this.markNeedsRepair(subscriptionId, record, 'refresh-token-rejected')
        return this.latestUsableCredential(subscriptionId)
      }
      await this.recordTransientFailure(subscriptionId, record, error)
      return this.latestUsableCredential(subscriptionId)
    }
  }

  private isPermanentRefreshFailure(error: unknown): boolean {
    if (!(error instanceof OAuthTokenRequestError)) {
      return false
    }
    return (
      error.oauthCode === 'invalid_grant' ||
      error.oauthCode === 'invalid_token' ||
      error.status === 401 ||
      error.status === 403
    )
  }

  private transientFailureCode(error: unknown): NonNullable<SubscriptionTokenRecord['refreshFailureCode']> {
    if (!(error instanceof OAuthTokenRequestError) || error.status === 0) {
      return 'network'
    }
    if (error.status === 429) {
      return 'rate-limited'
    }
    if (error.status >= 500) {
      return 'provider-unavailable'
    }
    return 'provider-error'
  }

  private async recordTransientFailure(
    subscriptionId: string,
    record: SubscriptionTokenRecord,
    error: unknown,
  ): Promise<void> {
    const failureCount = Math.min((record.refreshFailureCount ?? 0) + 1, 32)
    const failureCode = this.transientFailureCode(error)
    const baseDelay =
      failureCode === 'rate-limited'
        ? 60_000
        : failureCode === 'provider-error'
          ? 30_000
          : failureCode === 'provider-unavailable'
            ? 15_000
            : 5_000
    const exponentialDelay = Math.min(baseDelay * 2 ** Math.min(failureCount - 1, 8), MAX_TRANSIENT_BACKOFF_MS)
    const providerDelay = error instanceof OAuthTokenRequestError ? (error.retryAfterMs ?? 0) : 0
    const replacement: SubscriptionTokenRecord = {
      ...record,
      needsRepair: false,
      needsRepairReason: undefined,
      refreshRetryAt: this.now() + Math.min(Math.max(exponentialDelay, providerDelay), MAX_TRANSIENT_BACKOFF_MS),
      refreshFailureCode: failureCode,
      refreshFailureCount: failureCount,
    }
    await this.store.replaceRecordIfUnchanged(subscriptionId, record, replacement).catch(() => false)
  }

  /** Best-effort CAS: never overwrite a newer rotated/re-paired credential. */
  private async markNeedsRepair(
    subscriptionId: string,
    record: SubscriptionTokenRecord,
    reason: NonNullable<SubscriptionTokenRecord['needsRepairReason']>,
  ): Promise<void> {
    try {
      await this.store.replaceRecordIfUnchanged(subscriptionId, record, {
        ...record,
        needsRepair: true,
        needsRepairReason: reason,
        refreshRetryAt: undefined,
        refreshFailureCode: undefined,
        refreshFailureCount: undefined,
      })
    } catch {
      // Persisting the flag is best-effort; never let it mask the refresh failure.
    }
  }

  private async latestUsableCredential(subscriptionId: string): Promise<SubscriptionCredential | null> {
    try {
      const latest = await this.store.loadRecord(subscriptionId)
      if (!latest || latest.needsRepair || latest.expiresAt - this.now() <= REFRESH_SKEW_MS) {
        return null
      }
      return { token: latest.accessToken, accountId: latest.accountId }
    } catch {
      return null
    }
  }
}
