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

type AssistantConfig = {
  providers: string[]
  defaultProvider: string
  defaultModel: string
}

const Assistant = ({ application }: { application: WebApplication }) => {
  const [config, setConfig] = useState<AssistantConfig | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [provider, setProvider] = useState(() => application.getPreference(PrefKey.AssistantProvider, ''))
  const [model, setModel] = useState(() => application.getPreference(PrefKey.AssistantModel, ''))
  const [confirmBeforeWrite, setConfirmBeforeWrite] = useState(() =>
    application.getPreference(PrefKey.AssistantConfirmBeforeWrite, true),
  )

  useEffect(() => {
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
  }, [application])

  const handleProviderChange = useCallback(
    (value: string) => {
      setProvider(value)
      void application.setPreference(PrefKey.AssistantProvider, value)
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

  const providers = config?.providers ?? []

  return (
    <PreferencesPane>
      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Assistant</Title>
          <Text>
            The in-app assistant runs entirely in your browser. Your notes are decrypted locally and never leave your
            device unencrypted. The server only relays one model turn at a time to the AI provider using a server-held
            API key.
          </Text>

          <HorizontalSeparator classes="my-4" />

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
    </PreferencesPane>
  )
}

export default observer(Assistant)
