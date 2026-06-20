import snjs from '@standardnotes/snjs'
import { SNWebCrypto } from '@standardnotes/sncrypto-web'
import { NodeDevice } from './NodeDevice.js'
import { signInWithMcpToken, type McpTokenSignInResult } from './tokenAuth.js'

const {
  SNApplication,
  SNLog,
  Platform,
  ApiVersion,
  CreateChallengeValue,
} = snjs as unknown as Record<string, any>

// snjs requires these sinks to be set before an Application is constructed.
if (SNLog) {
  SNLog.onLog = (..._args: unknown[]) => {}
  SNLog.onError = (...args: unknown[]) => {
    // eslint-disable-next-line no-console
    console.error('[snjs]', ...args)
  }
}

/** No-op alerts: a headless bridge has no UI to confirm against. */
class NodeAlertService {
  async confirm(): Promise<boolean> {
    return true
  }
  async confirmV2(): Promise<boolean> {
    return true
  }
  async alert(): Promise<void> {}
  async alertV2(): Promise<void> {}
  async showErrorAlert(): Promise<void> {}
  blockingDialog(): () => void {
    return () => {}
  }
}

export interface BootstrapOptions {
  serverUrl: string
  dataDir: string
  identifier?: string
  /** TOTP/MFA code, supplied to challenges if the server requests it. */
  mfaCode?: string
  /** Account password, supplied to protection/re-auth challenges. */
  password?: string
  /**
   * Continuous background sync interval (ms). When > 0 the bridge keeps syncing
   * on a timer so it picks up collaborators' changes (e.g. in a shared vault)
   * without waiting for a tool call. 0 disables the loop. Default 10000.
   */
  syncIntervalMs?: number
}

export interface HeadlessApp {
  readonly app: any
  register(email: string, password: string): Promise<void>
  signIn(email: string, password: string, mfaCode?: string): Promise<void>
  /**
   * Standard Red Notes: sign in with an MCP scoped token (no email/password/MFA).
   * Establishes a session and injects the account's items keys so notes decrypt.
   */
  signInWithToken(fullToken: string): Promise<McpTokenSignInResult>
  isSignedIn(): boolean
  sync(): Promise<void>
  /** Begin continuous background sync (idempotent). Call after sign-in. */
  startSyncLoop(): void
  /** How many MFA/2FA challenges snjs has raised (e.g. during sign-in). */
  getMfaChallengeCount(): number
  /** Background-sync health, to detect a silently-failing ("zombie") bridge. */
  getSyncHealth(): { consecutiveFailures: number; lastError?: string }
  deinit(): Promise<void>
}

