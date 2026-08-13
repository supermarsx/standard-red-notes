import { FunctionComponent, useCallback, useEffect, useMemo, useState } from 'react'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import DecoratedInput from '@/Components/Input/DecoratedInput'
import { ToastType, addToast } from '@standardnotes/toast'
import {
  AiProfilePayload,
  buildProfilesUpdate,
  emptyProfileRow,
  MaskedAiProfile,
  maskedProfileToRow,
  PROFILE_PROVIDER_OPTIONS,
  ProfileRow,
  profileSummary,
  providerOption,
  validateProfileRows,
} from './aiProfiles'
import { AdminBackendProfileView } from './adminHelpers'
import { backendOptionLabel } from './aiBackendProfiles'

type Props = {
  application: WebApplication
  profiles: MaskedAiProfile[]
  defaultProfileId: string | null
  /** Standard Red Notes: backend profiles a profile may reference by id. */
  backendProfiles: AdminBackendProfileView[]
  busy: boolean
  /** Persist the whole profiles list + default via the server-settings PUT. */
  onSave: (update: { profiles: AiProfilePayload[]; defaultProfileId: string | null }) => Promise<boolean>
}

/** Stable signature of the server view so local rows reset only on real changes. */
const viewSignature = (profiles: MaskedAiProfile[], defaultProfileId: string | null): string =>
  JSON.stringify({ profiles, defaultProfileId })

/**
 * Standard Red Notes: MULTIPLE named assistant profiles — add / edit / delete,
 * a default selector, per-profile enable toggle, provider dropdown, base URL,
 * model (with server-side "fetch models" discovery for saved profiles), and a
 * write-only API key for API-key providers. Subscription profiles use only the
 * encrypted pairing store; legacy plaintext tokens are visibly ignored and
 * cleared on save.
 */
