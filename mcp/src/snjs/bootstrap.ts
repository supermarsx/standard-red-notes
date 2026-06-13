import snjs from '@standardnotes/snjs'
import { SNWebCrypto } from '@standardnotes/sncrypto-web'
import { NodeDevice } from './NodeDevice.js'

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
  isSignedIn(): boolean
  sync(): Promise<void>
  /** Begin continuous background sync (idempotent). Call after sign-in. */
  startSyncLoop(): void
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

  // Respond to any challenge snjs raises during launch / protected operations.
  // For a headless bridge the only credentials we can supply are the account
  // password and an optional TOTP code from the environment.
  await app.prepareForLaunch({
    receiveChallenge: (challenge: any) => {
      if (process.env.MCP_DEBUG_CHALLENGES) {
        // eslint-disable-next-line no-console
        console.error('[snjs challenge]', challenge.reason, JSON.stringify((challenge.prompts ?? []).map((p: any) => p.title)))
      }
      const values = (challenge.prompts ?? []).map((prompt: any) => {
        const title = String(prompt.title ?? '').toLowerCase()
        if (title.includes('authentication') || title.includes('code') || title.includes('2fa')) {
          return CreateChallengeValue(prompt, mfaCode ?? '')
        }
        return CreateChallengeValue(prompt, password ?? '')
      })
      void app.submitValuesForChallenge(challenge, values)
    },
  })

  await app.launch(true)

  const syncIntervalMs = options.syncIntervalMs ?? 10_000
  let syncTimer: NodeJS.Timeout | undefined
  let syncing = false

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
          .catch(() => {})
          .finally(() => {
            syncing = false
          })
      }, syncIntervalMs)
      // Don't keep the process alive solely for the heartbeat.
      syncTimer.unref?.()
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

    isSignedIn(): boolean {
      return Boolean(app.hasAccount?.() ?? app.getUser?.())
    },

    async sync(): Promise<void> {
      await app.sync.sync({ sourceDescription: 'mcp-bridge' })
    },

    async deinit(): Promise<void> {
      if (syncTimer) {
        clearInterval(syncTimer)
        syncTimer = undefined
      }
      await app.prepareForDeinit?.()
      app.deinit?.(1)
    },
  }

  return result
}
