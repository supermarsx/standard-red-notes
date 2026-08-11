import PreferencesGroup from '../../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../../PreferencesComponents/PreferencesSegment'
import { Subtitle, Text } from '../../PreferencesComponents/Content'
import { ServerManagedAssistantConfig } from './useServerManagedAssistantConfig'

export const ServerManagedAssistantConfiguration = ({
  config,
  loadError,
}: {
  config: ServerManagedAssistantConfig | null
  loadError: string | null
}) => {
  const provider = config?.effectiveProfile?.provider || config?.defaultProvider || ''
  const model = config?.effectiveProfile?.model || config?.defaultModel || ''

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Subtitle>Server-managed configuration</Subtitle>
        {loadError ? (
          <>
            <Text className="text-danger">Could not load your server-assigned assistant: {loadError}</Text>
            <Text className="mt-2">Sign in again or ask an administrator to verify your AI profile assignment.</Text>
          </>
        ) : config === null ? (
          <Text>Loading your server-assigned assistant…</Text>
        ) : !provider ? (
          <Text>
            No assistant profile is assigned and no legacy server provider is configured. Ask an administrator to
            configure and assign a profile under Preferences → Admin → AI.
          </Text>
        ) : (
          <>
            <Text>
              Your server administrator controls the provider and model for proxy requests. Direct-mode provider and
              model preferences on this device are not used.
            </Text>
            <dl
              aria-label="Effective server-managed assistant configuration"
              className="border-border bg-contrast mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded border p-3 text-sm"
            >
              <dt className="font-semibold">Profile</dt>
              <dd>{config.effectiveProfile?.name || 'Legacy server default'}</dd>
              <dt className="font-semibold">Provider</dt>
              <dd>{provider}</dd>
              <dt className="font-semibold">Model</dt>
              <dd>{model || 'Provider default'}</dd>
            </dl>
          </>
        )}
      </PreferencesSegment>
    </PreferencesGroup>
  )
}