export async function bootstrapHeadlessApp(options: BootstrapOptions): Promise<HeadlessApp> {
  const device = new NodeDevice(options.dataDir)
  const crypto = new SNWebCrypto()
  const identifier = options.identifier ?? 'standard-red-notes-mcp'

  const app = new SNApplication({
    environment: device.environment,
    platform: Platform.LinuxWeb,
    deviceInterface: device,
    crypto,
    alertService: new NodeAlertService(),
    identifier,
    defaultHost: options.serverUrl,
    appVersion: '1.0.0-mcp',
    apiVersion: ApiVersion.v1,
  })

  let password = options.password
  const mfaCode = options.mfaCode
  let mfaChallengeCount = 0
  // For self-hosted magic-link 2FA the one-time code is fetched on demand (the
  // server returns it on-screen when SMTP isn't configured) and supplied to the
  // sign-in MFA challenge.
  let dynamicMfaCode: string | undefined

  async function fetchMagicLinkCode(email: string): Promise<string | undefined> {
    try {
      const res = await fetch(`${options.serverUrl.replace(/\/$/, '')}/v1/mfa/magic-link/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const body = (await res.json().catch(() => ({}))) as { code?: string; data?: { code?: string } }
      return body.code ?? body.data?.code
    } catch {
      return undefined
    }
  }

  // Respond to any challenge snjs raises during launch / protected operations.
  // For a headless bridge the credentials we can supply are the account password,
  // an optional static TOTP code, and — for self-hosted magic-link 2FA — the
  // one-time code the server surfaces in the challenge heading ("...verification
  // code is: 123456"), which a headless agent reads on-screen.
  await app.prepareForLaunch({
    receiveChallenge: (challenge: any) => {
      if (process.env.MCP_DEBUG_CHALLENGES) {
        // eslint-disable-next-line no-console
        console.error('[snjs challenge]', challenge.reason, challenge.heading, JSON.stringify((challenge.prompts ?? []).map((p: any) => p.title)))
      }
      // Extract the on-screen magic-link code from the challenge heading. Prefer
      // the digits right after a "code" label; otherwise take the LAST 4-8 digit
      // run — never the first, since a localized heading may begin with a year or
      // count that would otherwise be mistaken for the code.
      const heading = String(challenge.heading ?? '')
      const codeRuns = heading.match(/\b\d{4,8}\b/g)
      const onScreenCode =
        heading.match(/code[^0-9]*?(\d{4,8})/i)?.[1] ?? (codeRuns ? codeRuns[codeRuns.length - 1] : undefined)
      const code = mfaCode ?? dynamicMfaCode ?? onScreenCode ?? ''
      const values = (challenge.prompts ?? []).map((prompt: any) => {
        const title = String(prompt.title ?? '').toLowerCase()
        const text = `${title} ${String(prompt.placeholder ?? '').toLowerCase()}`
        if (/authentication|code|2fa|mfa|two-factor|verification/.test(title)) {
          mfaChallengeCount += 1
          return CreateChallengeValue(prompt, code)
        }
        if (/password|account/.test(text)) {
          return CreateChallengeValue(prompt, password ?? '')
        }
        // Unrecognized prompt (local passcode, PIN, biometric, a future type):
        // NEVER auto-submit the account password into a field we don't
        // recognize. Submit empty so the challenge fails safely instead of
        // leaking the password into an unexpected validator.
        if (process.env.MCP_DEBUG_CHALLENGES) {
          // eslint-disable-next-line no-console
          console.error('[snjs challenge] unrecognized prompt; submitting empty:', prompt.title)
        }
        return CreateChallengeValue(prompt, '')
      })
      void app.submitValuesForChallenge(challenge, values)
    },
  })

  await app.launch(true)

  const syncIntervalMs = options.syncIntervalMs ?? 10_000
  let syncTimer: NodeJS.Timeout | undefined
  let syncing = false
  // Track sync health so the status tool can surface a "zombie" bridge (session
  // expired -> the loop keeps failing silently while isSignedIn() stays true).
  let consecutiveSyncFailures = 0
  let lastSyncError: string | undefined

  const result: HeadlessApp = {
    app,

    startSyncLoop(): void {
      if (syncTimer || syncIntervalMs <= 0) {
        return
      }
      syncTimer = setInterval(() => {
        // Skip if a sync is already in flight or we aren't signed in yet.
        if (syncing || !result.isSignedIn()) {
          return
        }
        syncing = true
        void app.sync
          .sync({ sourceDescription: 'mcp-bridge-loop' })
          .then(() => {
            consecutiveSyncFailures = 0
            lastSyncError = undefined
          })
          .catch((e: unknown) => {
            consecutiveSyncFailures += 1
            lastSyncError = e instanceof Error ? e.message : String(e)
          })
          .finally(() => {
            syncing = false
          })
      }, syncIntervalMs)
      // Don't keep the process alive solely for the heartbeat.
      syncTimer.unref?.()
    },

    getSyncHealth(): { consecutiveFailures: number; lastError?: string } {
      return { consecutiveFailures: consecutiveSyncFailures, lastError: lastSyncError }
    },

    async register(email: string, pw: string): Promise<void> {
      password = pw
      const response = await app.register(email, pw, '', false, true)
      if (response?.error) {
        throw new Error(`register failed: ${response.error.message ?? JSON.stringify(response.error)}`)
      }
    },

    async signIn(email: string, pw: string, code?: string): Promise<void> {
      password = pw
      // If no static TOTP code was given, pre-fetch a magic-link one-time code so
      // the bridge can satisfy a magic-link 2FA challenge headlessly. Harmless if
      // the account has no MFA (the code simply goes unused).
      dynamicMfaCode = (code ?? mfaCode) ? undefined : await fetchMagicLinkCode(email)
      const response = await app.signIn(email, pw, false, false, true, true, code)
      const error = response?.data?.error ?? response?.error
      if (error) {
        const message = error.message ?? JSON.stringify(error)
        if (/mfa|two.?factor|totp/i.test(message)) {
          throw new Error(`sign-in requires an MFA code; set STANDARD_RED_NOTES_MFA_CODE. (${message})`)
        }
        throw new Error(`sign-in failed: ${message}`)
      }
    },

    async signInWithToken(fullToken: string): Promise<McpTokenSignInResult> {
      const res = await signInWithMcpToken(app, options.serverUrl, fullToken)
      consecutiveSyncFailures = 0
      lastSyncError = undefined
      return res
    },

    isSignedIn(): boolean {
      // The token path establishes a session without app.hasAccount() (no root
      // key), so also treat an authenticated session layer as signed in.
      return Boolean(app.hasAccount?.() ?? app.getUser?.() ?? app.sessions?.isSignedIn?.())
    },

    getMfaChallengeCount(): number {
      return mfaChallengeCount
    },

    async sync(): Promise<void> {
      try {
        await app.sync.sync({ sourceDescription: 'mcp-bridge' })
        consecutiveSyncFailures = 0
        lastSyncError = undefined
      } catch (e) {
        consecutiveSyncFailures += 1
        lastSyncError = e instanceof Error ? e.message : String(e)
        throw e
      }
    },

    async deinit(): Promise<void> {
      if (syncTimer) {
        clearInterval(syncTimer)
        syncTimer = undefined
      }
      await app.prepareForDeinit?.()
      app.deinit?.(1)
      // Ensure any storage/keychain writes queued during teardown actually land
      // before the process exits.
      await device.flushWrites().catch(() => {})
    },
  }

  return result
}
