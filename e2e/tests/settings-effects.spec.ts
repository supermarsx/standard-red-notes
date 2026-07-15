import crypto from 'node:crypto'
import { test, expect } from '@playwright/test'
import {
  apiCall,
  clearRateLimitStateQuiet,
  freshUser,
  freshUserAtDomain,
  getServerSettings,
  registerUser,
  setAdminFeatureFlag,
  setServerSettings,
  signInUser,
  srnAdmin,
  srnAdminQuiet,
} from '../helpers/admin'

const OCR_SERVER_ALLOWED = 'OCR_SERVER_ALLOWED'
const WORKFLOWS_ENABLED = 'WORKFLOWS_ENABLED'

const oversizedImageBase64 = Buffer.alloc(2048, 1).toString('base64')

function registrationBody(user: { email: string; password: string }): Record<string, unknown> {
  return {
    api: '20200115',
    email: user.email,
    password: user.password,
    version: '004',
    pw_nonce: crypto.randomBytes(16).toString('hex'),
    identifier: user.email,
    origination: 'registration',
    created: `${Date.now()}`,
  }
}

async function tryRegister(user: { email: string; password: string }) {
  return apiCall('POST', '/v1/users', { body: registrationBody(user) })
}

async function clearRuntimeSettings(token: string): Promise<void> {
  await setServerSettings(token, {
    registration: {
      defaultRole: null,
      domainMode: null,
      domainList: null,
      emailConfirmationEnabled: null,
      emailConfirmationGating: null,
      emailConfirmationBaseUrl: null,
      emailConfirmationSubject: null,
      emailConfirmationBody: null,
      signupsPerIpMax: null,
      signupsPerIpWindowHours: null,
      signupsPerWeekMax: null,
      signupsPerDeviceMax: null,
      signupsPerDeviceWindowHours: null,
      inviteOnly: null,
      approvalRequired: null,
      maxTotalAccounts: null,
      signupsOpenAt: null,
      signupsCloseAt: null,
      invitesPerUser: null,
    },
    ocr: {
      serverEnabled: null,
      defaultLanguage: null,
      maxPages: null,
      maxImageBytes: null,
      clientEnabled: null,
      clientDefaultLanguage: null,
    },
    workflows: {
      enabled: null,
      n8nUrl: null,
      uiBasePath: null,
      uiTokenTtlSeconds: null,
    },
    security: {
      rateLimit: {
        enabled: null,
        windowSeconds: null,
        loginMax: null,
        registrationMax: null,
        userWindowSeconds: null,
        userMax: null,
        adaptiveEscalation: null,
      },
      proofOfWork: {
        registerEnabled: null,
        registerDifficulty: null,
        signInEnabled: null,
        signInMode: null,
        signInDifficulty: null,
        signInAdaptiveThreshold: null,
      },
    },
    logging: { level: null },
  })
}

test.setTimeout(4 * 60_000)

