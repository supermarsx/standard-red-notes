import { useCallback, useEffect, useState } from 'react'
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
import { getSelectionActions, SelectionActionId } from '@/Assistant/selectionActions'

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
  const [model, setModel] = useState(() => application.getPreference(PrefKey.AssistantModel, ''))
  const [confirmBeforeWrite, setConfirmBeforeWrite] = useState(() =>
    application.getPreference(PrefKey.AssistantConfirmBeforeWrite, true),
  )
  const [aiSearch, setAiSearch] = useState(() => application.getPreference(PrefKey.AiPoweredSearchEnabled, false))

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
      if (apiKey.trim()) {
        headers['Authorization'] = `Bearer ${apiKey.trim()}`
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
  }, [baseURL, apiKey])

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

  const [selectionActions, setSelectionActions] = useState(() => getSelectionActions(application))
  const updateSelectionAction = useCallback(
    (id: SelectionActionId, patch: { enabled?: boolean; prompt?: string }) => {
      setSelectionActions((prev) => {
        const next = prev.map((action) => (action.id === id ? { ...action, ...patch } : action))
        const overrides: Record<string, { enabled: boolean; prompt: string }> = {}
        next.forEach((action) => {
          overrides[action.id] = { enabled: action.enabled, prompt: action.prompt }
        })
        void application.setPreference(PrefKey.AssistantSelectionActions, JSON.stringify(overrides))
        return next
      })
    },
    [application],
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

            <Subtitle>API key</Subtitle>
            <Text>Optional. LM Studio and Ollama need none; OpenAI and OpenRouter require a key.</Text>
            <input
              className="mt-2 w-full rounded border border-border bg-default px-2 py-1.5 text-sm"
              type="password"
              value={apiKey}
              placeholder="(leave empty for local servers)"
              onChange={(event) => handleApiKeyChange(event.target.value)}
            />

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

      <PreferencesGroup>
        <PreferencesSegment>
          <Subtitle>Text selection AI actions</Subtitle>
          <Text>
            Actions shown in the editor’s selection toolbar when text is selected. Toggle them on or off and edit their
            prompts. These override the defaults.
          </Text>
          {selectionActions.map((action) => (
            <div key={action.id} className="mt-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">{action.label}</span>
                <Switch
                  checked={action.enabled}
                  onChange={(value) => updateSelectionAction(action.id, { enabled: value })}
                />
              </div>
              {!action.freeform && action.enabled && (
                <textarea
                  className="mt-1 w-full resize-none rounded border border-border bg-default px-2 py-1 text-sm"
                  rows={2}
                  value={action.prompt}
                  onChange={(event) => updateSelectionAction(action.id, { prompt: event.target.value })}
                />
              )}
            </div>
          ))}
        </PreferencesSegment>
      </PreferencesGroup>
    </PreferencesPane>
  )
}

export default observer(Assistant)
