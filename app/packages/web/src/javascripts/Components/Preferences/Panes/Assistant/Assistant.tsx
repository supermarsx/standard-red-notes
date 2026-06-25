import { useCallback, useEffect, useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { isErrorResponse, PrefKey } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import PreferencesPane from '../../PreferencesComponents/PreferencesPane'
import PreferencesGroup from '../../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../../PreferencesComponents/PreferencesSegment'
import { Title, Subtitle, Text } from '../../PreferencesComponents/Content'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Switch from '@/Components/Switch/Switch'
import Button from '@/Components/Button/Button'
import {
  createCustomSelectionAction,
  getSelectionActions,
  SelectionAction,
  SelectionActionId,
  serializeSelectionActions,
} from '@/Assistant/selectionActions'
import AgentRuntimeSettings from '@/Components/Assistant/AgentRuntimeSettings'
import NarrationSettings from '@/Components/Narration/NarrationSettings'
import SttModelSettings from '@/Components/AudioRecorder/SttModelSettings'
import { loadDictationSettings, saveDictationSettings, DictationSettings } from '@/Assistant/dictationSettings'
import { getSttAvailability, getSpeechRecognitionCtor } from '@/Assistant/transcription'
import {
  loadContextualSearchSettings,
  saveContextualSearchSettings,
} from '@/Assistant/contextualSearchSettings'
import { loadDeepResearchSettings, saveDeepResearchSettings } from '@/Assistant/deepResearchSettings'
import { loadResearchModeSettings, saveResearchModeSettings } from '@/Assistant/researchModeSettings'
import { getSelectionAIAvailability } from '@/Assistant/selectionActions'
import {
  createPersonaProfile,
  loadPersonaProfiles,
  loadPersonaSettings,
  PersonaProfile,
  savePersonaProfiles,
  savePersonaSettings,
  PERSONA_PRESETS,
  PERSONA_MAX_LENGTH,
  PROFILE_NAME_MAX_LENGTH,
} from '@/Assistant/personaSettings'
import {
  clampMaxTokens,
  clampTemperature,
  clampTopP,
  loadSamplingSettings,
  MAX_TOKENS_MAX,
  SamplingSettings,
  saveSamplingSettings,
  TEMPERATURE_MAX,
  TEMPERATURE_MIN,
  TOP_P_MAX,
  TOP_P_MIN,
} from '@/Assistant/samplingSettings'

type AssistantConfig = {
  providers: string[]
  defaultProvider: string
  defaultModel: string
}

type ConnectionMode = 'direct' | 'proxy'

// Raw server-setting name for the search-index default. A string literal (not
// SettingName.NAMES) because the published @standardnotes/domain-core bundle the
// web client consumes does not carry Standard Red Notes' added setting names; it
// must match the server's SettingName.NAMES value exactly. Same pattern as the
// Conflicts pane / Admin.tsx.
const SEARCH_INDEX_ENABLED_SETTING = 'SEARCH_INDEX_ENABLED'

const PRESETS: { label: string; baseURL: string }[] = [
  { label: 'LM Studio', baseURL: 'http://localhost:1234/v1' },
  { label: 'Ollama', baseURL: 'http://localhost:11434/v1' },
  { label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1' },
  { label: 'OpenAI', baseURL: 'https://api.openai.com/v1' },
]

const Assistant = ({ application }: { application: WebApplication }) => {
  const [config, setConfig] = useState<AssistantConfig | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [connectionMode, setConnectionMode] = useState<ConnectionMode>(() =>
    application.getPreference(PrefKey.AssistantConnectionMode, 'direct'),
  )
  const [provider, setProvider] = useState(() => application.getPreference(PrefKey.AssistantProvider, ''))
  const [baseURL, setBaseURL] = useState(() => application.getPreference(PrefKey.AssistantBaseUrl, ''))
  const [apiKey, setApiKey] = useState(() => application.getPreference(PrefKey.AssistantApiKey, ''))
  const [authMode, setAuthMode] = useState<'api-key' | 'subscription'>(() =>
    application.getPreference(PrefKey.AssistantAuthMode, 'api-key'),
  )
  const [subscriptionToken, setSubscriptionToken] = useState(() =>
    application.getPreference(PrefKey.AssistantSubscriptionToken, ''),
  )
  const [extraHeaders, setExtraHeaders] = useState(() => application.getPreference(PrefKey.AssistantExtraHeaders, ''))
  const [model, setModel] = useState(() => application.getPreference(PrefKey.AssistantModel, ''))
  const [confirmBeforeWrite, setConfirmBeforeWrite] = useState(() =>
    application.getPreference(PrefKey.AssistantConfirmBeforeWrite, true),
  )
  const [aiSearch, setAiSearch] = useState(() => application.getPreference(PrefKey.AiPoweredSearchEnabled, false))

  // AI-assisted CONTEXTUAL search (provider re-rank of top candidates). Web-local
  // (localStorage), DEFAULT OFF. Distinct from the local-only "AI-powered search"
  // toggle above, which never sends anything off-device.
  const [contextualSearch, setContextualSearch] = useState(() => loadContextualSearchSettings().enabled)

  // AI DEEP RESEARCH over the user's own notes (bounded multi-step loop). Web-local
  // (localStorage), DEFAULT OFF. Substantially more data exposure than a single
  // query, so it is gated and clearly warned.
  const [deepResearch, setDeepResearch] = useState(() => loadDeepResearchSettings().enabled)

  // AI RESEARCH MODE: write a structured research note on a topic from the model's
  // own knowledge (no web access). Web-local (localStorage), DEFAULT OFF.
  const [researchMode, setResearchMode] = useState(() => loadResearchModeSettings().enabled)

  const [searchIndexEnabled, setSearchIndexEnabled] = useState(() =>
    application.getPreference(PrefKey.SearchIndexEnabled, true),
  )
  const [searchCacheSize, setSearchCacheSize] = useState(() =>
    application.getPreference(PrefKey.SearchQueryCacheSize, 50),
  )
  const [searchMinQueryLength, setSearchMinQueryLength] = useState(() =>
    application.getPreference(PrefKey.SearchMinQueryLength, 2),
  )
  const [serverSearchIndexDefault, setServerSearchIndexDefault] = useState<boolean | undefined>(undefined)

  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [fetchingModels, setFetchingModels] = useState(false)

  // The server-proxy config endpoint is only relevant in proxy mode.
  useEffect(() => {
    if (connectionMode !== 'proxy') {
      return
    }
    let cancelled = false
    application
      .assistantConfigRequest<AssistantConfig>('/v1/assistant/config')
      .then((result) => {
        if (cancelled) {
          return
        }
        setConfig(result)
        if (!application.getPreference(PrefKey.AssistantProvider, '') && result.defaultProvider) {
          setProvider(result.defaultProvider)
          void application.setPreference(PrefKey.AssistantProvider, result.defaultProvider)
        }
        if (!application.getPreference(PrefKey.AssistantModel, '') && result.defaultModel) {
          setModel(result.defaultModel)
          void application.setPreference(PrefKey.AssistantModel, result.defaultModel)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error))
        }
      })
    return () => {
      cancelled = true
    }
  }, [application, connectionMode])

  const handleConnectionModeChange = useCallback(
    (value: ConnectionMode) => {
      setConnectionMode(value)
      void application.setPreference(PrefKey.AssistantConnectionMode, value)
    },
    [application],
  )

  const handleProviderChange = useCallback(
    (value: string) => {
      setProvider(value)
      void application.setPreference(PrefKey.AssistantProvider, value)
      // The model list is provider-specific; clear it until re-fetched.
      setAvailableModels([])
      setModelsError(null)
    },
    [application],
  )

  const handleBaseURLChange = useCallback(
    (value: string) => {
      setBaseURL(value)
      void application.setPreference(PrefKey.AssistantBaseUrl, value)
    },
    [application],
  )

  const handleApiKeyChange = useCallback(
    (value: string) => {
      setApiKey(value)
      void application.setPreference(PrefKey.AssistantApiKey, value)
    },
    [application],
  )

  const handleAuthModeChange = useCallback(
    (value: 'api-key' | 'subscription') => {
      setAuthMode(value)
      void application.setPreference(PrefKey.AssistantAuthMode, value)
    },
    [application],
  )

  const handleSubscriptionTokenChange = useCallback(
    (value: string) => {
      setSubscriptionToken(value)
      void application.setPreference(PrefKey.AssistantSubscriptionToken, value)
    },
    [application],
  )

  const handleExtraHeadersChange = useCallback(
    (value: string) => {
      setExtraHeaders(value)
      void application.setPreference(PrefKey.AssistantExtraHeaders, value)
    },
    [application],
  )

  const handleModelChange = useCallback(
    (value: string) => {
      setModel(value)
      void application.setPreference(PrefKey.AssistantModel, value)
    },
    [application],
  )

  const handleConfirmToggle = useCallback(
    (value: boolean) => {
      setConfirmBeforeWrite(value)
      void application.setPreference(PrefKey.AssistantConfirmBeforeWrite, value)
    },
    [application],
  )

  const handleAiSearchToggle = useCallback(
    (value: boolean) => {
      setAiSearch(value)
      void application.setPreference(PrefKey.AiPoweredSearchEnabled, value)
    },
    [application],
  )

  const handleContextualSearchToggle = useCallback((value: boolean) => {
    setContextualSearch(value)
    saveContextualSearchSettings({ enabled: value })
  }, [])

  const handleDeepResearchToggle = useCallback((value: boolean) => {
    setDeepResearch(value)
    saveDeepResearchSettings({ enabled: value })
  }, [])

  const handleResearchModeToggle = useCallback((value: boolean) => {
    setResearchMode(value)
    saveResearchModeSettings({ enabled: value })
  }, [])

  // Whether a provider is configured at all (reuses the assistant's own check).
  // Used to warn that contextual search will be visible-disabled without one.
  const providerAvailability = useMemo(() => getSelectionAIAvailability(application), [application])

  const handleSearchIndexToggle = useCallback(
    (value: boolean) => {
      setSearchIndexEnabled(value)
      void application.setPreference(PrefKey.SearchIndexEnabled, value)
    },
    [application],
  )

  const handleSearchCacheSizeChange = useCallback(
    (value: number) => {
      const clamped = Number.isFinite(value) && value > 0 ? Math.floor(value) : 50
      setSearchCacheSize(clamped)
      void application.setPreference(PrefKey.SearchQueryCacheSize, clamped)
    },
    [application],
  )

  const handleSearchMinQueryLengthChange = useCallback(
    (value: number) => {
      const clamped = Number.isFinite(value) && value > 0 ? Math.floor(value) : 2
      setSearchMinQueryLength(clamped)
      void application.setPreference(PrefKey.SearchMinQueryLength, clamped)
    },
    [application],
  )

  // Read the server-provided SEARCH_INDEX_ENABLED default once (for display). The
  // client pref always wins; this is shown only to explain effective behavior.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const user = application.sessions.getUser()
        if (!user) {
          return
        }
        const response = await application.legacyApi.getSetting(user.uuid, SEARCH_INDEX_ENABLED_SETTING)
        if (isErrorResponse(response)) {
          return
        }
        const value = (response as { data?: { setting?: { value?: string | null } } }).data?.setting?.value
        if (!cancelled && (value === 'true' || value === 'false')) {
          setServerSearchIndexDefault(value === 'true')
        }
      } catch {
        /* server default is optional; ignore */
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [application])

  const handleFetchModels = useCallback(async () => {
    setModelsError(null)
    setFetchingModels(true)
    try {
      const url = `${baseURL.replace(/\/$/, '')}/models`
      const headers: Record<string, string> = {}
      const bearer = authMode === 'subscription' ? subscriptionToken.trim() : apiKey.trim()
      if (bearer) {
        headers['Authorization'] = `Bearer ${bearer}`
      }
      const response = await fetch(url, { headers })
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`)
      }
      const json = (await response.json()) as { data?: Array<{ id?: string }> }
      const ids = (json.data ?? []).map((entry) => entry.id).filter((id): id is string => Boolean(id))
      setAvailableModels(ids)
      if (ids.length === 0) {
        setModelsError('The endpoint returned no models.')
      }
    } catch (error) {
      setModelsError(error instanceof Error ? error.message : String(error))
    } finally {
      setFetchingModels(false)
    }
  }, [baseURL, apiKey, authMode, subscriptionToken])

  const handleFetchServerModels = useCallback(async () => {
    if (!provider) {
      setModelsError('Select a provider first.')
      return
    }
    setModelsError(null)
    setFetchingModels(true)
    try {
      const result = await application.assistantConfigRequest<{ provider: string; models: string[] }>(
        `/v1/assistant/models?provider=${encodeURIComponent(provider)}`,
      )
      const ids = Array.isArray(result?.models) ? result.models : []
      setAvailableModels(ids)
      if (ids.length === 0) {
        setModelsError('The server returned no models for this provider.')
      }
    } catch (error) {
      setModelsError(error instanceof Error ? error.message : String(error))
    } finally {
      setFetchingModels(false)
    }
  }, [application, provider])

  const providers = config?.providers ?? []

  // Dictation / speech-to-text settings (device-local; persisted in localStorage).
  // dictationEnabled is DEFAULT OFF — it gates the editor mic toggle.
  const [dictation, setDictation] = useState<DictationSettings>(() => loadDictationSettings())
  const sttAvailability = useMemo(() => getSttAvailability(application), [application])
  const speechRecognitionSupported = useMemo(() => getSpeechRecognitionCtor() !== undefined, [])
  const updateDictation = useCallback((patch: Partial<DictationSettings>) => {
    setDictation((prev) => {
      const next = { ...prev, ...patch }
      saveDictationSettings(next)
      return next
    })
  }, [])

  // Assistant PERSONA ("soul"): free-text tone/personality guidance layered onto the
  // assistant's system prompt as STYLE ONLY (never overrides safety/anti-injection
  // rules). Web-local (localStorage), DEFAULT empty (neutral default voice).
  const [persona, setPersona] = useState(() => loadPersonaSettings().persona)
  const updatePersona = useCallback((value: string) => {
    const next = value.slice(0, PERSONA_MAX_LENGTH)
    setPersona(next)
    savePersonaSettings({ persona: next })
  }, [])

  // Persona PROFILES: named bundles of (persona + model + baseURL + sampling) with
  // one active. When a profile is active it overrides the global persona/model/
  // sampling for assistant runs. Device-local (localStorage).
  const [personaProfiles, setPersonaProfiles] = useState(() => loadPersonaProfiles())
  const persistPersonaProfiles = useCallback((next: ReturnType<typeof loadPersonaProfiles>) => {
    setPersonaProfiles(next)
    savePersonaProfiles(next)
  }, [])
  const updatePersonaProfile = useCallback(
    (id: string, patch: Partial<PersonaProfile>) => {
      setPersonaProfiles((prev) => {
        const next = {
          ...prev,
          profiles: prev.profiles.map((profile) => (profile.id === id ? { ...profile, ...patch } : profile)),
        }
        savePersonaProfiles(next)
        return next
      })
    },
    [],
  )
  const addPersonaProfile = useCallback(() => {
    setPersonaProfiles((prev) => {
      const created = createPersonaProfile(prev.profiles)
      const next = { activeId: created.id, profiles: [...prev.profiles, created] }
      savePersonaProfiles(next)
      return next
    })
  }, [])
  const removePersonaProfile = useCallback((id: string) => {
    setPersonaProfiles((prev) => {
      const profiles = prev.profiles.filter((profile) => profile.id !== id)
      const activeId = prev.activeId === id ? profiles[0]?.id ?? '' : prev.activeId
      const next = { activeId, profiles }
      savePersonaProfiles(next)
      return next
    })
  }, [])
  const setActiveProfile = useCallback(
    (id: string) => {
      persistPersonaProfiles({ ...personaProfiles, activeId: id })
    },
    [persistPersonaProfiles, personaProfiles],
  )
  const activeProfile = personaProfiles.profiles.find((p) => p.id === personaProfiles.activeId)

  // Model SAMPLING params + agent-loop step cap (device-local; localStorage).
  // temperature/top_p/max_tokens flow into every model request body; maxSteps is
  // the default agent-loop step cap read by agent.ts.
  const [sampling, setSampling] = useState<SamplingSettings>(() => loadSamplingSettings())
  const updateSampling = useCallback((patch: Partial<SamplingSettings>) => {
    setSampling((prev) => {
      const next = { ...prev, ...patch }
      saveSamplingSettings(next)
      return next
    })
  }, [])

  const [selectionActions, setSelectionActions] = useState(() => getSelectionActions(application))
  const persistSelectionActions = useCallback(
    (next: SelectionAction[]) => {
      void application.setPreference(PrefKey.AssistantSelectionActions, serializeSelectionActions(next))
    },
    [application],
  )
  const updateSelectionAction = useCallback(
    (id: SelectionActionId, patch: Partial<Pick<SelectionAction, 'enabled' | 'prompt' | 'label' | 'icon'>>) => {
      setSelectionActions((prev) => {
        const next = prev.map((action) => {
          if (action.id !== id) {
            return action
          }
          const merged = { ...action, ...patch }
          // For custom actions, derive language-prompting from the {language} placeholder
          // so the editor asks for a target language whenever the template uses it.
          if (action.custom && patch.prompt !== undefined) {
            merged.needsLanguage = patch.prompt.includes('{language}')
          }
          return merged
        })
        persistSelectionActions(next)
        return next
      })
    },
    [persistSelectionActions],
  )
  const addCustomSelectionAction = useCallback(() => {
    setSelectionActions((prev) => {
      const next = [...prev, createCustomSelectionAction(prev)]
      persistSelectionActions(next)
      return next
    })
  }, [persistSelectionActions])
  const removeSelectionAction = useCallback(
    (id: SelectionActionId) => {
      setSelectionActions((prev) => {
        const next = prev.filter((action) => action.id !== id)
        persistSelectionActions(next)
        return next
      })
    },
    [persistSelectionActions],
  )

  return (
    <PreferencesPane>
      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Assistant</Title>
          <Text>
            The in-app assistant runs entirely in your browser. Your notes are decrypted locally and never leave your
            device unencrypted.
          </Text>
          <Text className="mt-2">
            {connectionMode === 'direct'
              ? 'In Direct mode the browser talks straight to the OpenAI-compatible endpoint you configure below (e.g. LM Studio, Ollama, OpenRouter, OpenAI, or any custom server). Your API key, if any, is stored in your encrypted synced preferences and sent only to that endpoint.'
              : 'In Server proxy mode your Standard Red Notes server relays one model turn at a time to the AI provider using a server-held API key.'}
          </Text>

          <div className="mt-4 rounded border border-solid border-warning bg-warning-faded p-3">
            <Subtitle className="text-warning">The assistant sends note content to an external AI provider</Subtitle>
            <Text className="mt-1">
              Tool execution runs locally in your browser, but the model calls do not. Your messages, and any note
              content the assistant reads while answering, are sent to the AI model you configure. This can expose
              information you did not intend to share — especially with cloud providers.
            </Text>
            <Text className="mt-1">
              In Direct mode the content goes straight from your browser to the endpoint you configure below (e.g.
              OpenAI, OpenRouter, or a local LM Studio / Ollama server). In Server proxy mode it is relayed through your
              Standard Red Notes server and then on to the provider. Either way, end-to-end-encrypted content leaves your
              device once you use the assistant. Only use it with notes you are comfortable sharing this way.
            </Text>
          </div>

          <HorizontalSeparator classes="my-4" />

          <Subtitle>Connection mode</Subtitle>
          <select
            className="mt-2 rounded border border-border bg-default px-2 py-1.5 text-sm"
            value={connectionMode}
            onChange={(event) => handleConnectionModeChange(event.target.value as ConnectionMode)}
          >
            <option value="direct">Direct (browser → endpoint)</option>
            <option value="proxy">Server proxy</option>
          </select>
        </PreferencesSegment>
      </PreferencesGroup>

      {connectionMode === 'direct' && (
        <PreferencesGroup>
          <PreferencesSegment>
            <Subtitle>Endpoint presets</Subtitle>
            <div className="mt-2 flex flex-wrap gap-2">
              {PRESETS.map((preset) => (
                <Button key={preset.label} label={preset.label} onClick={() => handleBaseURLChange(preset.baseURL)} />
              ))}
            </div>

            <HorizontalSeparator classes="my-4" />

            <Subtitle>Base URL</Subtitle>
            <Text>OpenAI-compatible base URL, ending in /v1 (e.g. http://localhost:1234/v1).</Text>
            <input
              className="mt-2 w-full rounded border border-border bg-default px-2 py-1.5 text-sm"
              type="text"
              value={baseURL}
              placeholder="http://localhost:1234/v1"
              onChange={(event) => handleBaseURLChange(event.target.value)}
            />

            <HorizontalSeparator classes="my-4" />

            <Subtitle>Authentication</Subtitle>
            <Text>
              API key (default) for OpenAI/OpenRouter, or an OpenAI Codex / ChatGPT subscription access token. In
              subscription mode the browser sends your ChatGPT/Codex token as a bearer credential to the endpoint you set
              above (point the base URL at the ChatGPT/Codex backend), plus any extra headers below.
            </Text>
            <select
              className="mt-2 rounded border border-border bg-default px-2 py-1.5 text-sm"
              value={authMode}
              onChange={(event) => handleAuthModeChange(event.target.value as 'api-key' | 'subscription')}
            >
              <option value="api-key">API key</option>
              <option value="subscription">OpenAI Codex / ChatGPT subscription token</option>
            </select>

            <HorizontalSeparator classes="my-4" />

            {authMode === 'api-key' ? (
              <>
                <Subtitle>API key</Subtitle>
                <Text>Optional. LM Studio and Ollama need none; OpenAI and OpenRouter require a key.</Text>
                <input
                  className="mt-2 w-full rounded border border-border bg-default px-2 py-1.5 text-sm"
                  type="password"
                  value={apiKey}
                  placeholder="(leave empty for local servers)"
                  onChange={(event) => handleApiKeyChange(event.target.value)}
                />
              </>
            ) : (
              <>
                <Subtitle>Subscription token</Subtitle>
                <Text>
                  ChatGPT/Codex subscription access token (an OAuth access / session token from your ChatGPT account
                  login). Sent as a bearer credential. Note: acquiring and refreshing this token is a manual/OAuth step —
                  see the documentation. The ChatGPT/Codex backend contract is not a stable public API and may require
                  the extra headers below.
                </Text>
                <input
                  className="mt-2 w-full rounded border border-border bg-default px-2 py-1.5 text-sm"
                  type="password"
                  value={subscriptionToken}
                  placeholder="ChatGPT/Codex access token"
                  onChange={(event) => handleSubscriptionTokenChange(event.target.value)}
                />

                <HorizontalSeparator classes="my-4" />

                <Subtitle>Extra headers</Subtitle>
                <Text>
                  Optional headers sent with every request, e.g. an account id or OpenAI-Beta flag the Codex backend may
                  require. JSON object or comma-separated “Key: Value” list (e.g. {'{'}"ChatGPT-Account-Id":"acct_…"
                  {'}'} or OpenAI-Beta: responses=v1).
                </Text>
                <input
                  className="mt-2 w-full rounded border border-border bg-default px-2 py-1.5 text-sm"
                  type="text"
                  value={extraHeaders}
                  placeholder='{"ChatGPT-Account-Id":"acct_…"}'
                  onChange={(event) => handleExtraHeadersChange(event.target.value)}
                />
              </>
            )}

            <HorizontalSeparator classes="my-4" />

            <Subtitle>Model</Subtitle>
            <Text>Identifier of the model to use, or fetch the list the endpoint advertises.</Text>
            <div className="mt-2 flex items-center gap-2">
              <input
                className="w-full rounded border border-border bg-default px-2 py-1.5 text-sm"
                type="text"
                value={model}
                placeholder="model identifier"
                onChange={(event) => handleModelChange(event.target.value)}
              />
              <Button
                label={fetchingModels ? 'Loading…' : 'Fetch models'}
                onClick={() => void handleFetchModels()}
                disabled={!baseURL || fetchingModels}
              />
            </div>
            {modelsError && <Text className="mt-2 text-danger">Could not fetch models: {modelsError}</Text>}
            {availableModels.length > 0 && (
              <select
                className="mt-2 w-full rounded border border-border bg-default px-2 py-1.5 text-sm"
                value={availableModels.includes(model) ? model : ''}
                onChange={(event) => handleModelChange(event.target.value)}
              >
                <option value="" disabled>
                  Select a model
                </option>
                {availableModels.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            )}
          </PreferencesSegment>
        </PreferencesGroup>
      )}

      {connectionMode === 'proxy' && (
        <PreferencesGroup>
          <PreferencesSegment>
            <Subtitle>Provider</Subtitle>
            {loadError && <Text className="text-danger">Could not load server configuration: {loadError}</Text>}
            {!loadError && providers.length === 0 && (
              <Text>No providers are configured on the server. Set ASSISTANT_*_API_KEY environment variables.</Text>
            )}
            {providers.length > 0 && (
              <select
                className="mt-2 rounded border border-border bg-default px-2 py-1.5 text-sm"
                value={provider}
                onChange={(event) => handleProviderChange(event.target.value)}
              >
                <option value="" disabled>
                  Select a provider
                </option>
                {providers.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            )}

            <HorizontalSeparator classes="my-4" />

            <Subtitle>Model</Subtitle>
            <Text>
              Identifier of the model to use, or fetch the list the server’s provider offers (queried with the
              server-held key).
            </Text>
            <div className="mt-2 flex items-center gap-2">
              <input
                className="w-full rounded border border-border bg-default px-2 py-1.5 text-sm"
                type="text"
                value={model}
                placeholder={config?.defaultModel || 'model identifier'}
                onChange={(event) => handleModelChange(event.target.value)}
              />
              <Button
                label={fetchingModels ? 'Loading…' : 'Fetch models'}
                onClick={() => void handleFetchServerModels()}
                disabled={!provider || fetchingModels}
              />
            </div>
            {modelsError && <Text className="mt-2 text-danger">Could not fetch models: {modelsError}</Text>}
            {availableModels.length > 0 && (
              <select
                className="mt-2 w-full rounded border border-border bg-default px-2 py-1.5 text-sm"
                value={availableModels.includes(model) ? model : ''}
                onChange={(event) => handleModelChange(event.target.value)}
              >
                <option value="" disabled>
                  Select a model
                </option>
                {availableModels.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            )}
          </PreferencesSegment>
        </PreferencesGroup>
      )}

      <PreferencesGroup>
        <PreferencesSegment>
          <div className="flex items-center justify-between">
            <div className="mr-4 flex flex-col">
              <Subtitle>Ask before write actions</Subtitle>
              <Text>
                Require confirmation before the assistant creates, edits, deletes, or otherwise modifies your data.
              </Text>
            </div>
            <Switch checked={confirmBeforeWrite} onChange={handleConfirmToggle} />
          </div>
        </PreferencesSegment>
      </PreferencesGroup>

      <PreferencesGroup>
        <PreferencesSegment>
          <div className="flex items-center justify-between">
            <div className="mr-4 flex flex-col">
              <Subtitle>AI-powered search</Subtitle>
              <Text>
                Rank note-list search results by local relevance (BM25) instead of plain text order. Runs entirely in
                your browser over decrypted notes — nothing is sent anywhere. Off by default.
              </Text>
            </div>
            <Switch checked={aiSearch} onChange={handleAiSearchToggle} />
          </div>
        </PreferencesSegment>
      </PreferencesGroup>

      <PreferencesGroup>
        <PreferencesSegment>
          <div className="flex items-center justify-between">
            <div className="mr-4 flex flex-col">
              <Subtitle>AI contextual search (provider re-ranking)</Subtitle>
              <Text>
                Adds a “Search with AI” action to the search bar. After the normal algorithmic search narrows results,
                it sends the top candidates to your configured AI provider to re-rank them by semantic relevance to your
                query. Off by default. Runs only when you click the action (not on every keystroke).
              </Text>
            </div>
            <Switch checked={contextualSearch} onChange={handleContextualSearchToggle} />
          </div>

          {contextualSearch && (
            <div className="mt-4 rounded border border-solid border-warning bg-warning-faded p-3">
              <Subtitle className="text-warning">AI contextual search sends note content to your AI provider</Subtitle>
              <Text className="mt-1">
                When you run “Search with AI”, the titles and short snippets of the top ~20 matching notes, together with
                your search query, are sent to the AI provider you configure above to be re-ranked. With cloud providers
                this exposes that content to a third party. Prefer a local model (e.g. LM
                Studio / Ollama in Direct mode) to keep it on your device. Only the bounded candidate set is sent — never
                your whole library and never full note bodies.
              </Text>
              <Text className="mt-1 text-passive-1">
                This is provider-dependent re-ranking of a small candidate set, not a semantic index over all your
                notes.
              </Text>
              {!providerAvailability.available && (
                <Text className="mt-1 text-warning">
                  {providerAvailability.reason || 'Configure an AI provider above to use this.'} Until then the action
                  appears disabled.
                </Text>
              )}
            </div>
          )}
        </PreferencesSegment>
      </PreferencesGroup>

      <PreferencesGroup>
        <PreferencesSegment>
          <div className="flex items-center justify-between">
            <div className="mr-4 flex flex-col">
              <Subtitle>AI deep research (multi-step, over your notes)</Subtitle>
              <Text>
                Adds a “Deep research” action to the assistant. Given a question, it runs a bounded multi-step loop over
                your OWN notes: it searches for relevant notes, reads a bounded set, optionally pulls in a few more over
                a small capped number of rounds, then writes a structured report with citations to the source notes you
                can open. Off by default. Runs only when you start a research run.
              </Text>
            </div>
            <Switch checked={deepResearch} onChange={handleDeepResearchToggle} />
          </div>

          {deepResearch && (
            <div className="mt-4 rounded border border-solid border-warning bg-warning-faded p-3">
              <Subtitle className="text-warning">Deep research sends several notes to your AI provider over multiple steps</Subtitle>
              <Text className="mt-1">
                Unlike a single query, deep research reads the content of multiple notes and sends those excerpts to the
                AI provider across several model calls (capped at a few rounds and a small number of notes, with
                truncated snippets). That is substantially more data exposure than a one-shot question. With cloud
                providers this exposes that content to a third party — strongly prefer a local model (e.g. LM Studio /
                Ollama in Direct mode) to keep it on your device.
              </Text>
              <Text className="mt-1 text-passive-1">
                Honest scope: this researches your OWN notes only — there is no web-search tool here, so it cannot pull
                in outside sources. It is a bounded agentic loop (capped rounds, notes, and snippet length), not
                unlimited research.
              </Text>
              {!providerAvailability.available && (
                <Text className="mt-1 text-warning">
                  {providerAvailability.reason || 'Configure an AI provider above to use this.'} Until then the action
                  appears disabled.
                </Text>
              )}
            </div>
          )}
        </PreferencesSegment>
      </PreferencesGroup>

      <PreferencesGroup>
        <PreferencesSegment>
          <div className="flex items-center justify-between">
            <div className="mr-4 flex flex-col">
              <Subtitle>AI research mode (write a structured note on a topic)</Subtitle>
              <Text>
                Adds a “Research mode” panel to the assistant. Given a topic or question, it writes a structured note
                (title, sections, and a Sources list) and saves it as a new note you can open. Off by default. Runs only
                when you start a research run.
              </Text>
            </div>
            <Switch checked={researchMode} onChange={handleResearchModeToggle} />
          </div>

          {researchMode && (
            <div className="mt-4 rounded border border-solid border-warning bg-warning-faded p-3">
              <Subtitle className="text-warning">Research mode has no web access — its output must be verified</Subtitle>
              <Text className="mt-1">
                There is no web-search tool in this client, so research mode writes the note from the AI model’s own
                training data, not from live sources. The result can be outdated, incomplete, or wrong, and any sources
                it lists are the model’s recollections that must be independently verified. The model is instructed to
                flag uncertainty and never fabricate URLs or citations, and every generated note carries a clear
                “unverified — verify this” warning. It is also hardened against prompt-injection in the topic text.
              </Text>
              <Text className="mt-1 text-passive-1">
                Your topic is sent to the configured AI provider. With cloud providers this exposes it to a third party
                — prefer a local model (e.g. LM Studio / Ollama in Direct mode) to keep it on your device.
              </Text>
              {!providerAvailability.available && (
                <Text className="mt-1 text-warning">
                  {providerAvailability.reason || 'Configure an AI provider above to use this.'} Until then the action
                  appears disabled.
                </Text>
              )}
            </div>
          )}
        </PreferencesSegment>
      </PreferencesGroup>

      <AgentRuntimeSettings application={application} />

      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Output length</Title>
          <Text>
            Cap how many tokens the model generates per turn. Applies to every assistant request (chat, selection
            actions, research) in both Direct and Server proxy modes. Stored on this device only.
          </Text>

          <HorizontalSeparator classes="my-4" />

          <Subtitle>Max output tokens</Subtitle>
          <Text>
            Cap on tokens generated per turn (request <code>max_tokens</code>). Leave 0 to let the endpoint use its own
            default. Up to {MAX_TOKENS_MAX}.
          </Text>
          <input
            className="mt-2 w-32 rounded border border-border bg-default px-2 py-1.5 text-sm"
            type="number"
            min={0}
            max={MAX_TOKENS_MAX}
            value={sampling.maxTokens}
            onChange={(event) => updateSampling({ maxTokens: clampMaxTokens(Number(event.target.value)) })}
          />
        </PreferencesSegment>
      </PreferencesGroup>

      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Search</Title>
          <Text>
            A client-side full-text search index speeds up note-list search on large accounts. It builds an inverted
            index over your decrypted notes in the browser — nothing is sent anywhere. When off, search uses the plain
            substring matcher.
          </Text>
          {serverSearchIndexDefault !== undefined && (
            <Text className="mt-2 text-passive-1">
              Server default: search index {serverSearchIndexDefault ? 'enabled' : 'disabled'}. Your setting below takes
              precedence.
            </Text>
          )}

          <HorizontalSeparator classes="my-4" />

          <div className="flex items-center justify-between">
            <div className="mr-4 flex flex-col">
              <Subtitle>Use search index</Subtitle>
              <Text>Enable the fast inverted-index search path with substring fallback. On by default.</Text>
            </div>
            <Switch checked={searchIndexEnabled} onChange={handleSearchIndexToggle} />
          </div>

          {searchIndexEnabled && (
            <>
              <HorizontalSeparator classes="my-4" />

              <Subtitle>Minimum query length</Subtitle>
              <Text>Queries shorter than this fall back to substring search. Default 2.</Text>
              <input
                className="mt-2 w-24 rounded border border-border bg-default px-2 py-1.5 text-sm"
                type="number"
                min={1}
                value={searchMinQueryLength}
                onChange={(event) => handleSearchMinQueryLengthChange(Number(event.target.value))}
              />

              <HorizontalSeparator classes="my-4" />

              <Subtitle>Query cache size</Subtitle>
              <Text>How many recent search results to cache (LRU). Default 50.</Text>
              <input
                className="mt-2 w-24 rounded border border-border bg-default px-2 py-1.5 text-sm"
                type="number"
                min={1}
                value={searchCacheSize}
                onChange={(event) => handleSearchCacheSizeChange(Number(event.target.value))}
              />
            </>
          )}
        </PreferencesSegment>
      </PreferencesGroup>

      <NarrationSettings application={application} />

      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Recording, transcription &amp; dictation</Title>
          <Text>
            Record audio and attach it to a note from the note&rsquo;s options menu (“Record audio / Transcribe”). You
            can transcribe a recording to text, or dictate directly into a note by speaking.
          </Text>

          <div className="mt-4 rounded border border-solid border-warning bg-warning-faded p-3">
            <Subtitle className="text-warning">Transcription and dictation send audio off your device</Subtitle>
            <Text className="mt-1">
              Transcribing a recording uploads the audio to your configured Direct-mode AI endpoint&rsquo;s{' '}
              <code>/audio/transcriptions</code> route for speech-to-text. Browser dictation uses the Web Speech API,
              which on Chromium-based browsers streams your microphone audio to a cloud service. Only use these with
              content you are comfortable sending this way. Saving a recording as a file attachment stays in your own
              encrypted Standard Red Notes storage.
            </Text>
          </div>

          <Text className="mt-3 text-passive-1">
            {sttAvailability.modelAvailable
              ? 'Transcription is available via your Direct endpoint’s /audio/transcriptions route.'
              : 'Recorded-audio transcription needs Direct mode with a base URL (server-proxy mode has no transcription route). Live dictation uses the browser’s on-device speech recognition.'}
          </Text>

          <HorizontalSeparator classes="my-4" />

          <SttModelSettings application={application} />

          <HorizontalSeparator classes="my-4" />

          <Subtitle>Spoken language</Subtitle>
          <Text>
            Optional BCP-47 language hint for transcription and dictation (e.g. en-US, es-ES). Leave empty to
            auto-detect.
          </Text>
          <input
            className="mt-2 w-full rounded border border-border bg-default px-2 py-1.5 text-sm"
            type="text"
            value={dictation.language}
            placeholder="auto-detect"
            onChange={(event) => updateDictation({ language: event.target.value })}
          />

          <HorizontalSeparator classes="my-4" />

          <div className="flex items-center justify-between">
            <div className="mr-4 flex flex-col">
              <Subtitle>Enable dictation (type by speaking)</Subtitle>
              <Text>
                Adds a microphone toggle to the note toolbar that inserts spoken words at the cursor as you talk. Off by
                default. Uses the browser&rsquo;s speech recognition (Chromium-based browsers only) and listens to your
                microphone only after you press the toggle.
              </Text>
              {!speechRecognitionSupported && (
                <Text className="mt-1 text-warning">
                  This browser does not support the Web Speech recognition API, so dictation will not appear even when
                  enabled. Try a Chromium-based browser.
                </Text>
              )}
            </div>
            <Switch
              checked={dictation.dictationEnabled}
              onChange={(value) => updateDictation({ dictationEnabled: value })}
            />
          </div>
        </PreferencesSegment>
      </PreferencesGroup>

      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Persona</Title>
          <Text>
            Give the assistant a personality. This free-text description shapes the assistant&rsquo;s tone and voice
            across chat, the research panel, and editor selection actions (e.g. &ldquo;a concise, friendly senior
            engineer&rdquo;). Leave it empty for the default neutral voice.
          </Text>
          <Text className="mt-2 text-passive-1">
            The persona affects style only. It is layered after the assistant&rsquo;s built-in safety,
            anti-prompt-injection, and anti-hallucination rules and can never relax them, reveal the system prompt, or
            make the assistant follow instructions hidden in the persona text.
          </Text>

          <HorizontalSeparator classes="my-4" />

          <Subtitle>Presets</Subtitle>
          <div className="mt-2 flex flex-wrap gap-2">
            {PERSONA_PRESETS.map((preset) => (
              <Button key={preset.label} label={preset.label} onClick={() => updatePersona(preset.persona)} />
            ))}
            <Button label="Clear" onClick={() => updatePersona('')} />
          </div>

          <HorizontalSeparator classes="my-4" />

          <Subtitle>Persona description</Subtitle>
          <Text>Describe the personality and tone you want. Up to {PERSONA_MAX_LENGTH} characters.</Text>
          <textarea
            className="mt-2 w-full resize-none rounded border border-border bg-default px-2 py-1.5 text-sm"
            rows={4}
            maxLength={PERSONA_MAX_LENGTH}
            value={persona}
            placeholder="a concise, friendly senior engineer who explains tradeoffs and skips filler"
            onChange={(event) => updatePersona(event.target.value)}
          />
          <Text className="mt-1 text-passive-1">
            {persona.length}/{PERSONA_MAX_LENGTH}
          </Text>

          <HorizontalSeparator classes="my-4" />

          <Subtitle>Profiles</Subtitle>
          <Text>
            Optional named profiles bundle a persona with a model, an optional Direct-mode base URL, and sampling
            params. When a profile is active it overrides the global persona, model, base URL, and sampling for assistant
            runs. Leave a profile field empty to inherit the global setting. With no profiles, the single persona above
            is used.
          </Text>

          <div className="mt-2 flex items-center gap-2">
            <select
              className="rounded border border-border bg-default px-2 py-1.5 text-sm"
              value={personaProfiles.activeId}
              onChange={(event) => setActiveProfile(event.target.value)}
              disabled={personaProfiles.profiles.length === 0}
            >
              <option value="">None (use global persona)</option>
              {personaProfiles.profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
            <Button label="Add profile" onClick={addPersonaProfile} />
          </div>

          {activeProfile && (
            <div className="mt-3 rounded border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <input
                  className="w-full rounded border border-border bg-default px-2 py-1 text-sm font-semibold"
                  type="text"
                  value={activeProfile.name}
                  maxLength={PROFILE_NAME_MAX_LENGTH}
                  placeholder="Profile name"
                  onChange={(event) => updatePersonaProfile(activeProfile.id, { name: event.target.value })}
                />
                <Button label="Remove" onClick={() => removePersonaProfile(activeProfile.id)} />
              </div>

              <Text className="mt-3">Persona (up to {PERSONA_MAX_LENGTH} characters)</Text>
              <textarea
                className="mt-1 w-full resize-none rounded border border-border bg-default px-2 py-1.5 text-sm"
                rows={3}
                maxLength={PERSONA_MAX_LENGTH}
                value={activeProfile.persona}
                placeholder="a concise, friendly senior engineer"
                onChange={(event) => updatePersonaProfile(activeProfile.id, { persona: event.target.value })}
              />

              <div className="mt-3 flex flex-wrap gap-3">
                <div className="flex flex-col">
                  <Text>Model (optional)</Text>
                  <input
                    className="mt-1 rounded border border-border bg-default px-2 py-1.5 text-sm"
                    type="text"
                    value={activeProfile.model}
                    placeholder="inherit global"
                    onChange={(event) => updatePersonaProfile(activeProfile.id, { model: event.target.value })}
                  />
                </div>
                <div className="flex flex-col">
                  <Text>Base URL (optional, Direct mode)</Text>
                  <input
                    className="mt-1 rounded border border-border bg-default px-2 py-1.5 text-sm"
                    type="text"
                    value={activeProfile.baseURL}
                    placeholder="inherit global"
                    onChange={(event) => updatePersonaProfile(activeProfile.id, { baseURL: event.target.value })}
                  />
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-4">
                <div className="flex flex-col">
                  <Text>Temperature: {activeProfile.temperature.toFixed(2)}</Text>
                  <input
                    type="range"
                    min={TEMPERATURE_MIN}
                    max={TEMPERATURE_MAX}
                    step={0.05}
                    value={activeProfile.temperature}
                    onChange={(event) =>
                      updatePersonaProfile(activeProfile.id, { temperature: clampTemperature(Number(event.target.value)) })
                    }
                  />
                </div>
                <div className="flex flex-col">
                  <Text>Top-p: {activeProfile.topP.toFixed(2)}</Text>
                  <input
                    type="range"
                    min={TOP_P_MIN}
                    max={TOP_P_MAX}
                    step={0.05}
                    value={activeProfile.topP}
                    onChange={(event) =>
                      updatePersonaProfile(activeProfile.id, { topP: clampTopP(Number(event.target.value)) })
                    }
                  />
                </div>
                <div className="flex flex-col">
                  <Text>Max tokens (0 = unset)</Text>
                  <input
                    className="mt-1 w-32 rounded border border-border bg-default px-2 py-1.5 text-sm"
                    type="number"
                    min={0}
                    max={MAX_TOKENS_MAX}
                    value={activeProfile.maxTokens}
                    onChange={(event) =>
                      updatePersonaProfile(activeProfile.id, { maxTokens: clampMaxTokens(Number(event.target.value)) })
                    }
                  />
                </div>
              </div>
            </div>
          )}
        </PreferencesSegment>
      </PreferencesGroup>

      <PreferencesGroup>
        <PreferencesSegment>
          <Subtitle>Text selection AI actions</Subtitle>
          <Text>
            Actions shown in the editor’s selection toolbar when text is selected. Toggle the built-ins on or off and
            edit their prompts (these override the defaults), or add your own custom actions below.
          </Text>
          {selectionActions.map((action) => (
            <div key={action.id} className="mt-3">
              <div className="flex items-center justify-between gap-2">
                {action.custom ? (
                  <input
                    className="w-full rounded border border-border bg-default px-2 py-1 text-sm font-semibold"
                    type="text"
                    value={action.label}
                    placeholder="Action label"
                    onChange={(event) => updateSelectionAction(action.id, { label: event.target.value })}
                  />
                ) : (
                  <span className="text-sm font-semibold">{action.label}</span>
                )}
                <div className="flex shrink-0 items-center gap-2">
                  <Switch
                    checked={action.enabled}
                    onChange={(value) => updateSelectionAction(action.id, { enabled: value })}
                  />
                  {action.custom && (
                    <Button label="Remove" onClick={() => removeSelectionAction(action.id)} />
                  )}
                </div>
              </div>
              {!action.freeform && action.enabled && (
                <>
                  <textarea
                    className="mt-1 w-full resize-none rounded border border-border bg-default px-2 py-1 text-sm"
                    rows={2}
                    value={action.prompt}
                    placeholder={action.custom ? 'Instruction applied to the selected text…' : undefined}
                    onChange={(event) => updateSelectionAction(action.id, { prompt: event.target.value })}
                  />
                  {action.needsLanguage && (
                    <Text className="mt-1 text-passive-1">
                      Use <code>{'{language}'}</code> where the target language should go. You pick the language each
                      time you translate (any language is accepted, not just the suggested list).
                    </Text>
                  )}
                </>
              )}
            </div>
          ))}

          <HorizontalSeparator classes="my-4" />

          <Button label="Add custom action" onClick={addCustomSelectionAction} />
          <Text className="mt-2 text-passive-1">
            Custom actions run their instruction over the selected text and replace it with the result. Include{' '}
            <code>{'{language}'}</code> in the instruction to be prompted for a target language each time.
          </Text>
        </PreferencesSegment>
      </PreferencesGroup>
    </PreferencesPane>
  )
}

export default observer(Assistant)
