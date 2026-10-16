import Button from '@/Components/Button/Button'
import { Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'

type Props = { enabled: boolean | undefined; busy: boolean; onChange: (enabled: boolean) => void; onReset: () => void }
export default function AssistantInternetAccessSetting({ enabled, busy, onChange, onReset }: Props) {
  return (
    <>
      <Title>Internet access</Title>
      <Text className="mt-1">
        Allow assistant web searches and page retrieval. This server policy applies to every user and mode. Each request
        still requires its normal approval; a configured search provider is needed for searches.
      </Text>
      {enabled === undefined ? (
        <Text>Internet access policy is not reported by this server.</Text>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy}
              onChange={(event) => onChange(event.target.checked)}
            />
            Allow internet access
          </label>
          <Button label="Reset to default" disabled={busy} onClick={onReset} />
        </div>
      )}
    </>
  )
}
