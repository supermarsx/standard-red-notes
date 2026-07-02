import { FunctionComponent, ReactNode, useCallback, useEffect, useState } from 'react'
import { isErrorResponse } from '@standardnotes/snjs'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import Switch from '@/Components/Switch/Switch'
import DecoratedInput from '@/Components/Input/DecoratedInput'
import Spinner from '@/Components/Spinner/Spinner'
import { ToastType, addToast } from '@standardnotes/toast'
import {
  AdminServerSettings,
  AdminServerSettingsResponse,
  ServerService,
  buildUrlSettingUpdate,
  serviceStatusChipClass,
  serviceStatusLabel,
  settingSource,
  settingSourceChipClass,
  settingSourceLabel,
} from './adminHelpers'

type Props = {
  application: WebApplication
  noteIfForbidden: (response: { status?: number }) => void
}

type ServerStatus = {
  services?: ServerService[]
  masterSwitches?: {
    ocrServerEnabled?: boolean
    workflowsEnabled?: boolean
    assistantConfigured?: boolean
    assistantProviders?: string[]
    updateCheckConfigured?: boolean
    currentVersion?: string | null
  }
  health?: {
    gateway?: { redis?: boolean | null }
    auth?: { reachable?: boolean; status?: string; checks?: Record<string, boolean> }
  }
}

type EnvFlags = {
  registrationDisabled: boolean | null
  nextcloudBackupsEnabled: boolean | null
}

/** Small colored state chip: green = healthy/on, red = down/off, neutral = unknown. */
const StateChip: FunctionComponent<{ state: boolean | null | undefined; on?: string; off?: string; unknown?: string }> =
  ({ state, on = 'OK', off = 'Down', unknown = 'Unknown' }) => {
    const className =
      state === true
        ? 'bg-success text-success-contrast'
        : state === false
          ? 'bg-danger text-danger-contrast'
          : 'bg-passive-4 text-foreground'
    return (
      <span className={`inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs font-bold ${className}`}>
        {state === true ? on : state === false ? off : unknown}
      </span>
    )
  }

/**
 * One status row in a vertical list: name (with optional small subtext) on the
 * left, a colored status chip on the right. Rows are stacked one per line and
 * separated by dividers via the parent's `divide-y`.
 */
const StatusRow: FunctionComponent<{ name: ReactNode; detail?: ReactNode; chip: ReactNode; indent?: boolean }> = ({
  name,
  detail,
  chip,
  indent,
}) => (
  <div className={`flex items-center justify-between gap-4 py-2 ${indent ? 'pl-4' : ''}`}>
    <div className="flex min-w-0 flex-col">
      <Text>{name}</Text>
      {detail ? <Text className="text-xs text-passive-1">{detail}</Text> : null}
    </div>
    <div className="shrink-0">{chip}</div>
  </div>
)

/** Small env/persisted/default chip for the editable server settings rows. */
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

