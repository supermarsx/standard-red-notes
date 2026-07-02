import { sign, verify } from 'jsonwebtoken'

import { WorkflowsPairing, WorkflowsPairingStore } from './WorkflowsPairingStore'

/**
 * Standard Red Notes: WORKFLOWS (n8n-backed automation) gateway service.
 *
 * Owns everything the /v1/workflows controller and the /workflows-ui editor
 * proxy need:
 *   - the operator master switch (WORKFLOWS_ENABLED env),
 *   - per-user pairing state (JSON file store — the gateway has no database),
 *   - the short-lived, signed UI-ACCESS token that lets the sandboxed editor
 *     iframe pass the proxy gate.
 *
 * WHY A DEDICATED UI-ACCESS COOKIE: the embedded n8n editor is loaded in an
 * iframe, whose subresource requests carry cookies but CANNOT carry the
 * Authorization header the normal session-validation channel requires (cookie-
 * based SRN sessions still need the header's `<version>:<privateIdentifier>`
 * half). So the session-authed /v1/workflows endpoints — which DO re-validate
 * the session + entitlement server-side — mint a short-lived HS256 JWT scoped to
 * purpose 'workflows-ui' and set it as an HttpOnly cookie whose Path is the
 * proxy base path. The proxy verifies that token AND re-checks the master
 * switch AND the pairing record on every request. Revoking = unpair (the proxy
 * fails closed immediately); the token also self-expires.
 */

export const WORKFLOWS_UI_COOKIE_NAME = 'srn_workflows_ui'

const UI_TOKEN_PURPOSE = 'workflows-ui'

interface UiAccessTokenClaims {
  sub?: string
  purpose?: string
}

export interface WorkflowsServiceConfig {
  /** Operator master switch (WORKFLOWS_ENABLED env). Off => feature invisible. */
  enabled: boolean
  /** Internal n8n base URL on the docker network (WORKFLOWS_N8N_URL). */
  n8nUrl: string
  /** Same-origin proxy base path the editor iframe loads (WORKFLOWS_UI_BASE_PATH). */
  uiBasePath: string
  /** HS256 secret for the UI-access token. Reuses AUTH_JWT_SECRET (already held). */
  jwtSecret: string
  /** Mirror of COOKIE_SECURE so the UI cookie matches the deployment's cookies. */
  cookieSecure: boolean
  /** UI-access token lifetime in seconds. */
  uiTokenTtlSeconds: number
}

export class WorkflowsService {
  constructor(
    private readonly config: WorkflowsServiceConfig,
    private readonly pairingStore: WorkflowsPairingStore,
  ) {}

  isEnabled(): boolean {
    return this.config.enabled
  }

  get n8nUrl(): string {
    return this.config.n8nUrl
  }

  get uiBasePath(): string {
    return this.config.uiBasePath
  }

  get cookieSecure(): boolean {
    return this.config.cookieSecure
  }

  get uiTokenTtlSeconds(): number {
    return this.config.uiTokenTtlSeconds
  }

  /** The same-origin editor path handed to the client (`editorUrl`). */
  editorUrl(): string {
    return `${this.config.uiBasePath.replace(/\/+$/, '')}/`
  }

  async isPaired(userUuid: string): Promise<boolean> {
    return this.pairingStore.isPaired(userUuid)
  }

  async pair(userUuid: string): Promise<WorkflowsPairing> {
    return this.pairingStore.pair(userUuid)
  }

  async unpair(userUuid: string): Promise<boolean> {
    return this.pairingStore.unpair(userUuid)
  }

  /**
   * Mint the short-lived UI-access token for the editor proxy cookie. Only ever
   * called AFTER the caller passed the session + entitlement (+ pairing) checks.
   */
  mintUiAccessToken(userUuid: string): string {
    return sign({ purpose: UI_TOKEN_PURPOSE }, this.config.jwtSecret, {
      algorithm: 'HS256',
      subject: userUuid,
      expiresIn: this.config.uiTokenTtlSeconds,
    })
  }

  /**
   * Verify a UI-access token. Returns the user uuid on success, null otherwise.
   * Fails closed for any missing/expired/foreign-purpose token.
   */
  verifyUiAccessToken(token: string | undefined): string | null {
    if (!token) {
      return null
    }
    try {
      const claims = verify(token, this.config.jwtSecret, { algorithms: ['HS256'] }) as UiAccessTokenClaims
      if (claims.purpose !== UI_TOKEN_PURPOSE || typeof claims.sub !== 'string' || claims.sub.length === 0) {
        return null
      }
      return claims.sub
    } catch {
      return null
    }
  }
}
