import { FunctionComponent, useCallback, useEffect, useState } from 'react'
import { isErrorResponse } from '@standardnotes/snjs'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import DecoratedInput from '@/Components/Input/DecoratedInput'
import Spinner from '@/Components/Spinner/Spinner'
import { ToastType, addToast } from '@standardnotes/toast'
import { confirmDialog } from '@standardnotes/ui-services'
import {
  AdminAiProfileView,
  AdminAssignmentsView,
  AdminBackendProfileView,
  AdminServerSettings,
  AdminServerSettingsResponse,
  buildApiKeySettingUpdate,
  buildDailyLimitSettingUpdate,
  buildTokenLimitSettingUpdate,
  buildUrlSettingUpdate,
  settingSource,
  settingSourceChipClass,
  settingSourceLabel,
} from './adminHelpers'
import AiProfilesSection from './AiProfilesSection'
import BackendProfilesSection from './BackendProfilesSection'
import ProfileAssignmentsSection from './ProfileAssignmentsSection'
import CodexPairingWizard from './CodexPairingWizard'
import AdminSubscriptionUsageCard from './AdminSubscriptionUsageCard'
import { AiProfilePayload, MaskedAiProfile } from './aiProfiles'
import { BackendProfilePayload } from './aiBackendProfiles'

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
      className={`inline-block rounded px-2 py-0.5 text-xs font-bold whitespace-nowrap ${settingSourceChipClass(source)}`}
    >
      {settingSourceLabel(source)}
    </span>
  )
}

