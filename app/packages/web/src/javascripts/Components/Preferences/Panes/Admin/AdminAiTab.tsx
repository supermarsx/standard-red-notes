import { FunctionComponent, useCallback, useEffect, useState } from 'react'
import { isErrorResponse } from '@standardnotes/snjs'

import { AssistantSubscriptionStatus, WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import DecoratedInput from '@/Components/Input/DecoratedInput'
import Spinner from '@/Components/Spinner/Spinner'
import { ToastType, addToast } from '@standardnotes/toast'
import { confirmDialog } from '@standardnotes/ui-services'
import {
  AdminServerSettings,
  AdminServerSettingsResponse,
  buildApiKeySettingUpdate,
  buildDailyLimitSettingUpdate,
  buildUrlSettingUpdate,
  settingSource,
  settingSourceChipClass,
  settingSourceLabel,
} from './adminHelpers'

type Props = {
  application: WebApplication
  noteIfForbidden: (response: { status?: number }) => void
}

type ServerSettingsPartial = Parameters<WebApplication['legacyApi']['adminSetServerSettings']>[0]

/** Small chip showing where a setting's active value comes from (env/persisted/default). */
const SourceChip: FunctionComponent<{ sources: Record<string, string> | null; keys: string[] }> = ({
  sources,
  keys,
}) => {
  const source = settingSource(sources, ...keys)
  return (
    <span
      title="A saved override wins over the server environment; 'Default' means neither is set."
      className={`inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs font-bold ${settingSourceChipClass(source)}`}
    >
      {settingSourceLabel(source)}
    </span>
  )
}

/** Green/neutral "Configured" badge for a provider whose secret is write-only. */
const ConfiguredBadge: FunctionComponent<{ configured: boolean | undefined }> = ({ configured }) => (
  <span
    className={`inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs font-bold ${
      configured ? 'bg-success text-success-contrast' : 'bg-passive-4 text-foreground'
    }`}
  >
    {configured ? 'Configured' : 'Not configured'}
  </span>
)

/**
 * Admin AI tab: server-wide AI provider configuration backed by the
 * /v1/admin/server-settings endpoint. Secrets (API keys) are WRITE-ONLY —
 * the server only ever reports "configured" booleans, never the keys — and an
 * explicit Clear sends null to remove a persisted value. Loaded lazily; if the
 * endpoint is missing (older server) the whole tab degrades to a notice.
 */
const AdminAiTab: FunctionComponent<Props> = ({ application, noteIfForbidden }) => {
  const [settings, setSettings] = useState<AdminServerSettings | null>(null)
  const [sources, setSources] = useState<Record<string, string> | null>(null)
  const [loading, setLoading] = useState(true)
  const [notAvailable, setNotAvailable] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Write-only secret inputs (never prefilled — the server never returns keys).
  const [anthropicKey, setAnthropicKey] = useState('')
  const [openaiKey, setOpenaiKey] = useState('')
  // Non-secret fields, prefilled from the GET view.
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState('')
  const [ollamaUrl, setOllamaUrl] = useState('')
  const [dailyLimit, setDailyLimit] = useState('')

  const [savingSection, setSavingSection] = useState<string | null>(null)

  // Read-only context: the ChatGPT/Codex subscription pairing status (managed
  // in Preferences → Assistant; surfaced here so the whole AI picture is on one page).
  const [pairingStatus, setPairingStatus] = useState<AssistantSubscriptionStatus | null>(null)

  const applyView = useCallback((data: AdminServerSettingsResponse | undefined) => {
    const next = data?.settings ?? null
    setSettings(next)
    setSources(data?.sources ?? null)
    setOpenaiBaseUrl(next?.ai?.openaiBaseUrl ?? '')
    setOllamaUrl(next?.ai?.ollamaUrl ?? '')
    const limit = next?.ai?.dailyRequestLimit
    setDailyLimit(limit != null && limit > 0 ? String(limit) : '')
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const response = await application.legacyApi.adminGetServerSettings()
      if (isErrorResponse(response)) {
        noteIfForbidden(response)
        // The snjs HttpStatusCode enum has no NotFound member; compare numerically.
        if (Number(response.status) === 404) {
          setNotAvailable(true)
        } else {
          setLoadError('Could not load the AI server settings.')
        }
        return
      }
      setNotAvailable(false)
      applyView((response as { data?: AdminServerSettingsResponse }).data)
    } catch (error) {
      console.error(error)
      setLoadError('Could not load the AI server settings.')
    } finally {
      setLoading(false)
    }
  }, [application, noteIfForbidden, applyView])

  useEffect(() => {
    void load()
    void application.assistantSubscriptionStatus().then(setPairingStatus)
  }, [load, application])

  /**
   * Send a partial update and re-apply the returned view. Returns true on
   * success so callers can clear write-only inputs.
   */
  const save = useCallback(
    async (section: string, partial: ServerSettingsPartial, successMessage: string): Promise<boolean> => {
      setSavingSection(section)
      try {
        const response = await application.legacyApi.adminSetServerSettings(partial)
        if (isErrorResponse(response)) {
          noteIfForbidden(response)
          addToast({ type: ToastType.Error, message: 'Failed to save the setting on the server.' })
          return false
        }
        applyView((response as { data?: AdminServerSettingsResponse }).data)
        addToast({ type: ToastType.Success, message: successMessage })
        return true
      } catch (error) {
        console.error(error)
        addToast({ type: ToastType.Error, message: 'Failed to save the setting on the server.' })
        return false
      } finally {
        setSavingSection(null)
      }
    },
    [application, noteIfForbidden, applyView],
  )

  const saveAnthropicKey = useCallback(async () => {
    const update = buildApiKeySettingUpdate(anthropicKey)
    if (!update.ok) {
      addToast({ type: ToastType.Error, message: update.error })
      return
    }
    if (await save('anthropic', { ai: { anthropicApiKey: update.value } }, 'Anthropic API key saved.')) {
      setAnthropicKey('')
    }
  }, [anthropicKey, save])

  const clearAnthropicKey = useCallback(async () => {
    if (
      await confirmDialog({
        title: 'Clear the saved Anthropic API key?',
        text: 'The persisted key is removed from the server. If an environment key is configured it becomes active again; otherwise Anthropic becomes unconfigured.',
        confirmButtonText: 'Clear key',
        confirmButtonStyle: 'danger',
      })
    ) {
      await save('anthropic', { ai: { anthropicApiKey: null } }, 'Anthropic API key cleared.')
    }
  }, [save])

  const saveOpenaiKey = useCallback(async () => {
    const update = buildApiKeySettingUpdate(openaiKey)
    if (!update.ok) {
      addToast({ type: ToastType.Error, message: update.error })
      return
    }
    if (await save('openai-key', { ai: { openaiApiKey: update.value } }, 'OpenAI-compatible API key saved.')) {
      setOpenaiKey('')
    }
  }, [openaiKey, save])

  const clearOpenaiKey = useCallback(async () => {
    if (
      await confirmDialog({
        title: 'Clear the saved OpenAI-compatible API key?',
        text: 'The persisted key is removed from the server. If an environment key is configured it becomes active again; otherwise the provider becomes unconfigured.',
        confirmButtonText: 'Clear key',
        confirmButtonStyle: 'danger',
      })
    ) {
      await save('openai-key', { ai: { openaiApiKey: null } }, 'OpenAI-compatible API key cleared.')
    }
  }, [save])

  const saveOpenaiBaseUrl = useCallback(async () => {
    const update = buildUrlSettingUpdate(openaiBaseUrl)
    if (!update.ok) {
      addToast({ type: ToastType.Error, message: update.error })
      return
    }
    await save(
      'openai-url',
      { ai: { openaiBaseUrl: update.value } },
      update.value === null ? 'OpenAI-compatible base URL cleared.' : 'OpenAI-compatible base URL saved.',
    )
  }, [openaiBaseUrl, save])

  const saveOllamaUrl = useCallback(async () => {
    const update = buildUrlSettingUpdate(ollamaUrl)
    if (!update.ok) {
      addToast({ type: ToastType.Error, message: update.error })
      return
    }
    await save(
      'ollama',
      { ai: { ollamaUrl: update.value } },
      update.value === null ? 'Ollama URL cleared.' : 'Ollama URL saved.',
    )
  }, [ollamaUrl, save])

  const saveDailyLimit = useCallback(async () => {
    const update = buildDailyLimitSettingUpdate(dailyLimit)
    if (!update.ok) {
      addToast({ type: ToastType.Error, message: update.error })
      return
    }
    await save(
      'limit',
      { ai: { dailyRequestLimit: update.value } },
      update.value === null ? 'Daily request limit removed (unlimited).' : 'Daily request limit saved.',
    )
  }, [dailyLimit, save])

  if (loading) {
    return (
      <PreferencesSegment>
        <Title>AI configuration</Title>
        <Spinner className="mt-3 h-5 w-5" />
      </PreferencesSegment>
    )
  }

  if (notAvailable) {
    return (
      <PreferencesSegment>
        <Title>AI configuration</Title>
        <Text className="mt-2">
          Server-side AI configuration is not available on this server. Update the server to a version that provides
          the /v1/admin/server-settings endpoint to manage AI providers from here.
        </Text>
      </PreferencesSegment>
    )
  }

  if (loadError) {
    return (
      <PreferencesSegment>
        <Title>AI configuration</Title>
        <Text className="mt-2 text-danger">{loadError}</Text>
        <div className="mt-3">
          <Button label="Retry" onClick={() => void load()} />
        </div>
      </PreferencesSegment>
    )
  }

  const ai = settings?.ai
  const busy = savingSection !== null

  return (
    <>
      <PreferencesSegment>
        <div className="flex items-center justify-between gap-2">
          <Title>AI configuration</Title>
          <Button label="Refresh" onClick={() => void load()} disabled={busy} />
        </div>
        <Text>
          Server-wide AI provider settings for the assistant. API keys are write-only: the server reports only whether
          a key is configured and never returns the key itself. Values saved here are persisted on the server and{' '}
          <strong>override the corresponding environment variables</strong>; use Clear to remove an override and fall
          back to the environment value.
        </Text>
      </PreferencesSegment>

      <HorizontalSeparator classes="my-4" />

      {/* Anthropic */}
      <PreferencesSegment>
        <div className="rounded border border-border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Subtitle>Anthropic (Claude)</Subtitle>
            <div className="flex items-center gap-2">
              <SourceChip sources={sources} keys={['ai.anthropicApiKey', 'anthropicApiKey']} />
              <ConfiguredBadge configured={ai?.anthropicConfigured} />
            </div>
          </div>
          <Text className="mt-1">
            API key for Anthropic's Claude models. Set a new key below to save (or replace) it; the current key is
            never displayed.
          </Text>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <DecoratedInput
              className={{ container: 'w-80' }}
              type="password"
              placeholder="Set API key (write-only)"
              value={anthropicKey}
              onChange={setAnthropicKey}
              onEnter={() => void saveAnthropicKey()}
              disabled={busy}
            />
            <Button
              label={savingSection === 'anthropic' ? 'Saving…' : 'Save key'}
              primary
              onClick={() => void saveAnthropicKey()}
              disabled={busy || anthropicKey.trim() === ''}
            />
            <Button
              label="Clear"
              colorStyle="danger"
              onClick={() => void clearAnthropicKey()}
              disabled={busy || !ai?.anthropicConfigured}
            />
          </div>
        </div>
      </PreferencesSegment>

      {/* OpenAI-compatible */}
      <PreferencesSegment>
        <div className="rounded border border-border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Subtitle>OpenAI-compatible</Subtitle>
            <div className="flex items-center gap-2">
              <SourceChip sources={sources} keys={['ai.openaiApiKey', 'openaiApiKey']} />
              <ConfiguredBadge configured={ai?.openaiConfigured} />
            </div>
          </div>
          <Text className="mt-1">
            Any provider speaking the OpenAI API: OpenAI itself, OpenRouter, LM Studio, or Ollama's OpenAI-compatible
            endpoint. Point the base URL at the provider and set its key (local servers often accept any key).
          </Text>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <DecoratedInput
              className={{ container: 'w-80' }}
              type="password"
              placeholder="Set API key (write-only)"
              value={openaiKey}
              onChange={setOpenaiKey}
              onEnter={() => void saveOpenaiKey()}
              disabled={busy}
            />
            <Button
              label={savingSection === 'openai-key' ? 'Saving…' : 'Save key'}
              primary
              onClick={() => void saveOpenaiKey()}
              disabled={busy || openaiKey.trim() === ''}
            />
            <Button
              label="Clear"
              colorStyle="danger"
              onClick={() => void clearOpenaiKey()}
              disabled={busy || !ai?.openaiConfigured}
            />
          </div>
          <div className="mt-3">
            <div className="flex items-center gap-2">
              <Subtitle>Base URL</Subtitle>
              <SourceChip sources={sources} keys={['ai.openaiBaseUrl', 'openaiBaseUrl']} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <DecoratedInput
                className={{ container: 'w-80' }}
                placeholder="https://openrouter.ai/api/v1 (empty = provider default)"
                value={openaiBaseUrl}
                onChange={setOpenaiBaseUrl}
                onEnter={() => void saveOpenaiBaseUrl()}
                disabled={busy}
              />
              <Button
                label={savingSection === 'openai-url' ? 'Saving…' : 'Save URL'}
                onClick={() => void saveOpenaiBaseUrl()}
                disabled={busy}
              />
            </div>
            <Text className="mt-1 text-xs">
              Examples: LM Studio <code>http://localhost:1234/v1</code>, Ollama{' '}
              <code>http://localhost:11434/v1</code>, OpenRouter <code>https://openrouter.ai/api/v1</code>. Leave empty
              and save to clear the override.
            </Text>
          </div>
        </div>
      </PreferencesSegment>

      {/* Ollama native */}
      <PreferencesSegment>
        <div className="rounded border border-border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Subtitle>Ollama (native API)</Subtitle>
            <div className="flex items-center gap-2">
              <SourceChip sources={sources} keys={['ai.ollamaUrl', 'ollamaUrl']} />
              <ConfiguredBadge configured={Boolean(ai?.ollamaUrl)} />
            </div>
          </div>
          <Text className="mt-1">
            URL of an Ollama server used through its native API (no key needed). For Ollama via the OpenAI-compatible
            route, use the section above instead.
          </Text>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <DecoratedInput
              className={{ container: 'w-80' }}
              placeholder="http://localhost:11434 (empty = not used)"
              value={ollamaUrl}
              onChange={setOllamaUrl}
              onEnter={() => void saveOllamaUrl()}
              disabled={busy}
            />
            <Button
              label={savingSection === 'ollama' ? 'Saving…' : 'Save URL'}
              onClick={() => void saveOllamaUrl()}
              disabled={busy}
            />
          </div>
        </div>
      </PreferencesSegment>

      <HorizontalSeparator classes="my-4" />

      {/* Limits */}
      <PreferencesSegment>
        <div className="flex items-center gap-2">
          <Title>Limits</Title>
          <SourceChip sources={sources} keys={['ai.dailyRequestLimit', 'dailyRequestLimit']} />
        </div>
        <Text className="mt-1">
          Server-wide daily AI request limit per user. 0 or empty means unlimited. Per-user allowances (AI enabled,
          per-user request limit) are managed on the Users tab.
        </Text>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <DecoratedInput
            className={{ container: 'w-40' }}
            type="number"
            placeholder="Unlimited"
            value={dailyLimit}
            onChange={setDailyLimit}
            onEnter={() => void saveDailyLimit()}
            disabled={busy}
          />
          <Button
            label={savingSection === 'limit' ? 'Saving…' : 'Save limit'}
            onClick={() => void saveDailyLimit()}
            disabled={busy}
          />
        </div>
      </PreferencesSegment>

      <HorizontalSeparator classes="my-4" />

      {/* Read-only context */}
      <PreferencesSegment>
        <Title>Subscription pairing</Title>
        <div className="mt-2 flex items-center justify-between gap-2">
          <Text>
            ChatGPT/Codex subscription pairing
            {ai?.subscriptionMode ? ` — mode: ${ai.subscriptionMode}` : ''}
            {pairingStatus?.paired && pairingStatus.accountLabel ? ` (${pairingStatus.accountLabel})` : ''}
          </Text>
          <span
            className={`inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs font-bold ${
              pairingStatus?.paired ? 'bg-success text-success-contrast' : 'bg-passive-4 text-foreground'
            }`}
          >
            {pairingStatus === null ? 'Unknown' : pairingStatus.paired ? 'Paired' : 'Not paired'}
          </span>
        </div>
        <Text className="mt-2 text-xs">
          Pairing is managed in Preferences → Assistant. Per-user AI access (the AI enabled flag and per-user request
          limits) is managed on this pane's Users tab.
        </Text>
      </PreferencesSegment>
    </>
  )
}

export default AdminAiTab
