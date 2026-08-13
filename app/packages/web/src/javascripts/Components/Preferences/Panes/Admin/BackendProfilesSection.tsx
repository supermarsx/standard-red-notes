import { FunctionComponent, useCallback, useEffect, useMemo, useState } from 'react'

import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import DecoratedInput from '@/Components/Input/DecoratedInput'
import { ToastType, addToast } from '@standardnotes/toast'
import { AdminBackendProfileView } from './adminHelpers'
import {
  BACKEND_PROVIDER_OPTIONS,
  BackendProfilePayload,
  BackendProfileRow,
  backendProviderSupportsBaseUrl,
  backendUsesOpenAiWireProtocol,
  buildBackendProfilesUpdate,
  emptyBackendRow,
  maskedBackendToRow,
  validateBackendRows,
} from './aiBackendProfiles'

type Props = {
  backendProfiles: AdminBackendProfileView[]
  busy: boolean
  onSave: (update: { backendProfiles: BackendProfilePayload[] }) => Promise<boolean>
}

const signatureOf = (backends: AdminBackendProfileView[]): string => JSON.stringify(backends)

/**
 * Standard Red Notes: DECOUPLED backend (provider/connection) profiles — add /
 * edit / delete reusable connections that assistant profiles reference by id.
 * An api-key backend carries a provider + base URL + model + write-only key; a
 * subscription backend names a paired ChatGPT/Codex subscription id. Secrets are
 * never prefilled (the server reports only a "configured" boolean).
 */
