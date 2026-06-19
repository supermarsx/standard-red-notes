import { useCallback, useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { PrefKey } from '@standardnotes/snjs'
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
            <Text>Identifier of the model to use (e.g. claude-3-5-sonnet-latest, gpt-4o, llama3.1).</Text>
            <input
              className="mt-2 w-full rounded border border-border bg-default px-2 py-1.5 text-sm"
              type="text"
              value={model}
              placeholder={config?.defaultModel || 'model identifier'}
              onChange={(event) => handleModelChange(event.target.value)}
            />
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