const AiProfilesSection: FunctionComponent<Props> = ({
  application,
  profiles,
  defaultProfileId,
  backendProfiles,
  busy,
  onSave,
}) => {
  const signature = useMemo(() => viewSignature(profiles, defaultProfileId), [profiles, defaultProfileId])
  const [rows, setRows] = useState<ProfileRow[]>(() => profiles.map(maskedProfileToRow))
  const [defaultId, setDefaultId] = useState<string | null>(defaultProfileId)
  const [dirty, setDirty] = useState(false)
  const [savingModelsFor, setSavingModelsFor] = useState<string | null>(null)
  const migrationNeeded = rows.some((row) => row.legacyInlineCredentialIgnored)

  // Re-sync from the server view whenever it actually changes (after a save /
  // reload). Local unsaved edits are intentionally reset at that point.
  useEffect(() => {
    setRows(profiles.map(maskedProfileToRow))
    setDefaultId(defaultProfileId)
    setDirty(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  const savedIds = useMemo(() => new Set(profiles.map((profile) => profile.id)), [profiles])

  const mutateRow = useCallback((id: string, patch: Partial<ProfileRow>) => {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)))
    setDirty(true)
  }, [])

  const addProfile = useCallback(() => {
    const row = emptyProfileRow()
    setRows((current) => [...current, row])
    setDefaultId((current) => current ?? row.id)
    setDirty(true)
  }, [])

  const deleteProfile = useCallback((id: string) => {
    setRows((current) => current.filter((row) => row.id !== id))
    setDefaultId((current) => (current === id ? null : current))
    setDirty(true)
  }, [])

  const fetchModels = useCallback(
    async (row: ProfileRow) => {
      if (!savedIds.has(row.id)) {
        addToast({ type: ToastType.Regular, message: 'Save the profile first, then fetch its models.' })
        return
      }
      setSavingModelsFor(row.id)
      try {
        const { ok, data } = await application.serverGetJsonRequest<{
          models?: string[]
          error?: { message?: string }
        }>(`/v1/assistant/models?profileId=${encodeURIComponent(row.id)}`)
        if (!ok || !data?.models || data.models.length === 0) {
          addToast({
            type: ToastType.Regular,
            message: 'No models returned — enter the model id manually.',
          })
          return
        }
        mutateRow(row.id, { models: data.models, model: row.model || data.models[0] })
        addToast({ type: ToastType.Success, message: `Found ${data.models.length} model(s).` })
      } catch {
        addToast({ type: ToastType.Error, message: 'Model discovery failed — enter the model id manually.' })
      } finally {
        setSavingModelsFor(null)
      }
    },
    [application, savedIds, mutateRow],
  )

  const handleSave = useCallback(async () => {
    const validation = validateProfileRows(rows, defaultId, backendProfiles)
    if (!validation.ok) {
      addToast({ type: ToastType.Error, message: validation.error })
      return
    }
    const update = buildProfilesUpdate(rows, defaultId)
    // The parent's save() reports success/failure toasts; we only surface local
    // validation errors here to avoid double toasts.
    await onSave(update)
  }, [rows, defaultId, backendProfiles, onSave])

  const datalistId = 'ai-profile-models'

  return (
    <PreferencesSegment>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Title>Assistant profiles</Title>
        <div className="flex items-center gap-2">
          <Button label="Add profile" onClick={addProfile} disabled={busy} />
          <Button
            label={busy ? 'Saving…' : 'Save profiles'}
            primary
            onClick={() => void handleSave()}
            disabled={busy || (!dirty && !migrationNeeded)}
          />
        </div>
      </div>
      <Text className="mt-1">
        Define assistant behavior and choose either an embedded provider connection or a reusable backend profile. One
        assistant profile is the <strong>default</strong>. API keys are write-only. Changes here save as a set — click{' '}
        <strong>Save profiles</strong> to persist.
      </Text>

      {rows.length === 0 && (
        <Text className="text-passive-1 mt-3">
          No named profiles yet. The single-provider cards below still work; add a profile to manage several providers.
        </Text>
      )}

      {rows.map((row) => {
        const option = providerOption(row.provider)
        const isSaved = savedIds.has(row.id)
        const selectedBackend = backendProfiles.find((backend) => backend.id === row.backendProfileId)
        const hasEffectiveModel = row.model.trim() !== '' || Boolean(selectedBackend?.model?.trim())
        const usesBackend = row.backendProfileId !== ''
        return (
          <div key={row.id} className="border-border mt-3 rounded border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <input
                  type="radio"
                  name="default-profile"
                  checked={defaultId === row.id}
                  onChange={() => {
                    setDefaultId(row.id)
                    setDirty(true)
                  }}
                  title="Use as the default profile"
                />
                <Subtitle>{row.name.trim() === '' ? 'Untitled profile' : row.name}</Subtitle>
                {defaultId === row.id && (
                  <span className="bg-info text-info-contrast rounded px-2 py-0.5 text-xs font-bold">Default</span>
                )}
                {row.keyConfigured && (
                  <span className="bg-success text-success-contrast rounded px-2 py-0.5 text-xs font-bold">
                    Key set
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    checked={row.enabled}
                    onChange={(event) => mutateRow(row.id, { enabled: event.target.checked })}
                  />
                  Enabled
                </label>
                <Button label="Delete" colorStyle="danger" onClick={() => deleteProfile(row.id)} disabled={busy} />
              </div>
            </div>

            <Text className="text-passive-1 mt-1 text-xs">{profileSummary(row)}</Text>

            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <label className="text-sm font-semibold">Name</label>
                <DecoratedInput
                  className={{ container: 'mt-1' }}
                  placeholder="e.g. Work Claude"
                  value={row.name}
                  onChange={(value) => mutateRow(row.id, { name: value })}
                  disabled={busy}
                />
              </div>
              <div>
                <label className="text-sm font-semibold">Provider</label>
                <select
                  className="border-border bg-default text-foreground mt-1 w-full rounded border px-2 py-1.5"
                  value={row.provider}
                  onChange={(event) => {
                    const provider = event.target.value as ProfileRow['provider']
                    mutateRow(row.id, {
                      provider,
                      models: [],
                      ...(provider === 'codex-subscription' ? { newKey: '', clearKey: false } : {}),
                    })
                  }}
                  disabled={busy || usesBackend}
                >
                  {PROFILE_PROVIDER_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-sm font-semibold">Backend profile</label>
                <select
                  className="border-border bg-default text-foreground mt-1 w-full rounded border px-2 py-1.5"
                  value={row.backendProfileId}
                  onChange={(event) => mutateRow(row.id, { backendProfileId: event.target.value })}
                  disabled={busy}
                >
                  <option value="">— use fields below (embedded) —</option>
                  {backendProfiles.map((backend) => (
                    <option key={backend.id} value={backend.id}>
                      {backendOptionLabel(backend)}
                    </option>
                  ))}
                </select>
                {row.backendProfileId !== '' && (
                  <Text className="text-passive-1 mt-1 text-xs">
                    Provider, connection, and credentials come from the selected backend. The model below may override
                    its default; generation controls remain specific to this assistant profile.
                  </Text>
                )}
              </div>

              {option.supportsBaseUrl && (
                <div>
                  <label className="text-sm font-semibold">Base URL</label>
                  <DecoratedInput
                    className={{ container: 'mt-1' }}
                    placeholder={option.baseUrlPlaceholder ?? 'https://…'}
                    value={row.baseUrl}
                    onChange={(value) => mutateRow(row.id, { baseUrl: value })}
                    disabled={busy || usesBackend}
                  />
                </div>
              )}

              <div>
                <label className="text-sm font-semibold">Model</label>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    className="border-border bg-default text-text focus-visible:ring-info flex-1 rounded border px-2 py-1.5 text-sm focus:outline-none focus-visible:ring-2"
                    placeholder={selectedBackend?.model ? `Backend default: ${selectedBackend.model}` : 'Model id'}
                    value={row.model}
                    onChange={(event) => mutateRow(row.id, { model: event.target.value })}
                    list={datalistId + '-' + row.id}
                    disabled={busy}
                  />
                  {option.supportsModelDiscovery && (
                    <Button
                      label={savingModelsFor === row.id ? '…' : 'Fetch'}
                      onClick={() => void fetchModels(row)}
                      disabled={busy || !isSaved}
                    />
                  )}
                </div>
                {row.models.length > 0 && (
                  <datalist id={datalistId + '-' + row.id}>
                    {row.models.map((model) => (
                      <option key={model} value={model} />
                    ))}
                  </datalist>
                )}
                {option.supportsModelDiscovery && !isSaved && (
                  <Text className="text-passive-1 mt-1 text-xs">Save the profile to enable model discovery.</Text>
                )}
                {!hasEffectiveModel && row.enabled && (
                  <Text className="text-danger mt-1 text-xs">
                    Set a model here
                    {usesBackend ? ' or set a default model on the selected backend.' : '.'}
                  </Text>
                )}
              </div>

              {row.provider === 'codex-subscription' ? (
                <div>
                  <label className="text-sm font-semibold">{option.keyLabel}</label>
                  <Text className="text-passive-1 mt-1 text-xs">
                    Pair a named subscription in the secure wizard below, then select the matching subscription backend.
                    Profile JSON never stores or accepts this token.
                  </Text>
                </div>
              ) : (
                <div>
                  <label className="text-sm font-semibold">{option.keyLabel}</label>
                  <div className="mt-1 flex items-center gap-2">
                    <DecoratedInput
                      className={{ container: 'flex-1' }}
                      type="password"
                      placeholder={row.keyConfigured ? 'Set a new key (leave blank to keep)' : 'Set key (write-only)'}
                      value={row.newKey}
                      onChange={(value) => mutateRow(row.id, { newKey: value, clearKey: false })}
                      disabled={busy || usesBackend}
                    />
                    {row.keyConfigured && (
                      <Button
                        label={row.clearKey ? 'Will clear' : 'Clear key'}
                        colorStyle={row.clearKey ? 'danger' : 'default'}
                        onClick={() => mutateRow(row.id, { clearKey: !row.clearKey, newKey: '' })}
                        disabled={busy || usesBackend}
                      />
                    )}
                  </div>
                </div>
              )}
            </div>

            <details className="border-border bg-contrast mt-3 rounded border px-3 py-2">
              <summary className="cursor-pointer text-sm font-semibold select-none">
                Advanced generation controls
              </summary>
              <Text className="text-passive-1 mt-2 text-xs">
                Optional profile-level overrides. Leave a field blank to use the server or provider default. Transport
                protocol, timeout, and retries belong to the backend profile.
              </Text>
              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
                <div>
                  <label className="text-sm font-semibold">Temperature</label>
                  <input
                    className="border-border bg-default text-foreground mt-1 w-full rounded border px-2 py-1.5 text-sm"
                    type="number"
                    min="0"
                    max="2"
                    step="0.05"
                    placeholder="0.7 (server default)"
                    value={row.temperature}
                    onChange={(event) => mutateRow(row.id, { temperature: event.target.value })}
                    disabled={busy}
                  />
                  <Text className="text-passive-1 mt-1 text-xs">0–2; higher values are more varied.</Text>
                </div>
                <div>
                  <label className="text-sm font-semibold">Top-p</label>
                  <input
                    className="border-border bg-default text-foreground mt-1 w-full rounded border px-2 py-1.5 text-sm"
                    type="number"
                    min="0"
                    max="1"
                    step="0.05"
                    placeholder="1 (server default)"
                    value={row.topP}
                    onChange={(event) => mutateRow(row.id, { topP: event.target.value })}
                    disabled={busy}
                  />
                  <Text className="text-passive-1 mt-1 text-xs">0–1 nucleus-sampling probability.</Text>
                </div>
                <div>
                  <label className="text-sm font-semibold">Maximum output tokens</label>
                  <input
                    className="border-border bg-default text-foreground mt-1 w-full rounded border px-2 py-1.5 text-sm"
                    type="number"
                    min="1"
                    max="200000"
                    step="1"
                    placeholder="4096 (server default)"
                    value={row.maxOutputTokens}
                    onChange={(event) => mutateRow(row.id, { maxOutputTokens: event.target.value })}
                    disabled={busy}
                  />
                  <Text className="text-passive-1 mt-1 text-xs">Positive whole number, up to 200,000.</Text>
                </div>
              </div>
            </details>

            {row.legacyInlineCredentialIgnored && (
              <div className="border-danger bg-danger-faded mt-3 rounded border border-solid p-3">
                <Subtitle className="text-danger">Legacy plaintext subscription credential ignored</Subtitle>
                <Text className="mt-1 text-xs">
                  This saved profile contains an older inline credential. The server does not use or return it. Save
                  profiles to remove it from plaintext settings, then pair the subscription with the secure wizard.
                </Text>
              </div>
            )}

            {option.notes && <Text className="text-passive-1 mt-2 text-xs">{option.notes}</Text>}
          </div>
        )
      })}

      <HorizontalSeparator classes="my-4" />
    </PreferencesSegment>
  )
}

export default AiProfilesSection
