import { injectable } from 'inversify'

import { ChatGptOAuthConfig, buildAuthorizeUrl } from './oauthConfig'
import { codeChallengeS256, generateCodeVerifier, generateState } from './pkce'
import {
  DEFAULT_SUBSCRIPTION_ID,
  SubscriptionStatus,
  SubscriptionStatusEntry,
  SubscriptionTokenRecord,
  SubscriptionTokenStore,
} from './SubscriptionTokenStore'
import { exchangeCodeForToken, refreshAccessToken } from './tokenExchange'

/**
 * Owns the runtime lifecycle of the ChatGPT / Codex subscription credential:
 * begin/complete pairing (PKCE state lifecycle) and hand a FRESH access token to
 * the Assistant proxy on demand, transparently refreshing it when it is near
 * expiry.
 *
 * The PKCE verifier + state live in an in-memory TTL map (PairingStateStore).
 * That is correct for the single-process home-server this ships for. A
 * horizontally-scaled / multi-instance gateway MUST replace it with a shared
 * store (e.g. Redis) — the browser can be redirected back to a different
 * instance than the one that issued the state. Documented, not implemented here.
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
   * when unpaired / in need of repair (caller falls back to the env token or
   * reports "re-pair needed").
   */
  getFreshCredential(subscriptionId?: string): Promise<SubscriptionCredential | null>

  /**
   * Generates PKCE + state (tied to the admin uuid) and the authorize URL. The
   * optional subscriptionId names WHICH pairing slot the completed exchange is
   * saved under (default when omitted), enabling MULTIPLE paired subscriptions.
   */
  beginPairing(adminUuid: string, subscriptionId?: string): BeginPairingResult

  /**
   * Verifies+consumes the state, exchanges the code, and persists the encrypted
   * credential under the pairing's target subscription id. Throws on
   * invalid/expired/replayed state or a failed exchange.
   */
  completePairing(state: string, code: string): Promise<SubscriptionTokenRecord>

  /** Removes a stored credential (a specific id, or ALL when no id is given). */
  unpair(subscriptionId?: string): Promise<void>

  /** Non-secret pairing status for one subscription (DEFAULT when omitted). */
  getStatus(subscriptionId?: string): Promise<SubscriptionStatus>

  /** Non-secret status for EVERY paired subscription. Never returns a token. */
  listStatuses(): Promise<SubscriptionStatusEntry[]>
}

interface PendingPairing {
  verifier: string
  adminUuid: string
  subscriptionId: string
  expiresAt: number
}

/**
 * In-memory, single-use, TTL-bounded store of pending PKCE pairings keyed by the
 * OAuth `state`. See the multi-instance caveat in the file header.
 */
export class PairingStateStore {
  private readonly pending = new Map<string, PendingPairing>()

  constructor(private readonly ttlMs: number = 10 * 60 * 1000) {}

  put(state: string, verifier: string, adminUuid: string, subscriptionId: string = DEFAULT_SUBSCRIPTION_ID): void {
    this.prune()
    this.pending.set(state, { verifier, adminUuid, subscriptionId, expiresAt: Date.now() + this.ttlMs })
  }

  /** Returns and REMOVES the pending pairing if present and unexpired. */
  consume(state: string): PendingPairing | null {
    const entry = this.pending.get(state)
    if (!entry) {
      return null
    }
    this.pending.delete(state)
    if (entry.expiresAt < Date.now()) {
      return null
    }
    return entry
  }

  private prune(): void {
    const now = Date.now()
    for (const [state, entry] of this.pending) {
      if (entry.expiresAt < now) {
        this.pending.delete(state)
      }
    }
  }
}

// Refresh the access token when it is within this window of expiring (or already
// expired). One minute of skew tolerates clock drift and request latency.
const REFRESH_SKEW_MS = 60 * 1000

@injectable()
export class SubscriptionCredentialProvider implements SubscriptionCredentialProviderInterface {
  constructor(
    private readonly store: SubscriptionTokenStore,
    private readonly config: ChatGptOAuthConfig,
    private readonly pairingState: PairingStateStore = new PairingStateStore(),
  ) {}

  beginPairing(adminUuid: string, subscriptionId: string = DEFAULT_SUBSCRIPTION_ID): BeginPairingResult {
    const verifier = generateCodeVerifier()
    const state = generateState()
    this.pairingState.put(state, verifier, adminUuid, subscriptionId)
    const authorizeUrl = buildAuthorizeUrl(this.config, {
      state,
      codeChallenge: codeChallengeS256(verifier),
    })
    return { authorizeUrl, state }
  }

  async completePairing(state: string, code: string): Promise<SubscriptionTokenRecord> {
    const pending = this.pairingState.consume(state)
    if (!pending) {
      throw new Error('Invalid, expired, or already-used pairing state.')
    }

    const exchanged = await exchangeCodeForToken(this.config, code, pending.verifier)
    const record: SubscriptionTokenRecord = {
      accessToken: exchanged.accessToken,
      refreshToken: exchanged.refreshToken,
      idToken: exchanged.idToken,
      expiresAt: exchanged.expiresAt,
      accountId: exchanged.accountId,
      accountLabel: exchanged.accountId,
      pairedAt: Date.now(),
      needsRepair: false,
    }
    await this.store.saveRecord(pending.subscriptionId, record)
    return record
  }

  async unpair(subscriptionId?: string): Promise<void> {
    if (subscriptionId === undefined) {
      // No-arg: clear ALL pairings (back-compat with the single-pairing flow).
      await this.store.clear()
      return
    }
    await this.store.removeRecord(subscriptionId)
  }

  getStatus(subscriptionId: string = DEFAULT_SUBSCRIPTION_ID): Promise<SubscriptionStatus> {
    return this.store.getStatus(subscriptionId)
  }

  listStatuses(): Promise<SubscriptionStatusEntry[]> {
    return this.store.listStatuses()
  }

  async getFreshCredential(subscriptionId: string = DEFAULT_SUBSCRIPTION_ID): Promise<SubscriptionCredential | null> {
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

    if (record.expiresAt - Date.now() > REFRESH_SKEW_MS) {
      return { token: record.accessToken, accountId: record.accountId }
    }

    // Near or past expiry — attempt a refresh.
    if (!record.refreshToken) {
      await this.markNeedsRepair(subscriptionId, record)
      return null
    }

    try {
      const refreshed = await refreshAccessToken(this.config, record.refreshToken)
      const rotated: SubscriptionTokenRecord = {
        ...record,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? record.refreshToken,
        idToken: refreshed.idToken ?? record.idToken,
        expiresAt: refreshed.expiresAt,
        accountId: refreshed.accountId ?? record.accountId,
        needsRepair: false,
      }
      await this.store.saveRecord(subscriptionId, rotated)
      return { token: rotated.accessToken, accountId: rotated.accountId }
    } catch {
      await this.markNeedsRepair(subscriptionId, record)
      return null
    }
  }

  /** Best-effort: mark a stored record as needing a re-pair. */
  private async markNeedsRepair(subscriptionId: string, record: SubscriptionTokenRecord): Promise<void> {
    try {
      await this.store.saveRecord(subscriptionId, { ...record, needsRepair: true })
    } catch {
      // Persisting the flag is best-effort; never let it mask the refresh failure.
    }
  }
}
