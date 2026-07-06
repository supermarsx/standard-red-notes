import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
  DEFAULT_EMAIL_CONFIRMATION_BODY,
  DEFAULT_EMAIL_CONFIRMATION_SUBJECT,
  ServerSettingsResolver,
} from './ServerSettingsResolver'
import { ServerSettingsStore } from './ServerSettingsStore'

/** Registration email-confirmation defaults, spread into expectations (DRY). */
const confirmationDefaults = {
  emailConfirmationEnabled: false,
  emailConfirmationGating: 'block_signin' as const,
  emailConfirmationSubject: DEFAULT_EMAIL_CONFIRMATION_SUBJECT,
  emailConfirmationBody: DEFAULT_EMAIL_CONFIRMATION_BODY,
  emailConfirmationBaseUrl: '',
}

describe('ServerSettingsStore + ServerSettingsResolver', () => {
  let dir: string
  let filePath: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-server-settings-'))
    filePath = path.join(dir, 'server-settings.json')
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const makeResolver = (envBaseline = {}) =>
    new ServerSettingsResolver(new ServerSettingsStore(filePath), {
      assistant: {},
      ...envBaseline,
    })

  describe('store', () => {
    it('reads an empty document when the file does not exist yet', async () => {
      expect(await new ServerSettingsStore(filePath).read()).toEqual({})
    })

    it('persists values, clears them on null, and prunes empty sections', async () => {
      const store = new ServerSettingsStore(filePath)

      await store.update({ ai: { anthropicApiKey: 'sk-test', dailyRequestLimit: 5 }, updateCheck: { url: 'https://u.example.com' } })
      expect(await store.read()).toEqual({
        ai: { anthropicApiKey: 'sk-test', dailyRequestLimit: 5 },
        updateCheck: { url: 'https://u.example.com' },
      })

      // undefined leaves untouched; null clears; pruned when the section empties.
      await store.update({ ai: { anthropicApiKey: null }, updateCheck: { url: null } })
      expect(await store.read()).toEqual({ ai: { dailyRequestLimit: 5 } })

      await store.update({ ai: { dailyRequestLimit: null } })
      expect(await store.read()).toEqual({})
    })
  })

  describe('registration policy', () => {
    it('defaults to CORE_USER / off / [] when nothing is persisted or in env', async () => {
      const resolver = makeResolver()

      expect(await resolver.resolveRegistrationConfig()).toEqual({
        defaultRole: 'CORE_USER',
        domainMode: 'off',
        domainList: [],
        ...confirmationDefaults,
      })
    })

    it('falls back to the env baseline, normalizing the domain list', async () => {
      const resolver = makeResolver({
        registrationDefaultRole: 'PRO_USER',
        registrationDomainMode: 'allowlist',
        registrationDomains: ['Env.com', 'env.com', '@other.com'],
      })

      expect(await resolver.resolveRegistrationConfig()).toEqual({
        defaultRole: 'PRO_USER',
        domainMode: 'allowlist',
        domainList: ['env.com', 'other.com'],
        ...confirmationDefaults,
      })
    })

    it('lets persisted admin values WIN over env and coerces an invalid role to CORE_USER', async () => {
      await new ServerSettingsStore(filePath).update({
        registration: { defaultRole: 'VAULTS_USER', domainMode: 'blocklist', domainList: ['persisted.com'] },
      })
      const resolver = makeResolver({ registrationDefaultRole: 'PRO_USER', registrationDomainMode: 'allowlist' })

      expect(await resolver.resolveRegistrationConfig()).toEqual({
        defaultRole: 'VAULTS_USER',
        domainMode: 'blocklist',
        domainList: ['persisted.com'],
        ...confirmationDefaults,
      })

      // An admin role must never survive resolution as a default.
      await new ServerSettingsStore(filePath).update({ registration: { defaultRole: 'ADMIN_USER' as string } })
      expect((await resolver.resolveRegistrationConfig()).defaultRole).toEqual('CORE_USER')
    })

    it('resolves email confirmation: persisted enable + gating win over env/default', async () => {
      await new ServerSettingsStore(filePath).update({
        registration: {
          emailConfirmationEnabled: true,
          emailConfirmationGating: 'warn',
          emailConfirmationBaseUrl: 'https://notes.example.com',
        },
      })
      const resolver = makeResolver()
      const config = await resolver.resolveRegistrationConfig()

      expect(config.emailConfirmationEnabled).toBe(true)
      expect(config.emailConfirmationGating).toBe('warn')
      expect(config.emailConfirmationBaseUrl).toBe('https://notes.example.com')
      // Untouched templates fall through to the defaults.
      expect(config.emailConfirmationSubject).toBe(DEFAULT_EMAIL_CONFIRMATION_SUBJECT)
    })

    it('reports the registration source map and assignable roles in the view', async () => {
      await new ServerSettingsStore(filePath).update({ registration: { domainMode: 'allowlist' } })
      const resolver = makeResolver({ registrationDefaultRole: 'PRO_USER' })
      const view = await resolver.view()

      expect(view.settings.registration.assignableRoles).toEqual(['CORE_USER', 'PRO_USER', 'VAULTS_USER'])
      expect(view.sources['registration.domainMode']).toEqual('persisted')
      expect(view.sources['registration.defaultRole']).toEqual('env')
      expect(view.sources['registration.domainList']).toEqual('default')
    })
  })

  describe('resolver precedence: persisted → env → default', () => {
    it('falls back to env values when nothing is persisted', async () => {
      const resolver = makeResolver({
        assistant: { anthropicApiKey: 'env-key', openaiBaseURL: 'https://env.openai.example.com' },
        assistantDailyRequestLimit: 10,
        updateCheckUrl: 'https://env.update.example.com',
        nextcloudBackupsEnabled: true,
      })

      expect((await resolver.resolveAssistantConfig()).anthropicApiKey).toEqual('env-key')
      expect(await resolver.resolveAssistantDailyRequestLimit()).toEqual(10)
      expect(await resolver.resolveUpdateCheckUrl()).toEqual('https://env.update.example.com')
      expect(await resolver.resolveNextcloudBackupsEnabled()).toBe(true)
    })

    it('lets persisted admin values WIN over env', async () => {
      const resolver = makeResolver({
        assistant: { anthropicApiKey: 'env-key', ollamaUrl: 'http://env-ollama:11434' },
        assistantDailyRequestLimit: 10,
        updateCheckUrl: 'https://env.update.example.com',
        nextcloudBackupsEnabled: true,
      })

      await resolver.applyPatch({
        ai: { anthropicApiKey: 'persisted-key', ollamaUrl: 'http://persisted-ollama:11434', dailyRequestLimit: 3 },
        updateCheck: { url: 'https://persisted.update.example.com' },
        nextcloudBackups: { enabled: false },
      })

      const config = await resolver.resolveAssistantConfig()
      expect(config.anthropicApiKey).toEqual('persisted-key')
      expect(config.ollamaUrl).toEqual('http://persisted-ollama:11434')
      expect(await resolver.resolveAssistantDailyRequestLimit()).toEqual(3)
      expect(await resolver.resolveUpdateCheckUrl()).toEqual('https://persisted.update.example.com')
      expect(await resolver.resolveNextcloudBackupsEnabled()).toBe(false)
    })

    it('clearing a persisted value (null) falls back to env, then to defaults', async () => {
      const resolver = makeResolver({
        assistant: { anthropicApiKey: 'env-key' },
        assistantDailyRequestLimit: 10,
      })

      await resolver.applyPatch({ ai: { anthropicApiKey: 'persisted-key', dailyRequestLimit: 3 } })
      await resolver.applyPatch({ ai: { anthropicApiKey: null, dailyRequestLimit: null } })

      expect((await resolver.resolveAssistantConfig()).anthropicApiKey).toEqual('env-key')
      expect(await resolver.resolveAssistantDailyRequestLimit()).toEqual(10)

      // No env baseline at all => hardcoded defaults.
      const bare = makeResolver()
      expect(await bare.resolveAssistantDailyRequestLimit()).toEqual(0)
      expect(await bare.resolveUpdateCheckUrl()).toBeUndefined()
      expect(await bare.resolveNextcloudBackupsEnabled()).toBe(false)
    })

    it('changes take effect on the NEXT resolve call (no restart, no caching)', async () => {
      const resolver = makeResolver({ assistant: {} })

      expect((await resolver.resolveAssistantConfig()).anthropicApiKey).toBeUndefined()
      await resolver.applyPatch({ ai: { anthropicApiKey: 'now-set' } })
      expect((await resolver.resolveAssistantConfig()).anthropicApiKey).toEqual('now-set')
    })
  })

  describe('view (the masked admin payload)', () => {
    it('NEVER returns key material — only configured booleans — and reports per-setting sources', async () => {
      const resolver = makeResolver({
        assistant: { openaiApiKey: 'env-openai-key' },
        nextcloudBackupsEnabled: false,
      })
      await resolver.applyPatch({
        ai: { anthropicApiKey: 'persisted-secret', dailyRequestLimit: 7 },
        nextcloudBackups: { enabled: true },
      })

      const view = await resolver.view()

      expect(JSON.stringify(view)).not.toContain('persisted-secret')
      expect(JSON.stringify(view)).not.toContain('env-openai-key')
      expect(view.settings.ai).toMatchObject({
        anthropicConfigured: true,
        openaiConfigured: true,
        dailyRequestLimit: 7,
      })
      expect(view.settings.nextcloudBackups).toEqual({ enabled: true })
      expect(view.sources).toMatchObject({
        'ai.anthropicApiKey': 'persisted',
        'ai.openaiApiKey': 'env',
        'ai.openaiBaseUrl': 'default',
        'ai.ollamaUrl': 'default',
        'ai.dailyRequestLimit': 'persisted',
        'updateCheck.url': 'default',
        'nextcloudBackups.enabled': 'persisted',
      })
    })

    it('degrades to the env baseline when the settings file is corrupt', async () => {
      await fs.writeFile(filePath, 'not-json{', 'utf8')
      const resolver = makeResolver({ assistant: { anthropicApiKey: 'env-key' }, nextcloudBackupsEnabled: true })

      expect((await resolver.resolveAssistantConfig()).anthropicApiKey).toEqual('env-key')
      expect((await resolver.view()).settings.nextcloudBackups.enabled).toBe(true)
    })
  })

  describe('named profiles (multiple)', () => {
    it('back-compat: maps legacy single-provider env into synthesized default profiles', async () => {
      const resolver = makeResolver({ assistant: { anthropicApiKey: 'env-key', ollamaUrl: 'http://localhost:11434' } })

      const { profiles, defaultProfileId } = await resolver.resolveAssistantProfiles()
      expect(profiles.map((p) => p.provider)).toEqual(['anthropic', 'ollama'])
      expect(defaultProfileId).toBe(profiles[0].id)

      // resolveActiveProfile selects the default when none is requested.
      expect((await resolver.resolveActiveProfile())?.provider).toBe('anthropic')
    })

    it('explicit persisted profiles win over legacy mapping and are selectable by id', async () => {
      const resolver = makeResolver({ assistant: { anthropicApiKey: 'env-key' } })
      await resolver.applyPatch({
        ai: {
          profiles: [
            { id: 'a', name: 'Claude', provider: 'anthropic', enabled: true, apiKey: 'sk-a' },
            { id: 'b', name: 'Router', provider: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', enabled: true, apiKey: 'sk-b' },
          ],
          defaultProfileId: 'b',
        },
      })

      const { profiles, defaultProfileId } = await resolver.resolveAssistantProfiles()
      expect(profiles).toHaveLength(2)
      expect(defaultProfileId).toBe('b')
      expect((await resolver.resolveActiveProfile('a'))?.name).toBe('Claude')
      expect((await resolver.resolveActiveProfile())?.id).toBe('b')
    })

    it('masks profile secrets in the view (keyConfigured only, never the key)', async () => {
      const resolver = makeResolver()
      await resolver.applyPatch({
        ai: {
          profiles: [{ id: 'a', name: 'Claude', provider: 'anthropic', enabled: true, apiKey: 'super-secret-key' }],
          defaultProfileId: 'a',
        },
      })

      const view = await resolver.view()
      expect(JSON.stringify(view)).not.toContain('super-secret-key')
      expect(view.settings.ai.profiles).toEqual([
        { id: 'a', name: 'Claude', provider: 'anthropic', baseUrl: null, model: null, enabled: true, keyConfigured: true },
      ])
      expect(view.settings.ai.defaultProfileId).toBe('a')
      expect(view.sources['ai.profiles']).toBe('persisted')
    })

    it('getPersistedAiProfiles returns the raw persisted set (with keys) for key preservation', async () => {
      const resolver = makeResolver()
      await resolver.applyPatch({
        ai: { profiles: [{ id: 'a', name: 'Claude', provider: 'anthropic', enabled: true, apiKey: 'sk-a' }] },
      })
      const raw = await resolver.getPersistedAiProfiles()
      expect(raw?.[0].apiKey).toBe('sk-a')
    })
  })

  // Standard Red Notes: decoupled backend profiles + assignments.
  describe('backend profiles + assignments', () => {
    it('back-compat: synthesizes backend profiles from embedded profiles when none are persisted', async () => {
      const resolver = makeResolver({ assistant: { anthropicApiKey: 'env-key' } })
      const backends = await resolver.resolveBackendProfiles()
      expect(backends).toHaveLength(1)
      expect(backends[0]).toMatchObject({ type: 'api-key', provider: 'anthropic' })
    })

    it('an assistant profile referencing a backend resolves with the backend credential', async () => {
      const resolver = makeResolver()
      await resolver.applyPatch({
        ai: {
          backendProfiles: [
            { id: 'be1', name: 'Anthropic', type: 'api-key', provider: 'anthropic', apiKey: 'sk-backend' },
          ],
          profiles: [{ id: 'p1', name: 'Assistant', provider: 'openai-compatible', enabled: true, backendProfileId: 'be1' }],
          defaultProfileId: 'p1',
        },
      })

      const active = await resolver.resolveActiveProfile()
      expect(active?.provider).toBe('anthropic')
      expect(active?.apiKey).toBe('sk-backend')
    })

    it('masks backend-profile secrets in the view and reports a source', async () => {
      const resolver = makeResolver()
      await resolver.applyPatch({
        ai: {
          backendProfiles: [{ id: 'be1', name: 'A', type: 'api-key', provider: 'anthropic', apiKey: 'super-backend-secret' }],
        },
      })
      const view = await resolver.view()
      expect(JSON.stringify(view)).not.toContain('super-backend-secret')
      expect(view.settings.ai.backendProfiles[0]).toMatchObject({ id: 'be1', type: 'api-key', keyConfigured: true })
      expect(view.sources['ai.backendProfiles']).toBe('persisted')
    })

    it('resolves the effective profile for a principal (USER > ROLE > default)', async () => {
      const resolver = makeResolver()
      await resolver.applyPatch({
        ai: {
          profiles: [
            { id: 'user-p', name: 'U', provider: 'anthropic', enabled: true, apiKey: 'a' },
            { id: 'role-p', name: 'R', provider: 'anthropic', enabled: true, apiKey: 'b' },
            { id: 'default-p', name: 'D', provider: 'anthropic', enabled: true, apiKey: 'c' },
          ],
          defaultProfileId: 'default-p',
          assignments: { users: { 'uuid-1': 'user-p' }, roles: { CORE_USER: 'role-p' } },
        },
      })

      expect((await resolver.resolveActiveProfile(undefined, { userIdentifiers: ['uuid-1'], roleNames: ['CORE_USER'] }))?.id).toBe('user-p')
      expect((await resolver.resolveActiveProfile(undefined, { userIdentifiers: ['uuid-x'], roleNames: ['CORE_USER'] }))?.id).toBe('role-p')
      expect((await resolver.resolveActiveProfile(undefined, { userIdentifiers: ['uuid-x'], roleNames: ['PRO_USER'] }))?.id).toBe('default-p')
      // An explicit client selection still wins over the assignment default.
      expect((await resolver.resolveActiveProfile('role-p', { userIdentifiers: ['uuid-1'], roleNames: [] }))?.id).toBe('role-p')
    })
  })

  describe('proof-of-work (security.proofOfWork)', () => {
    it('falls back to hardcoded defaults when nothing is persisted or in env', async () => {
      const resolver = makeResolver()

      expect(await resolver.resolveProofOfWorkConfig()).toEqual({
        registerEnabled: false,
        registerDifficulty: 12,
        signInEnabled: false,
        signInMode: 'adaptive',
        signInDifficulty: 16,
        signInAdaptiveThreshold: 3,
      })
    })

    it('uses the env baseline over the defaults', async () => {
      const resolver = makeResolver({
        proofOfWorkRegisterEnabled: false,
        proofOfWorkRegisterDifficulty: 8,
        proofOfWorkSignInMode: 'always',
        proofOfWorkSignInDifficulty: 20,
        proofOfWorkSignInAdaptiveThreshold: 5,
      })

      const config = await resolver.resolveProofOfWorkConfig()
      expect(config.registerEnabled).toBe(false)
      expect(config.registerDifficulty).toBe(8)
      expect(config.signInMode).toBe('always')
      expect(config.signInDifficulty).toBe(20)
      expect(config.signInAdaptiveThreshold).toBe(5)
      // Unset env falls through to the default (disabled).
      expect(config.signInEnabled).toBe(false)
    })

    it('lets persisted admin values WIN over env', async () => {
      const resolver = makeResolver({
        proofOfWorkRegisterDifficulty: 8,
        proofOfWorkSignInMode: 'always',
      })
      await resolver.applyPatch({
        security: { proofOfWork: { registerDifficulty: 14, signInMode: 'adaptive', signInAdaptiveThreshold: 2 } },
      })

      const config = await resolver.resolveProofOfWorkConfig()
      expect(config.registerDifficulty).toBe(14)
      expect(config.signInMode).toBe('adaptive')
      expect(config.signInAdaptiveThreshold).toBe(2)
    })

    it('persists, prunes empty sections on null, and clears back to env/default', async () => {
      const store = new ServerSettingsStore(filePath)

      await store.update({ security: { proofOfWork: { registerEnabled: true, signInDifficulty: 18 } } })
      expect(await store.read()).toEqual({
        security: { proofOfWork: { registerEnabled: true, signInDifficulty: 18 } },
      })

      await store.update({ security: { proofOfWork: { registerEnabled: null } } })
      expect(await store.read()).toEqual({ security: { proofOfWork: { signInDifficulty: 18 } } })

      // Clearing the last key prunes proofOfWork AND the empty security section.
      await store.update({ security: { proofOfWork: { signInDifficulty: null } } })
      expect(await store.read()).toEqual({})
    })

    it('reports the resolved config + per-setting sources in the view', async () => {
      const resolver = makeResolver({ proofOfWorkRegisterDifficulty: 8 })
      await resolver.applyPatch({ security: { proofOfWork: { signInDifficulty: 22 } } })

      const view = await resolver.view()
      expect(view.settings.security.proofOfWork).toMatchObject({
        registerDifficulty: 8, // env
        signInDifficulty: 22, // persisted
        signInMode: 'adaptive', // default
      })
      expect(view.sources).toMatchObject({
        'security.proofOfWork.registerDifficulty': 'env',
        'security.proofOfWork.signInDifficulty': 'persisted',
        'security.proofOfWork.registerEnabled': 'default',
        'security.proofOfWork.signInMode': 'default',
      })
    })
  })
})