/** Green/neutral "Configured" badge for a provider whose secret is write-only. */
const ConfiguredBadge: FunctionComponent<{ configured: boolean | undefined }> = ({ configured }) => (
  <span
    className={`inline-block rounded px-2 py-0.5 text-xs font-bold whitespace-nowrap ${
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
  // Standard Red Notes: per-user rolling-window TOKEN limits (0/empty = unlimited).
  const [fiveHourTokenLimit, setFiveHourTokenLimit] = useState('')
  const [weeklyTokenLimit, setWeeklyTokenLimit] = useState('')
  // Standard Red Notes: MULTIPLE named profiles (masked view) + default selector.
  const [profiles, setProfiles] = useState<MaskedAiProfile[]>([])
  const [defaultProfileId, setDefaultProfileId] = useState<string | null>(null)
  // Standard Red Notes: decoupled backend profiles + user/role assignments.
  const [backendProfiles, setBackendProfiles] = useState<AdminBackendProfileView[]>([])
  const [assignments, setAssignments] = useState<AdminAssignmentsView>({ users: {}, roles: {} })

  const [savingSection, setSavingSection] = useState<string | null>(null)

  const applyView = useCallback((data: AdminServerSettingsResponse | undefined) => {
    const next = data?.settings ?? null
    setSettings(next)
    setSources(data?.sources ?? null)
    setOpenaiBaseUrl(next?.ai?.openaiBaseUrl ?? '')
    setOllamaUrl(next?.ai?.ollamaUrl ?? '')
    const limit = next?.ai?.dailyRequestLimit
    setDailyLimit(limit != null && limit > 0 ? String(limit) : '')
    const fiveHour = next?.ai?.fiveHourTokenLimit
    setFiveHourTokenLimit(fiveHour != null && fiveHour > 0 ? String(fiveHour) : '')
    const weekly = next?.ai?.weeklyTokenLimit
    setWeeklyTokenLimit(weekly != null && weekly > 0 ? String(weekly) : '')
    setProfiles((next?.ai?.profiles ?? []) as AdminAiProfileView[] as MaskedAiProfile[])
    setDefaultProfileId(next?.ai?.defaultProfileId ?? null)
    setBackendProfiles((next?.ai?.backendProfiles ?? []) as AdminBackendProfileView[])
    setAssignments(next?.ai?.assignments ?? { users: {}, roles: {} })
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
  }, [load])

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

  // Standard Red Notes: persist the whole named-profiles set + default via the
  // existing server-settings PUT (ai.profiles / ai.defaultProfileId). The payload
  // type on legacyApi predates profiles, so we widen it at the call boundary.
  const saveProfiles = useCallback(
    async (update: { profiles: AiProfilePayload[]; defaultProfileId: string | null }): Promise<boolean> => {
      return save('profiles', { ai: update } as unknown as ServerSettingsPartial, 'Assistant profiles saved.')
    },
    [save],
  )

  // Standard Red Notes: persist the decoupled backend profiles + assignments via
  // the same server-settings PUT. The legacyApi payload type predates them, so we
  // widen at the call boundary (as elsewhere in this tab).
  const saveBackendProfiles = useCallback(
    async (update: { backendProfiles: BackendProfilePayload[] }): Promise<boolean> => {
      return save('backend-profiles', { ai: update } as unknown as ServerSettingsPartial, 'Backend profiles saved.')
    },
    [save],
  )

  const saveAssignments = useCallback(
    async (update: { assignments: AdminAssignmentsView }): Promise<boolean> => {
      return save('assignments', { ai: update } as unknown as ServerSettingsPartial, 'Profile assignments saved.')
    },
    [save],
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

  const saveFiveHourTokenLimit = useCallback(async () => {
    const update = buildTokenLimitSettingUpdate(fiveHourTokenLimit)
    if (!update.ok) {
      addToast({ type: ToastType.Error, message: update.error })
      return
    }
    await save(
      'five-hour-tokens',
      { ai: { fiveHourTokenLimit: update.value } } as unknown as ServerSettingsPartial,
      update.value === null ? '5-hour token limit removed (unlimited).' : '5-hour token limit saved.',
    )
  }, [fiveHourTokenLimit, save])

  const saveWeeklyTokenLimit = useCallback(async () => {
    const update = buildTokenLimitSettingUpdate(weeklyTokenLimit)
    if (!update.ok) {
      addToast({ type: ToastType.Error, message: update.error })
      return
    }
    await save(
      'weekly-tokens',
      { ai: { weeklyTokenLimit: update.value } } as unknown as ServerSettingsPartial,
      update.value === null ? 'Weekly token limit removed (unlimited).' : 'Weekly token limit saved.',
    )
  }, [weeklyTokenLimit, save])

  // Only show the full-page spinner on the INITIAL load, when there is nothing to
  // render yet. Later reloads (Refresh, or a pairing transition from a child) keep
  // the already-rendered content mounted and update it in place, so the pane never
  // unmounts+remounts its children and flashes back to a bare spinner.
  if (loading && settings === null && !notAvailable && !loadError) {
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
          Server-side AI configuration is not available on this server. Update the server to a version that provides the
          /v1/admin/server-settings endpoint to manage AI providers from here.
        </Text>
      </PreferencesSegment>
    )
  }

  if (loadError) {
    return (
      <PreferencesSegment>
        <Title>AI configuration</Title>
        <Text className="text-danger mt-2">{loadError}</Text>
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
          Server-wide AI provider settings for the assistant. API keys are write-only: the server reports only whether a
          key is configured and never returns the key itself. Values saved here are persisted on the server and{' '}
          <strong>override the corresponding environment variables</strong>; use Clear to remove an override and fall
          back to the environment value.
        </Text>
      </PreferencesSegment>

      <HorizontalSeparator classes="my-4" />

      {/* Standard Red Notes: decoupled backend (provider/connection) profiles */}
      <BackendProfilesSection backendProfiles={backendProfiles} busy={busy} onSave={saveBackendProfiles} />

      {/* Standard Red Notes: MULTIPLE named profiles (may reference a backend) */}
      <AiProfilesSection
        application={application}
        profiles={profiles}
        defaultProfileId={defaultProfileId}
        backendProfiles={backendProfiles}
        busy={busy}
        onSave={saveProfiles}
      />

      {/* Standard Red Notes: assign profiles to users/roles (user > role > default) */}
      <ProfileAssignmentsSection profiles={profiles} assignments={assignments} busy={busy} onSave={saveAssignments} />

      {/* Guided ChatGPT / Codex subscription pairing wizard (supports MULTIPLE) */}
      <CodexPairingWizard application={application} onStatusChange={() => void load()} />

      {/* SRN-side metered subscription token usage per subscription (admin) */}
      <AdminSubscriptionUsageCard application={application} onChange={() => void load()} />

      <HorizontalSeparator classes="my-4" />

      <PreferencesSegment>
        <Subtitle>Single-provider settings (back-compatible)</Subtitle>
        <Text className="text-passive-1 mt-1">
          The original per-provider fields below still work and map to a default profile when no named profiles are
          defined. Prefer the profiles above for multiple providers.
        </Text>
      </PreferencesSegment>

      {/* Anthropic */}
      <PreferencesSegment>
        <div className="border-border rounded border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Subtitle>Anthropic (Claude)</Subtitle>
            <div className="flex items-center gap-2">
              <SourceChip sources={sources} keys={['ai.anthropicApiKey', 'anthropicApiKey']} />
              <ConfiguredBadge configured={ai?.anthropicConfigured} />
            </div>
          </div>
          <Text className="mt-1">
            API key for Anthropic's Claude models. Set a new key below to save (or replace) it; the current key is never
            displayed.
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
        <div className="border-border rounded border p-4">
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
              Examples: LM Studio <code>http://localhost:1234/v1</code>, Ollama <code>http://localhost:11434/v1</code>,
              OpenRouter <code>https://openrouter.ai/api/v1</code>. Leave empty and save to clear the override.
            </Text>
          </div>
        </div>
      </PreferencesSegment>

      {/* Ollama native */}
      <PreferencesSegment>
        <div className="border-border rounded border p-4">
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

        <div className="mt-4 flex items-center gap-2">
          <Subtitle>Token limits (per user)</Subtitle>
          <SourceChip sources={sources} keys={['ai.fiveHourTokenLimit', 'fiveHourTokenLimit']} />
          <SourceChip sources={sources} keys={['ai.weeklyTokenLimit', 'weeklyTokenLimit']} />
        </div>
        <Text className="mt-1">
          Per-user AI token ceilings over rolling windows. A request is refused before it starts once the user is at or
          over either window (an in-flight request is never cut off). 0 or empty means unlimited. Real provider usage
          tokens are counted when the provider reports them; otherwise usage is estimated from message length.
        </Text>
        <div className="mt-3 flex flex-wrap items-end gap-4">
          <div>
            <div className="text-passive-1 mb-1 text-sm">5-hour window (tokens)</div>
            <div className="flex flex-wrap items-center gap-2">
              <DecoratedInput
                className={{ container: 'w-40' }}
                type="number"
                placeholder="Unlimited"
                value={fiveHourTokenLimit}
                onChange={setFiveHourTokenLimit}
                onEnter={() => void saveFiveHourTokenLimit()}
                disabled={busy}
              />
              <Button
                label={savingSection === 'five-hour-tokens' ? 'Saving…' : 'Save'}
                onClick={() => void saveFiveHourTokenLimit()}
                disabled={busy}
              />
            </div>
          </div>
          <div>
            <div className="text-passive-1 mb-1 text-sm">Weekly window (tokens)</div>
            <div className="flex flex-wrap items-center gap-2">
              <DecoratedInput
                className={{ container: 'w-40' }}
                type="number"
                placeholder="Unlimited"
                value={weeklyTokenLimit}
                onChange={setWeeklyTokenLimit}
                onEnter={() => void saveWeeklyTokenLimit()}
                disabled={busy}
              />
              <Button
                label={savingSection === 'weekly-tokens' ? 'Saving…' : 'Save'}
                onClick={() => void saveWeeklyTokenLimit()}
                disabled={busy}
              />
            </div>
          </div>
        </div>
      </PreferencesSegment>
    </>
  )
}

export default AdminAiTab