test.describe('@chromium settings effects', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'settings behavior gate runs on chromium only')

  test.beforeEach(() => {
    clearRateLimitStateQuiet()
  })

  test.afterEach(() => {
    clearRateLimitStateQuiet()
  })

  test('API: server settings alter registration, OCR, workflows, and rate-limit views', async () => {
    const adminUser = freshUser('settings-admin')
    const featureUser = freshUser('settings-feature')

    await registerUser(adminUser)
    const featureReg = await registerUser(featureUser)

    srnAdmin('grant-admin', adminUser.email)
    let featureSession = featureReg.session
    const adminSession = await signInUser(adminUser)
    const adminToken = adminSession.access_token

    try {
      await clearRuntimeSettings(adminToken)

      const allowedDomain = `settings-${Date.now()}.allowed.test`
      const blockedDomain = `settings-${Date.now()}.blocked.test`
      const policyView = await setServerSettings(adminToken, {
        registration: {
          domainMode: 'allowlist',
          domainList: [`@${allowedDomain}`, allowedDomain.toUpperCase()],
        },
      })

      expect(policyView.settings.registration.domainMode).toBe('allowlist')
      expect(policyView.settings.registration.domainList).toEqual([allowedDomain])
      expect(policyView.sources['registration.domainMode']).toBe('persisted')
      expect(policyView.sources['registration.domainList']).toBe('persisted')

      const blocked = await tryRegister(freshUserAtDomain('settings-blocked', blockedDomain))
      expect(blocked.status).toBe(400)
      expect(blocked.data?.error?.message).toBe('Registration is not allowed for this email domain.')

      const allowed = await tryRegister(freshUserAtDomain('settings-allowed', allowedDomain))
      expect(allowed.status).toBe(200)
      expect(allowed.data?.session?.access_token).toEqual(expect.any(String))

      const ocrView = await setServerSettings(adminToken, {
        ocr: {
          serverEnabled: true,
          defaultLanguage: 'eng+deu',
          maxPages: 1,
          maxImageBytes: 1024,
          clientEnabled: true,
          clientDefaultLanguage: 'deu',
        },
      })
      expect(ocrView.settings.ocr).toMatchObject({
        serverEnabled: true,
        defaultLanguage: 'eng+deu',
        maxPages: 1,
        maxImageBytes: 1024,
        clientEnabled: true,
        clientDefaultLanguage: 'deu',
      })

      const ocrConfigDenied = await apiCall('GET', '/v1/ocr/config', {
        token: featureSession.access_token,
      })
      expect(ocrConfigDenied.status).toBe(200)
      expect(ocrConfigDenied.data).toMatchObject({
        serverOcrEnabled: true,
        allowed: false,
        available: false,
        defaultLanguage: 'eng+deu',
        clientOcrEnabled: true,
        clientDefaultLanguage: 'deu',
      })

      const ocrDenied = await apiCall('POST', '/v1/ocr/recognize', {
        token: featureSession.access_token,
        body: { pages: [{ pageNumber: 1, imageBase64: 'AA==' }] },
      })
      expect(ocrDenied.status).toBe(403)
      expect(ocrDenied.data?.error?.tag).toBe('ocr-server-not-allowed')

      await setAdminFeatureFlag(adminToken, featureReg.uuid, OCR_SERVER_ALLOWED, 'true')
      featureSession = await signInUser(featureUser)

      const ocrConfigAllowed = await apiCall('GET', '/v1/ocr/config', {
        token: featureSession.access_token,
      })
      expect(ocrConfigAllowed.status).toBe(200)
      expect(ocrConfigAllowed.data).toMatchObject({
        serverOcrEnabled: true,
        allowed: true,
        available: true,
      })

      const ocrTooLarge = await apiCall('POST', '/v1/ocr/recognize', {
        token: featureSession.access_token,
        body: { pages: [{ pageNumber: 1, imageBase64: oversizedImageBase64 }] },
      })
      expect(ocrTooLarge.status).toBe(413)
      expect(ocrTooLarge.data?.error?.message).toContain('too large')

      await setServerSettings(adminToken, { workflows: { enabled: false } })
      const workflowServerDisabled = await apiCall('POST', '/v1/workflows/pair', { token: featureSession.access_token })
      expect(workflowServerDisabled.status).toBe(403)
      expect(workflowServerDisabled.data?.error?.tag).toBe('workflows-disabled')

      const workflowsView = await setServerSettings(adminToken, {
        workflows: {
          enabled: true,
          n8nUrl: 'http://n8n:5678',
          uiTokenTtlSeconds: 120,
        },
      })
      expect(workflowsView.settings.workflows).toMatchObject({
        enabled: true,
        n8nUrl: 'http://n8n:5678',
        uiTokenTtlSeconds: 120,
      })
      const workflowsEditorUrl = `${String(workflowsView.settings.workflows.uiBasePath).replace(/\/+$/, '')}/`

      const workflowUserDisabled = await apiCall('POST', '/v1/workflows/pair', {
        token: featureSession.access_token,
      })
      expect(workflowUserDisabled.status).toBe(403)
      expect(workflowUserDisabled.data?.error?.tag).toBe('workflows-not-allowed')

      await setAdminFeatureFlag(adminToken, featureReg.uuid, WORKFLOWS_ENABLED, 'true')
      featureSession = await signInUser(featureUser)

      const workflowStatus = await apiCall('GET', '/v1/workflows/status', {
        token: featureSession.access_token,
      })
      expect(workflowStatus.status).toBe(200)
      expect(workflowStatus.data).toMatchObject({
        enabled: true,
        paired: false,
        editorUrl: null,
      })

      const workflowPair = await apiCall('POST', '/v1/workflows/pair', {
        token: featureSession.access_token,
      })
      expect(workflowPair.status).toBe(200)
      expect(workflowPair.data).toMatchObject({
        paired: true,
        editorUrl: workflowsEditorUrl,
      })

      const workflowPairedStatus = await apiCall('GET', '/v1/workflows/status', { token: featureSession.access_token })
      expect(workflowPairedStatus.status).toBe(200)
      expect(workflowPairedStatus.data).toMatchObject({
        enabled: true,
        paired: true,
        editorUrl: workflowsEditorUrl,
      })

      const workflowUnpair = await apiCall('POST', '/v1/workflows/unpair', {
        token: featureSession.access_token,
      })
      expect(workflowUnpair.status).toBe(200)
      expect(workflowUnpair.data).toMatchObject({ paired: false })

      const rateLimitView = await setServerSettings(adminToken, {
        security: {
          rateLimit: {
            enabled: true,
            windowSeconds: 2,
            registrationMax: 2,
            userMax: 3,
          },
        },
      })
      expect(rateLimitView.settings.security.rateLimit).toMatchObject({
        enabled: true,
        windowSeconds: 2,
        registrationMax: 2,
        userMax: 3,
      })

      const antiAbuse = await apiCall('GET', '/v1/admin/anti-abuse', {
        token: adminToken,
      })
      expect(antiAbuse.status).toBe(200)
      expect(antiAbuse.data.config).toMatchObject({
        enabled: true,
        windowSeconds: 2,
        registrationMax: 2,
        userMax: 3,
      })
    } finally {
      await clearRuntimeSettings(adminToken).catch(() => undefined)
      await setAdminFeatureFlag(adminToken, featureReg.uuid, OCR_SERVER_ALLOWED, null).catch(() => undefined)
      await setAdminFeatureFlag(adminToken, featureReg.uuid, WORKFLOWS_ENABLED, null).catch(() => undefined)
      srnAdminQuiet('revoke-admin', adminUser.email)
    }
  })

  test('API: invalid setting patches are rejected and do not overwrite persisted values', async () => {
    const adminUser = freshUser('settings-edge-admin')
    await registerUser(adminUser)

    srnAdmin('grant-admin', adminUser.email)
    const adminSession = await signInUser(adminUser)
    const adminToken = adminSession.access_token

    try {
      await clearRuntimeSettings(adminToken)

      await setServerSettings(adminToken, {
        logging: { level: 'debug' },
        security: { rateLimit: { loginMax: 7 } },
        ocr: { defaultLanguage: 'eng' },
      })

      const invalidPatches: Array<{
        body: Record<string, unknown>
        message: string
      }> = [
        {
          body: { registration: { defaultRole: 'ADMIN_USER' } },
          message: 'registration.defaultRole',
        },
        {
          body: { registration: { signupsOpenAt: 'not-a-date' } },
          message: 'registration.signupsOpenAt',
        },
        {
          body: { ocr: { defaultLanguage: 'not a lang' } },
          message: 'ocr.defaultLanguage',
        },
        { body: { ocr: { maxImageBytes: 100 } }, message: 'ocr.maxImageBytes' },
        {
          body: { workflows: { n8nUrl: 'ftp://nope' } },
          message: 'workflows.n8nUrl',
        },
        {
          body: { workflows: { uiTokenTtlSeconds: 59 } },
          message: 'workflows.uiTokenTtlSeconds',
        },
        {
          body: { security: { rateLimit: { windowSeconds: 0 } } },
          message: 'security.rateLimit.windowSeconds',
        },
        { body: { logging: { level: 'trace' } }, message: 'logging.level' },
      ]

      for (const { body, message } of invalidPatches) {
        const response = await apiCall('PUT', '/v1/admin/server-settings', {
          token: adminToken,
          body,
        })
        expect(response.status, `${message} should be rejected`).toBe(400)
        expect(response.data?.error?.message).toContain(message)
      }

      const after = await getServerSettings(adminToken)
      expect(after.settings.logging.level).toBe('debug')
      expect(after.sources['logging.level']).toBe('persisted')
      expect(after.settings.security.rateLimit.loginMax).toBe(7)
      expect(after.sources['security.rateLimit.loginMax']).toBe('persisted')
      expect(after.settings.ocr.defaultLanguage).toBe('eng')
      expect(after.sources['ocr.defaultLanguage']).toBe('persisted')
    } finally {
      await clearRuntimeSettings(adminToken).catch(() => undefined)
      srnAdminQuiet('revoke-admin', adminUser.email)
    }
  })
})