const AdminServerTab: FunctionComponent<Props> = ({ application, noteIfForbidden }) => {
  // Instance-wide switches. Loaded lazily: this component only mounts when the
  // Server tab is opened.
  const [registrationDisabled, setRegistrationDisabled] = useState(false)
  const [registrationLoading, setRegistrationLoading] = useState(false)
  // Read-only env master switches held by the auth server, riding along on the
  // registration read. null = the server did not report them (older server).
  const [envFlags, setEnvFlags] = useState<EnvFlags>({ registrationDisabled: null, nextcloudBackupsEnabled: null })

  // Read-only gateway status: env master switches + gateway/auth health.
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)

  // Editable server settings (update-check URL, Nextcloud backups master
  // switch) from /v1/admin/server-settings. A 404 (older server) hides the
  // whole section behind a "not available" note.
  const [serverSettings, setServerSettings] = useState<AdminServerSettings | null>(null)
  const [settingsSources, setSettingsSources] = useState<Record<string, string> | null>(null)
  const [settingsLoading, setSettingsLoading] = useState(false)
  const [settingsNotAvailable, setSettingsNotAvailable] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [updateCheckUrl, setUpdateCheckUrl] = useState('')
  const [settingsSaving, setSettingsSaving] = useState(false)

  const loadRegistrationFlag = useCallback(async () => {
    setRegistrationLoading(true)
    try {
      const response = await application.legacyApi.adminGetRegistrationFlag()
      if (!isErrorResponse(response)) {
        const data = (
          response as {
            data?: {
              registrationDisabled?: boolean
              env?: { registrationDisabled?: boolean | null; nextcloudBackupsEnabled?: boolean | null }
            }
          }
        ).data
        setRegistrationDisabled(Boolean(data?.registrationDisabled))
        setEnvFlags({
          registrationDisabled: data?.env?.registrationDisabled ?? null,
          nextcloudBackupsEnabled: data?.env?.nextcloudBackupsEnabled ?? null,
        })
      } else {
        noteIfForbidden(response)
      }
    } catch (error) {
      console.error(error)
    } finally {
      setRegistrationLoading(false)
    }
  }, [application, noteIfForbidden])

  const loadServerStatus = useCallback(async () => {
    setStatusLoading(true)
    setStatusError(null)
    try {
      const response = await application.legacyApi.adminGetServerStatus()
      if (isErrorResponse(response)) {
        noteIfForbidden(response)
        setStatusError('Could not load server status. The endpoint may not be available on this server.')
        return
      }
      setServerStatus((response as { data?: ServerStatus }).data ?? null)
    } catch (error) {
      console.error(error)
      setStatusError('Could not load server status.')
    } finally {
      setStatusLoading(false)
    }
  }, [application, noteIfForbidden])

  const applySettingsView = useCallback((data: AdminServerSettingsResponse | undefined) => {
    setServerSettings(data?.settings ?? null)
    setSettingsSources(data?.sources ?? null)
    setUpdateCheckUrl(data?.settings?.updateCheck?.url ?? '')
  }, [])

  const loadServerSettings = useCallback(async () => {
    setSettingsLoading(true)
    setSettingsError(null)
    try {
      const response = await application.legacyApi.adminGetServerSettings()
      if (isErrorResponse(response)) {
        noteIfForbidden(response)
        // The snjs HttpStatusCode enum has no NotFound member; compare numerically.
        if (Number(response.status) === 404) {
          setSettingsNotAvailable(true)
        } else {
          setSettingsError('Could not load the editable server settings.')
        }
        return
      }
      setSettingsNotAvailable(false)
      applySettingsView((response as { data?: AdminServerSettingsResponse }).data)
    } catch (error) {
      console.error(error)
      setSettingsError('Could not load the editable server settings.')
    } finally {
      setSettingsLoading(false)
    }
  }, [application, noteIfForbidden, applySettingsView])

  useEffect(() => {
    void loadRegistrationFlag()
    void loadServerStatus()
    void loadServerSettings()
  }, [loadRegistrationFlag, loadServerStatus, loadServerSettings])

  /** PUT a partial server-settings update and re-apply the returned view. */
  const saveServerSettings = useCallback(
    async (
      partial: Parameters<WebApplication['legacyApi']['adminSetServerSettings']>[0],
      successMessage: string,
    ): Promise<boolean> => {
      setSettingsSaving(true)
      try {
        const response = await application.legacyApi.adminSetServerSettings(partial)
        if (isErrorResponse(response)) {
          noteIfForbidden(response)
          addToast({ type: ToastType.Error, message: 'Failed to save the server setting.' })
          return false
        }
        applySettingsView((response as { data?: AdminServerSettingsResponse }).data)
        addToast({ type: ToastType.Success, message: successMessage })
        return true
      } catch (error) {
        console.error(error)
        addToast({ type: ToastType.Error, message: 'Failed to save the server setting.' })
        return false
      } finally {
        setSettingsSaving(false)
      }
    },
    [application, noteIfForbidden, applySettingsView],
  )

  const saveUpdateCheckUrl = useCallback(async () => {
    const update = buildUrlSettingUpdate(updateCheckUrl)
    if (!update.ok) {
      addToast({ type: ToastType.Error, message: update.error })
      return
    }
    await saveServerSettings(
      { updateCheck: { url: update.value } },
      update.value === null ? 'Update check URL cleared.' : 'Update check URL saved.',
    )
  }, [updateCheckUrl, saveServerSettings])

  const toggleNextcloudBackups = useCallback(
    async (nextValue: boolean) => {
      await saveServerSettings(
        { nextcloudBackups: { enabled: nextValue } },
        nextValue ? 'Nextcloud backups enabled server-wide.' : 'Nextcloud backups disabled server-wide.',
      )
    },
    [saveServerSettings],
  )

  const toggleRegistration = useCallback(
    async (nextValue: boolean) => {
      const previous = registrationDisabled
      setRegistrationDisabled(nextValue)
      try {
        const response = await application.legacyApi.adminSetRegistrationFlag(nextValue)
        if (isErrorResponse(response)) {
          setRegistrationDisabled(previous)
          addToast({ type: ToastType.Error, message: 'Failed to update registration setting.' })
        }
      } catch (error) {
        console.error(error)
        setRegistrationDisabled(previous)
        addToast({ type: ToastType.Error, message: 'Failed to update registration setting.' })
      }
    },
    [application, registrationDisabled],
  )

  const masterSwitches = serverStatus?.masterSwitches
  const gatewayRedis = serverStatus?.health?.gateway?.redis
  const auth = serverStatus?.health?.auth
  const services = serverStatus?.services ?? []

  return (
    <>
      <PreferencesSegment>
        <Title>Registration</Title>
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-col">
            <Subtitle>Disable new signups</Subtitle>
            <Text>
              When enabled, new users cannot register on this instance. Note: enforcement at signup currently also
              depends on the server's DISABLE_USER_REGISTRATION configuration
              {envFlags.registrationDisabled !== null && (
                <>
                  {' '}
                  (currently <strong>{envFlags.registrationDisabled ? 'set — signups blocked' : 'not set'}</strong> in
                  the environment)
                </>
              )}
              .
            </Text>
          </div>
          {registrationLoading ? (
            <Spinner className="h-5 w-5" />
          ) : (
            <Switch checked={registrationDisabled} onChange={(checked) => void toggleRegistration(checked)} />
          )}
        </div>
      </PreferencesSegment>

      <HorizontalSeparator classes="my-4" />

      <PreferencesSegment>
        <div className="flex items-center justify-between gap-2">
          <Title>Server health</Title>
          <Button label="Refresh" onClick={() => void loadServerStatus()} disabled={statusLoading} />
        </div>
        <Text>
          Live reachability of the server's core dependencies, probed on request. The API gateway itself is reachable
          (this page loaded through it).
        </Text>
        {statusLoading ? (
          <Spinner className="mt-3 h-5 w-5" />
        ) : statusError ? (
          <Text className="mt-3 text-danger">{statusError}</Text>
        ) : serverStatus ? (
          <div className="mt-3 flex flex-col">
            {/* Dependency states: one per line, chip aligned right. */}
            <div className="divide-y divide-border rounded border border-border px-3">
              <StatusRow
                name="Auth server"
                detail="Accounts, sessions, settings"
                chip={<StateChip state={auth ? Boolean(auth.reachable) : null} on="Reachable" off="Unreachable" />}
              />
              {auth?.reachable && auth.checks && 'db' in auth.checks && (
                <StatusRow name="Database" indent chip={<StateChip state={auth.checks.db} />} />
              )}
              {auth?.reachable && auth.checks && 'redis' in auth.checks && (
                <StatusRow name="Cache (Redis)" indent chip={<StateChip state={auth.checks.redis} />} />
              )}
              <StatusRow
                name="Gateway cache (Redis)"
                chip={<StateChip state={gatewayRedis ?? null} unknown="Not configured" />}
              />
            </div>

            {services.length > 0 && (
              <>
                <Subtitle className="mb-2 mt-4">All services</Subtitle>
                <div className="divide-y divide-border rounded border border-border px-3">
                  {services.map((service) => (
                    <StatusRow
                      key={service.name}
                      name={service.name}
                      detail={service.detail}
                      chip={
                        <span
                          className={`inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs font-bold ${serviceStatusChipClass(
                            service.status,
                          )}`}
                        >
                          {serviceStatusLabel(service.status)}
                        </span>
                      }
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        ) : null}
      </PreferencesSegment>

      <HorizontalSeparator classes="my-4" />

      <PreferencesSegment>
        <Title>Feature master switches</Title>
        <Text>
          Read-only view of the operator-level switches configured in the server's environment. Per-user access is
          managed on the Users tab; a feature is live for a user only when BOTH the master switch and the user's flag
          allow it. Changing these requires editing the server environment and redeploying.
        </Text>
        {statusLoading ? (
          <Spinner className="mt-3 h-5 w-5" />
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <Text>Server-side OCR (OCR_SERVER_ENABLED)</Text>
              <StateChip state={masterSwitches ? Boolean(masterSwitches.ocrServerEnabled) : null} on="On" off="Off" />
            </div>
            <div className="flex items-center justify-between gap-2">
              <Text>Workflows / n8n (WORKFLOWS_ENABLED)</Text>
              <StateChip state={masterSwitches ? Boolean(masterSwitches.workflowsEnabled) : null} on="On" off="Off" />
            </div>
            <div className="flex items-center justify-between gap-2">
              <Text>
                AI assistant providers
                {masterSwitches?.assistantConfigured && masterSwitches.assistantProviders?.length
                  ? ` (${masterSwitches.assistantProviders.join(', ')})`
                  : ''}
              </Text>
              <StateChip
                state={masterSwitches ? Boolean(masterSwitches.assistantConfigured) : null}
                on="Configured"
                off="Not configured"
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <Text>
                Update check (UPDATE_CHECK_URL)
                {masterSwitches?.currentVersion ? ` — current version ${masterSwitches.currentVersion}` : ''}
              </Text>
              <StateChip
                state={masterSwitches ? Boolean(masterSwitches.updateCheckConfigured) : null}
                on="Configured"
                off="Not configured"
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <Text>Nextcloud backups (NEXTCLOUD_BACKUPS_ENABLED)</Text>
              <StateChip state={envFlags.nextcloudBackupsEnabled} on="On" off="Off" />
            </div>
          </div>
        )}
      </PreferencesSegment>

      <HorizontalSeparator classes="my-4" />

      <PreferencesSegment>
        <Title>Server settings</Title>
        <Text>
          Editable, persisted server settings. A saved value <strong>overrides the environment variable</strong> until
          it is cleared; the chip next to each setting shows where its active value comes from.
        </Text>
        {settingsLoading ? (
          <Spinner className="mt-3 h-5 w-5" />
        ) : settingsNotAvailable ? (
          <Text className="mt-3">
            Editable server settings are not available on this server (the /v1/admin/server-settings endpoint is
            missing). Update the server to manage the update-check URL and Nextcloud backups from here.
          </Text>
        ) : settingsError ? (
          <>
            <Text className="mt-3 text-danger">{settingsError}</Text>
            <div className="mt-2">
              <Button label="Retry" onClick={() => void loadServerSettings()} />
            </div>
          </>
        ) : (
          <div className="mt-3 flex flex-col gap-4">
            <div>
              <div className="flex items-center gap-2">
                <Subtitle>Update check URL</Subtitle>
                <SourceChip sources={settingsSources} keys={['updateCheck.url', 'updateCheckUrl']} />
              </div>
              <Text className="mt-1 text-xs">
                Where the server looks for new releases; used by Preferences → General → Updates. Leave empty and save
                to clear the override.
              </Text>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <DecoratedInput
                  className={{ container: 'w-96 max-w-full' }}
                  placeholder="https://example.com/releases.json"
                  value={updateCheckUrl}
                  onChange={setUpdateCheckUrl}
                  onEnter={() => void saveUpdateCheckUrl()}
                  disabled={settingsSaving}
                />
                <Button
                  label={settingsSaving ? 'Saving…' : 'Save'}
                  onClick={() => void saveUpdateCheckUrl()}
                  disabled={settingsSaving}
                />
              </div>
            </div>

            <div className="flex items-center justify-between gap-4">
              <div className="flex min-w-0 flex-col">
                <div className="flex items-center gap-2">
                  <Subtitle>Nextcloud backups</Subtitle>
                  <SourceChip sources={settingsSources} keys={['nextcloudBackups.enabled', 'nextcloudBackupsEnabled']} />
                </div>
                <Text className="mt-1 text-xs">
                  Master switch for scheduled Nextcloud backups on this instance. Per-user opt-ins still apply: a
                  user's backups run only when this switch AND their own opt-in are enabled (see the Users tab).
                </Text>
              </div>
              {settingsSaving ? (
                <Spinner className="h-5 w-5 shrink-0" />
              ) : (
                <Switch
                  checked={Boolean(serverSettings?.nextcloudBackups?.enabled)}
                  onChange={(checked) => void toggleNextcloudBackups(checked)}
                />
              )}
            </div>
          </div>
        )}
      </PreferencesSegment>
    </>
  )
}

export default AdminServerTab
