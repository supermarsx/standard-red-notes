import { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useApplication } from '@/Components/ApplicationProvider'
import Button from '@/Components/Button/Button'
import { Title, Text } from '../../PreferencesComponents/Content'
import PreferencesGroup from '../../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../../PreferencesComponents/PreferencesSegment'

const reasonText = {
  conflict:
    'A note matches rules for different vaults. Its vault was kept unchanged. Remove or align the conflicting rules.',
  locked: 'Unlock the source and destination vaults, then retry.',
  permission: 'A source or destination vault is read-only for your account.',
  'linked-items':
    'Related topics, notes or files are outside the target vault. Move those related items explicitly, then retry.',
  saving: 'Waiting for a safe, authoritative note saver. The note will be retried automatically.',
  unavailable: 'The selected vault is unavailable. Update or remove the rule.',
  'move-failed': 'An assignment could not finish. Check sync and vault access, then retry.',
}

export default observer(function AutoVaultRulesPanel() {
  const application = useApplication()
  const service = application.autoVaultRulesService
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const retry = async () => {
    setBusy(true)
    try {
      await service.applyRules()
      setError('')
    } catch {
      setError('Could not apply rules. Try again.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>Automatic vault assignments</Title>
        <Text>
          Choose a vault in a topic or folder’s options to assign its existing and future notes. Conflicting
          destinations keep notes in their current vault until you resolve the rules.
        </Text>
        {service.rules.length === 0 && <p className="mt-2">No automatic vault rules.</p>}
        <ul className="divide-border mt-2 divide-y">
          {service.rules.map((rule) => {
            const source = application.items.findItem(rule.sourceUuid) as { title?: string } | undefined
            const vault = application.vaults.getVaults().find((candidate) => candidate.uuid === rule.vaultUuid)
            return (
              <li key={`${rule.kind}:${rule.sourceUuid}`} className="py-2">
                <p>
                  {source?.title || `Unavailable ${rule.kind === 'tag' ? 'topic' : 'folder'}`} →{' '}
                  {vault?.name || 'Unavailable vault'}
                  {vault?.isSharedVaultListing() && ' (shared)'}
                </p>
                <Button
                  small
                  label="Remove rule"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true)
                    void service
                      .setRule(rule.kind, rule.sourceUuid)
                      .catch(() => setError('Could not remove rule.'))
                      .finally(() => setBusy(false))
                  }}
                />
              </li>
            )
          })}
        </ul>
        {service.problems.length > 0 && (
          <div role="status" className="mt-3">
            <p>{service.problems.length} assignments need attention:</p>
            <ul>
              {[...new Set(service.problems.map((problem) => problem.reason))].map((reason) => (
                <li key={reason}>{reasonText[reason]}</li>
              ))}
            </ul>
          </div>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="mt-3 flex gap-3">
          <Button label="Retry assignments" disabled={busy || !service.rules.length} onClick={() => void retry()} />
          <Button label="Review sync" onClick={() => application.openPreferences('sync')} />
        </div>
      </PreferencesSegment>
    </PreferencesGroup>
  )
})
