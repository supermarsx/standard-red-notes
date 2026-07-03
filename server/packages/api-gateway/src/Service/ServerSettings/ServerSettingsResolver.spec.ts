import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

import { ServerSettingsResolver } from './ServerSettingsResolver'
import { ServerSettingsStore } from './ServerSettingsStore'

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
})
