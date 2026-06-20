import snjs from '@standardnotes/snjs'
import { SNWebCrypto } from '@standardnotes/sncrypto-web'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { NodeDevice } from './NodeDevice.js'
import { configureCookieJar, configureSharedServerKey } from './polyfill.js'

const { SNApplication, SNLog, Platform, ApiVersion, CreateChallengeValue } = snjs as unknown as Record<string, any>

// snjs requires these sinks to be set before an Application is constructed.
if (SNLog) {
  SNLog.onLog = (..._args: unknown[]) => {}
  SNLog.onError = (...args: unknown[]) => {
    if (process.env.SRN_DEBUG) {
      // eslint-disable-next-line no-console
      console.error('[snjs]', ...args)
    }
  }
}

/** No-op alerts: a headless CLI has no UI to confirm against. */
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
  /** TOTP/MFA code supplied to sign-in challenges if the server requests it. */
  mfaCode?: string
  /** Account password, supplied to protection/re-auth challenges. */
  password?: string
  /** Optional shared-server-key gate header value. */
  serverKey?: string
}

export interface HeadlessApp {
  readonly app: any
  register(email: string, password: string): Promise<void>
  signIn(email: string, password: string, mfaCode?: string): Promise<void>
  isSignedIn(): boolean
  getUser(): { uuid?: string; email?: string } | undefined
  sync(): Promise<void>
  signOut(): Promise<void>
  deinit(): Promise<void>
}

export async function bootstrapHeadlessApp(options: BootstrapOptions): Promise<HeadlessApp> {
  // Make gated requests to this server carry the X-Shared-Server-Key header.
  configureSharedServerKey(options.serverUrl, options.serverKey)
  // Persist the cookie session across one-shot CLI invocations (the SN server
  // uses cookie-based sessions, which Node's fetch does not persist on its own).
  try {
    mkdirSync(options.dataDir, { recursive: true })
  } catch {
    // NodeDevice also ensures the dir; ignore races/permission quirks here.
  }
  configureCookieJar(path.join(options.dataDir, 'cookies.json'))

  const device = new NodeDevice(options.dataDir)
  const crypto = new SNWebCrypto()
  const identifier = options.identifier ?? 'srn-client'

  const app = new SNApplication({
    environment: device.environment,
    platform: Platform.LinuxWeb,
    deviceInterface: device,
    crypto,
    alertService: new NodeAlertService(),
    identifier,
    defaultHost: options.serverUrl,
    appVersion: '1.0.0-srn-client',
    apiVersion: ApiVersion.v1,
  })

  let password = options.password
  const mfaCode = options.mfaCode
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

  // Respond to any challenge snjs raises during launch / sign-in. The credentials
  // we can supply are the account password, an optional static TOTP code, and —
  // for self-hosted magic-link 2FA — the one-time code the server surfaces in the
  // challenge heading.
  await app.prepareForLaunch({
    receiveChallenge: (challenge: any) => {
      const heading = String(challenge.heading ?? '')
      const codeRuns = heading.match(/\b\d{4,8}\b/g)
      const onScreenCode =
        heading.match(/code[^0-9]*?(\d{4,8})/i)?.[1] ?? (codeRuns ? codeRuns[codeRuns.length - 1] : undefined)
      const code = mfaCode ?? dynamicMfaCode ?? onScreenCode ?? ''
      const values = (challenge.prompts ?? []).map((prompt: any) => {
        const title = String(prompt.title ?? '').toLowerCase()
        const text = `${title} ${String(prompt.placeholder ?? '').toLowerCase()}`
        if (/authentication|code|2fa|mfa|two-factor|verification/.test(title)) {
          return CreateChallengeValue(prompt, code)
        }
        if (/password|account/.test(text)) {
          return CreateChallengeValue(prompt, password ?? '')
        }
        // Never auto-submit the password into an unrecognized prompt.
        return CreateChallengeValue(prompt, '')
      })
      void app.submitValuesForChallenge(challenge, values)
    },
  })

  await app.launch(true)

  const result: HeadlessApp = {
    app,

    async register(email: string, pw: string): Promise<void> {
      password = pw
      const response = await app.register(email, pw, '', false, true)
      if (response?.error) {
        throw new Error(`register failed: ${response.error.message ?? JSON.stringify(response.error)}`)
      }
    },

    async signIn(email: string, pw: string, codeArg?: string): Promise<void> {
      password = pw
      // Pre-fetch a magic-link one-time code (if no static code given) so a
      // magic-link 2FA challenge can be satisfied headlessly. Harmless if the
      // account has no MFA — the code goes unused.
      dynamicMfaCode = (codeArg ?? mfaCode) ? undefined : await fetchMagicLinkCode(email)
      const response = await app.signIn(email, pw, false, false, true, true, codeArg)
      const error = response?.data?.error ?? response?.error
      if (error) {
        const message = error.message ?? JSON.stringify(error)
        if (/mfa|two.?factor|totp/i.test(message)) {
          throw new Error(`sign-in requires an MFA code; pass --mfa <code>. (${message})`)
        }
        throw new Error(`sign-in failed: ${message}`)
      }
    },

    isSignedIn(): boolean {
      return Boolean(app.hasAccount?.() ?? app.getUser?.() ?? app.sessions?.isSignedIn?.())
    },

    getUser(): { uuid?: string; email?: string } | undefined {
      const user = app.getUser?.()
      if (!user) {
        return undefined
      }
      return { uuid: user.uuid, email: user.email }
    },

    async sync(): Promise<void> {
      await app.sync.sync({ sourceDescription: 'srn-client' })
    },

    async signOut(): Promise<void> {
      await app.user?.signOut?.()
    },

    async deinit(): Promise<void> {
      await app.prepareForDeinit?.()
      app.deinit?.(1)
      await device.flushWrites().catch(() => {})
    },
  }

  return result
}
