import { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import type { SNFolder, SNTag } from '@standardnotes/snjs'
import { useApplication } from '../ApplicationProvider'
import Button from '../Button/Button'

export default observer(function AutoVaultRuleControl({
  source,
  kind,
}: {
  source: SNTag | SNFolder
  kind: 'tag' | 'folder'
}) {
  const application = useApplication()
  const service = application.autoVaultRulesService
  const current = service.rules.find((rule) => rule.kind === kind && rule.sourceUuid === source.uuid)?.vaultUuid ?? ''
  const [selected, setSelected] = useState(current)
  useEffect(() => setSelected(current), [source.uuid, current])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const vaults = application.vaults.getVaults()
  const target = vaults.find((vault) => vault.uuid === selected)
  const preview = selected ? service.previewRule(kind, source.uuid, selected) : undefined
  const save = async () => {
    setSaving(true)
    setError('')
    try {
      await service.setRule(kind, source.uuid, selected || undefined)
    } catch {
      setError('Could not save the vault rule. Try again.')
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="border-border my-2 border-y px-4 py-3 text-sm">
      <label className="font-semibold">
        Automatically assign notes to a vault
        <select
          aria-label="Automatic note vault"
          className="border-border bg-default mt-2 w-full rounded border p-2"
          value={selected}
          disabled={saving}
          onChange={(event) => setSelected(event.target.value)}
        >
          <option value="">No automatic assignment</option>
          {vaults.map((vault) => (
            <option key={vault.uuid} value={vault.uuid}>
              {vault.name}
              {vault.isSharedVaultListing() ? ' (shared)' : ''}
            </option>
          ))}
        </select>
      </label>
      {preview && (
        <p className="mt-2 text-xs">
          {preview.notes} existing notes match this rule.
          {preview.conflicts > 0 &&
            ` ${preview.conflicts} match conflicting vault rules and will keep their current vault.`}
        </p>
      )}
      <p className="text-neutral mt-2 text-xs">
        Applies to existing and future notes, including{' '}
        {kind === 'tag' ? 'subtopics. The topic and its subtopics also move into the vault' : 'subfolders'}. Removing
        this rule keeps notes in their current vault. Unrelated linked items are never moved automatically.
      </p>
      {target?.isSharedVaultListing() && (
        <p className="text-warning mt-2 text-xs">Members of this shared vault will be able to access assigned notes.</p>
      )}
      <Button
        className="mt-2"
        label={selected ? 'Save and apply rule' : 'Remove rule'}
        disabled={saving || selected === current}
        onClick={() => void save()}
      />
      {error && (
        <p role="alert" className="text-danger mt-2">
          {error}
        </p>
      )}
      <button className="text-info mt-2 block" onClick={() => application.openPreferences('vaults')}>
        Review rules and blocked assignments
      </button>
    </div>
  )
})