const BackendProfilesSection: FunctionComponent<Props> = ({ backendProfiles, busy, onSave }) => {
  const signature = useMemo(() => signatureOf(backendProfiles), [backendProfiles])
  const [rows, setRows] = useState<BackendProfileRow[]>(() => backendProfiles.map(maskedBackendToRow))
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    setRows(backendProfiles.map(maskedBackendToRow))
    setDirty(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  const mutateRow = useCallback((id: string, patch: Partial<BackendProfileRow>) => {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)))
    setDirty(true)
  }, [])

  const addBackend = useCallback((type: 'api-key' | 'subscription') => {
    setRows((current) => [...current, emptyBackendRow(type)])
    setDirty(true)
  }, [])

  const deleteBackend = useCallback((id: string) => {
    setRows((current) => current.filter((row) => row.id !== id))
    setDirty(true)
  }, [])

  const handleSave = useCallback(async () => {
    const validation = validateBackendRows(rows)
    if (!validation.ok) {
      addToast({ type: ToastType.Error, message: validation.error })
      return
    }
    await onSave(buildBackendProfilesUpdate(rows))
  }, [rows, onSave])

  return (
    <PreferencesSegment>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Title>Backend profiles</Title>
        <div className="flex items-center gap-2">
          <Button label="Add API-key backend" onClick={() => addBackend('api-key')} disabled={busy} />
          <Button label="Add subscription backend" onClick={() => addBackend('subscription')} disabled={busy} />
          <Button
            label={busy ? 'Saving…' : 'Save backends'}
            primary
            onClick={() => void handleSave()}
            disabled={busy || !dirty}
          />
        </div>
      </div>
      <Text className="mt-1">
        Reusable provider/connection configs that assistant profiles reference. An <strong>API-key backend</strong>{' '}
        holds a provider + base URL + model + write-only key; a <strong>subscription backend</strong> names a paired
        ChatGPT/Codex subscription (pair it with the wizard below). Save as a set.
      </Text>

      {rows.length === 0 && (
        <Text className="text-passive-1 mt-3">
          No backend profiles defined yet — existing single-provider/assistant configs still work unchanged.
        </Text>
      )}

      {rows.map((row) => (
        <div key={row.id} className="border-border mt-3 rounded border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Subtitle>{row.name.trim() === '' ? 'Untitled backend' : row.name}</Subtitle>
              <span className="bg-passive-3 text-foreground rounded px-2 py-0.5 text-xs font-bold">
                {row.type === 'subscription' ? 'Subscription' : 'API key'}
              </span>
              {row.keyConfigured && (
                <span className="bg-success text-success-contrast rounded px-2 py-0.5 text-xs font-bold">Key set</span>
              )}
            </div>
            <Button label="Delete" colorStyle="danger" onClick={() => deleteBackend(row.id)} disabled={busy} />
          </div>

          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label className="text-sm font-semibold">Name</label>
              <DecoratedInput
                className={{ container: 'mt-1' }}
                placeholder="e.g. Team Anthropic"
                value={row.name}
                onChange={(value) => mutateRow(row.id, { name: value })}
                disabled={busy}
              />
            </div>

            {row.type === 'api-key' ? (
              <>
                <div>
                  <label className="text-sm font-semibold">Provider</label>
                  <select
                    className="border-border bg-default text-foreground mt-1 w-full rounded border px-2 py-1.5"
                    value={row.provider}
                    onChange={(event) =>
                      mutateRow(row.id, { provider: event.target.value as BackendProfileRow['provider'] })
                    }
                    disabled={busy}
                  >
                    {BACKEND_PROVIDER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                {backendProviderSupportsBaseUrl(row.provider) && (
                  <div>
                    <label className="text-sm font-semibold">Base URL</label>
                    <DecoratedInput
                      className={{ container: 'mt-1' }}
                      placeholder="https://…"
                      value={row.baseUrl}
                      onChange={(value) => mutateRow(row.id, { baseUrl: value })}
                      disabled={busy}
                    />
                  </div>
                )}
                <div>
                  <label className="text-sm font-semibold">Default model</label>
                  <DecoratedInput
                    className={{ container: 'mt-1' }}
                    placeholder="Model id (optional)"
                    value={row.model}
                    onChange={(value) => mutateRow(row.id, { model: value })}
                    disabled={busy}
                  />
                </div>
                <div>
                  <label className="text-sm font-semibold">API key</label>
                  <div className="mt-1 flex items-center gap-2">
                    <DecoratedInput
                      className={{ container: 'flex-1' }}
                      type="password"
                      placeholder={row.keyConfigured ? 'Set a new key (leave blank to keep)' : 'Set key (write-only)'}
                      value={row.newKey}
                      onChange={(value) => mutateRow(row.id, { newKey: value, clearKey: false })}
                      disabled={busy}
                    />
                    {row.keyConfigured && (
                      <Button
                        label={row.clearKey ? 'Will clear' : 'Clear key'}
                        colorStyle={row.clearKey ? 'danger' : 'default'}
                        onClick={() => mutateRow(row.id, { clearKey: !row.clearKey, newKey: '' })}
                        disabled={busy}
                      />
                    )}
                  </div>
                </div>
              </>
            ) : (
              <>
                <div>
                  <label className="text-sm font-semibold">Subscription id</label>
                  <DecoratedInput
                    className={{ container: 'mt-1' }}
                    placeholder="e.g. default or team-a"
                    value={row.subscriptionId}
                    onChange={(value) => mutateRow(row.id, { subscriptionId: value })}
                    disabled={busy}
                  />
                </div>
                <div>
                  <label className="text-sm font-semibold">Base URL (optional)</label>
                  <DecoratedInput
                    className={{ container: 'mt-1' }}
                    placeholder="https://chatgpt.com/backend-api/codex"
                    value={row.baseUrl}
                    onChange={(value) => mutateRow(row.id, { baseUrl: value })}
                    disabled={busy}
                  />
                </div>
                <div>
                  <label className="text-sm font-semibold">Default model</label>
                  <DecoratedInput
                    className={{ container: 'mt-1' }}
                    placeholder="Model id (required unless the assistant overrides it)"
                    value={row.model}
                    onChange={(value) => mutateRow(row.id, { model: value })}
                    disabled={busy}
                  />
                </div>
                <div className="md:col-span-2">
                  <Text className="text-passive-1 text-xs">
                    Uses the paired subscription credential whose id matches above. Pair it with the wizard below (the
                    id you enter when adding a pairing must match this subscription id).
                  </Text>
                </div>
              </>
            )}
          </div>

          <details className="border-border bg-contrast mt-3 rounded border px-3 py-2">
            <summary className="cursor-pointer text-sm font-semibold select-none">Advanced transport controls</summary>
            <Text className="text-passive-1 mt-2 text-xs">
              Backend-level connection behavior shared by every assistant profile that references this backend.
              Generation controls remain on each assistant profile.
            </Text>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
              {backendUsesOpenAiWireProtocol(row) && (
                <div>
                  <label className="text-sm font-semibold">OpenAI wire protocol</label>
                  <select
                    className="border-border bg-default text-foreground mt-1 w-full rounded border px-2 py-1.5 text-sm"
                    value={row.wireProtocol}
                    onChange={(event) =>
                      mutateRow(row.id, { wireProtocol: event.target.value as BackendProfileRow['wireProtocol'] })
                    }
                    disabled={busy}
                  >
                    <option value="chat-completions">Chat Completions</option>
                    <option value="responses">Responses</option>
                  </select>
                  <Text className="text-passive-1 mt-1 text-xs">
                    Subscription backends normally use Responses; most local OpenAI-compatible servers use Chat
                    Completions.
                  </Text>
                </div>
              )}
              <div>
                <label className="text-sm font-semibold">Request timeout (ms)</label>
                <input
                  className="border-border bg-default text-foreground mt-1 w-full rounded border px-2 py-1.5 text-sm"
                  type="number"
                  min="1000"
                  max="600000"
                  step="1000"
                  placeholder="60000 (server default)"
                  value={row.timeoutMs}
                  onChange={(event) => mutateRow(row.id, { timeoutMs: event.target.value })}
                  disabled={busy}
                />
                <Text className="text-passive-1 mt-1 text-xs">1–600 seconds for one upstream attempt.</Text>
              </div>
              <div>
                <label className="text-sm font-semibold">Maximum retries</label>
                <input
                  className="border-border bg-default text-foreground mt-1 w-full rounded border px-2 py-1.5 text-sm"
                  type="number"
                  min="0"
                  max="10"
                  step="1"
                  placeholder="2 (server default)"
                  value={row.maxRetries}
                  onChange={(event) => mutateRow(row.id, { maxRetries: event.target.value })}
                  disabled={busy}
                />
                <Text className="text-passive-1 mt-1 text-xs">0 disables retries; maximum 10.</Text>
              </div>
            </div>
          </details>
        </div>
      ))}

      <HorizontalSeparator classes="my-4" />
    </PreferencesSegment>
  )
}

export default BackendProfilesSection
