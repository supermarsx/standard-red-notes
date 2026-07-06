import { FunctionComponent, ReactNode, useCallback, useEffect, useState } from 'react'
import { isErrorResponse } from '@standardnotes/snjs'
import { confirmDialog } from '@standardnotes/ui-services'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import Switch from '@/Components/Switch/Switch'
import DecoratedInput from '@/Components/Input/DecoratedInput'
import Dropdown from '@/Components/Dropdown/Dropdown'
import Spinner from '@/Components/Spinner/Spinner'
import { ToastType, addToast } from '@standardnotes/toast'
import {
  AdminServerSettings,
  AdminServerSettingsResponse,
  DockerControl,
  ServerService,
  ServiceControlAction,
  WS_GATEWAY_SERVICE,
  buildUrlSettingUpdate,
  dockerContainerLabel,
  dockerRestartDialogCopy,
  formatServiceLatency,
  serviceActionDialogCopy,
  serviceActionIsSelfInterrupting,
  serviceActionPastTense,
  serviceControlProgramFor,
  serviceLatencyClass,
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

// Standard Red Notes: friendly labels for the assignable default-registration
// roles (must match the server's canonical role labels). Any unknown role name
// falls back to the raw value so a server revision cannot blank the selector.
const REGISTRATION_ROLE_LABELS: Record<string, string> = {
  CORE_USER: 'Core user',
  PRO_USER: 'Full user',
  VAULTS_USER: 'Vaults user',
}
const registrationRoleLabel = (role: string): string => REGISTRATION_ROLE_LABELS[role] ?? role

const REGISTRATION_DOMAIN_MODE_ITEMS = [
  { label: 'Off — allow any email domain', value: 'off' },
  { label: 'Allowlist — only listed domains may register', value: 'allowlist' },
  { label: 'Blocklist — listed domains may not register', value: 'blocklist' },
]

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

  // Service lifecycle control (restart/stop/start). `supported` is false when the
  // endpoint 404s (older image without the feature); `available` is false when the
  // endpoint exists but supervisorctl cannot reach supervisord (image predates the
  // supervisord socket conf). Controls are only shown for programs in `programs`.
  const [controllablePrograms, setControllablePrograms] = useState<string[]>([])
  const [serviceControlAvailable, setServiceControlAvailable] = useState(false)
  const [serviceControlSupported, setServiceControlSupported] = useState(true)
  // Key of the in-flight action, `${name}:${action}`, or null. Disables that row.
  const [serviceActionInFlight, setServiceActionInFlight] = useState<string | null>(null)
  // Standard Red Notes: OPT-IN, off-by-default container restart (Redis/DB via the
  // docker-socket-proxy). null until the /services call returns; controls appear
  // only when `available` is true. `container:${name}` is the in-flight key.
  const [dockerControl, setDockerControl] = useState<DockerControl | null>(null)
  const [containerActionInFlight, setContainerActionInFlight] = useState<string | null>(null)

  // Editable server settings (update-check URL, Nextcloud backups master
  // switch) from /v1/admin/server-settings. A 404 (older server) hides the
  // whole section behind a "not available" note.
  const [serverSettings, setServerSettings] = useState<AdminServerSettings | null>(null)
  const [settingsSources, setSettingsSources] = useState<Record<string, string> | null>(null)
  const [settingsLoading, setSettingsLoading] = useState(false)
  const [settingsNotAvailable, setSettingsNotAvailable] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [updateCheckUrl, setUpdateCheckUrl] = useState('')
  // Standard Red Notes: editable registration policy. The default role + mode are
  // saved immediately on change; the domain list is edited free-form (one per
  // line or comma-separated) and saved with its own button.
  const [domainListText, setDomainListText] = useState('')
  // Standard Red Notes: EMAIL CONFIRMATION (part 2) editable fields. The subject /
  // body / base URL are edited free-form and saved with a button; enable + gating
  // save immediately on change.
  const [confirmationSubject, setConfirmationSubject] = useState('')
  const [confirmationBody, setConfirmationBody] = useState('')
  const [confirmationBaseUrl, setConfirmationBaseUrl] = useState('')
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

  const loadControllableServices = useCallback(async () => {
    try {
      const response = await application.legacyApi.adminListServices()
      if (isErrorResponse(response)) {
        noteIfForbidden(response)
        // A 404 means the server predates the feature — hide controls entirely.
        if (Number(response.status) === 404) {
          setServiceControlSupported(false)
          setServiceControlAvailable(false)
          setControllablePrograms([])
        }
        return
      }
      const data = (
        response as {
          data?: {
            available?: boolean
            programs?: string[]
            docker?: { enabled?: boolean; available?: boolean; containers?: string[] }
          }
        }
      ).data
      setServiceControlSupported(true)
      setServiceControlAvailable(Boolean(data?.available))
      setControllablePrograms(Array.isArray(data?.programs) ? (data?.programs as string[]) : [])
      // The docker block is optional (older servers omit it) — default to off.
      setDockerControl({
        enabled: Boolean(data?.docker?.enabled),
        available: Boolean(data?.docker?.available),
        containers: Array.isArray(data?.docker?.containers) ? (data?.docker?.containers as string[]) : [],
      })
    } catch (error) {
      console.error(error)
    }
  }, [application, noteIfForbidden])

  const runServiceAction = useCallback(
    async (name: string, action: ServiceControlAction) => {
      const { title, text, confirmButtonText } = serviceActionDialogCopy(name, action)
      const confirmed = await confirmDialog({ title, text, confirmButtonText, confirmButtonStyle: 'danger' })
      if (!confirmed) {
        return
      }

      const selfInterrupt = serviceActionIsSelfInterrupting(name, action)
      // The in-process WebSocket gateway maps to the api-gateway PROGRAM under the
      // hood (it runs inside that process); every other row is identity.
      const program = serviceControlProgramFor(name)
      const key = `${name}:${action}`
      setServiceActionInFlight(key)
      try {
        const response = await application.legacyApi.adminControlService(program, action, {
          confirmSelfInterrupt: selfInterrupt,
        })
        if (isErrorResponse(response)) {
          noteIfForbidden(response)
          if (Number(response.status) === 404) {
            setServiceControlSupported(false)
            addToast({ type: ToastType.Error, message: 'Service control is not available on this server.' })
            return
          }
          const message =
            (response as { data?: { error?: { message?: string } } }).data?.error?.message ??
            `Failed to ${action} ${name}.`
          addToast({ type: ToastType.Error, message })
          return
        }

        if (selfInterrupt) {
          addToast({
            type: ToastType.Success,
            message: 'API gateway restart requested — your connection will drop briefly. Reload the page in a moment.',
          })
        } else {
          addToast({ type: ToastType.Success, message: `${serviceActionPastTense(action)} ${name}.` })
          // Refresh the status + availability now that the process changed state.
          void loadServerStatus()
          void loadControllableServices()
        }
      } catch (error) {
        console.error(error)
        addToast({ type: ToastType.Error, message: `Failed to ${action} ${name}.` })
      } finally {
        setServiceActionInFlight(null)
      }
    },
    [application, noteIfForbidden, loadServerStatus, loadControllableServices],
  )

  // Standard Red Notes: restart an infrastructure CONTAINER (Redis/DB) through the
  // opt-in docker-socket-proxy. Danger-confirmed; a 503 (capability disabled or
  // proxy unreachable) degrades to a clear toast, never a crash.
  const runContainerRestart = useCallback(
    async (name: string) => {
      const { title, text, confirmButtonText } = dockerRestartDialogCopy(name)
      const confirmed = await confirmDialog({ title, text, confirmButtonText, confirmButtonStyle: 'danger' })
      if (!confirmed) {
        return
      }

      const key = `container:${name}`
      setContainerActionInFlight(key)
      try {
        const response = await application.legacyApi.adminRestartContainer(name)
        if (isErrorResponse(response)) {
          noteIfForbidden(response)
          const message =
            (response as { data?: { error?: { message?: string } } }).data?.error?.message ??
            `Failed to restart ${dockerContainerLabel(name)}.`
          addToast({ type: ToastType.Error, message })
          // Re-sync capability so a now-unreachable proxy hides the controls.
          void loadControllableServices()
          return
        }
        addToast({ type: ToastType.Success, message: `Restarted ${dockerContainerLabel(name)}.` })
        void loadServerStatus()
      } catch (error) {
        console.error(error)
        addToast({ type: ToastType.Error, message: `Failed to restart ${dockerContainerLabel(name)}.` })
      } finally {
        setContainerActionInFlight(null)
      }
    },
    [application, noteIfForbidden, loadServerStatus, loadControllableServices],
  )

  const applySettingsView = useCallback((data: AdminServerSettingsResponse | undefined) => {
    setServerSettings(data?.settings ?? null)
    setSettingsSources(data?.sources ?? null)
    setUpdateCheckUrl(data?.settings?.updateCheck?.url ?? '')
    setDomainListText((data?.settings?.registration?.domainList ?? []).join('\n'))
    setConfirmationSubject(data?.settings?.registration?.emailConfirmationSubject ?? '')
    setConfirmationBody(data?.settings?.registration?.emailConfirmationBody ?? '')
    setConfirmationBaseUrl(data?.settings?.registration?.emailConfirmationBaseUrl ?? '')
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
    void loadControllableServices()
  }, [loadRegistrationFlag, loadServerStatus, loadServerSettings, loadControllableServices])

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

  const saveRegistrationDefaultRole = useCallback(
    async (role: string) => {
      await saveServerSettings({ registration: { defaultRole: role } }, 'Default role for new users saved.')
    },
    [saveServerSettings],
  )

  const saveRegistrationDomainMode = useCallback(
    async (mode: string) => {
      await saveServerSettings(
        { registration: { domainMode: mode as 'off' | 'allowlist' | 'blocklist' } },
        'Email-domain policy mode saved.',
      )
    },
    [saveServerSettings],
  )

  const saveRegistrationDomainList = useCallback(async () => {
    const list = domainListText
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
    await saveServerSettings({ registration: { domainList: list } }, 'Email-domain list saved.')
  }, [domainListText, saveServerSettings])

  // Standard Red Notes: EMAIL CONFIRMATION (part 2) save handlers.
  const saveEmailConfirmationEnabled = useCallback(
    async (enabled: boolean) => {
      await saveServerSettings(
        { registration: { emailConfirmationEnabled: enabled } },
        enabled ? 'Email confirmation enabled for new signups.' : 'Email confirmation disabled.',
      )
    },
    [saveServerSettings],
  )

  const saveEmailConfirmationGating = useCallback(
    async (mode: string) => {
      await saveServerSettings(
        { registration: { emailConfirmationGating: mode as 'block_signin' | 'warn' } },
        'Confirmation gating mode saved.',
      )
    },
    [saveServerSettings],
  )

  const saveEmailConfirmationTemplates = useCallback(async () => {
    await saveServerSettings(
      {
        registration: {
          emailConfirmationSubject: confirmationSubject,
          emailConfirmationBody: confirmationBody,
          emailConfirmationBaseUrl: confirmationBaseUrl.trim(),
        },
      },
      'Confirmation email template saved.',
    )
  }, [confirmationSubject, confirmationBody, confirmationBaseUrl, saveServerSettings])

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

            {/* Standard Red Notes: OPT-IN infrastructure container restart (Redis
                cache + MariaDB) via the locked-down docker-socket-proxy. Shown only
                when the capability is enabled AND the proxy is reachable; when
                enabled-but-unreachable it degrades to a muted note (never an error).
                When off (the default) nothing renders. */}
            {dockerControl?.available && dockerControl.containers.length > 0 ? (
              <>
                <Subtitle className="mb-2 mt-4">Infrastructure containers</Subtitle>
                <div className="divide-y divide-border rounded border border-border px-3">
                  {dockerControl.containers.map((container) => {
                    const rowBusy = containerActionInFlight === `container:${container}`
                    return (
                      <div key={container} className="flex items-center justify-between gap-4 py-2">
                        <div className="flex min-w-0 flex-col">
                          <Text>{dockerContainerLabel(container)}</Text>
                          <Text className="text-xs text-passive-1">Restarts the whole container via the docker-socket-proxy</Text>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {rowBusy && <Spinner className="h-4 w-4" />}
                          <Button
                            small
                            colorStyle="danger"
                            label="Restart"
                            disabled={rowBusy}
                            onClick={() => void runContainerRestart(container)}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
                <Text className="mt-2 text-xs text-passive-1">
                  Restarting the database or cache briefly interrupts every service that depends on it.
                </Text>
              </>
            ) : dockerControl?.enabled && !dockerControl.available ? (
              <Text className="mt-3 text-xs text-passive-1">
                Container restart is enabled but the docker-socket-proxy is not reachable, so restarting Redis/MariaDB is
                not available right now.
              </Text>
            ) : null}

            {services.length > 0 && (
              <>
                <Subtitle className="mb-2 mt-4">All services</Subtitle>
                <div className="divide-y divide-border rounded border border-border px-3">
                  {services.map((service) => {
                    const chip = (
                      <span
                        className={`inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs font-bold ${serviceStatusChipClass(
                          service.status,
                        )}`}
                      >
                        {serviceStatusLabel(service.status)}
                      </span>
                    )

                    // Controls only for allowlisted programs when supervisorctl is
                    // actually reachable. The in-process WebSocket gateway maps to
                    // the api-gateway program (serviceControlProgramFor); any other
                    // unknown row simply renders without controls.
                    const program = serviceControlProgramFor(service.name)
                    const isWsGateway = service.name === WS_GATEWAY_SERVICE
                    const canControl =
                      serviceControlSupported && serviceControlAvailable && controllablePrograms.includes(program)
                    const isGateway = program === 'api-gateway'
                    const isDown = service.status === 'down'
                    const rowBusy = serviceActionInFlight !== null && serviceActionInFlight.startsWith(`${service.name}:`)
                    // Friendly label for the in-process WebSocket gateway.
                    const displayName = isWsGateway ? 'WebSocket gateway' : service.name
                    const wsDetail = isWsGateway ? 'Realtime sync — runs inside the API gateway process' : service.detail
                    const latency = formatServiceLatency(service.responseTimeMs)

                    return (
                      <div key={service.name} className="flex items-center justify-between gap-4 py-2">
                        <div className="flex min-w-0 flex-col">
                          <Text>{displayName}</Text>
                          {wsDetail ? <Text className="text-xs text-passive-1">{wsDetail}</Text> : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {latency ? (
                            <span className={`text-xs tabular-nums ${serviceLatencyClass(service.responseTimeMs, service.status)}`}>
                              {latency}
                            </span>
                          ) : null}
                          {chip}
                          {canControl && (
                            <div className="flex items-center gap-1">
                              {rowBusy && <Spinner className="h-4 w-4" />}
                              {/* Start only when a real (non-ws) program is down/stopped. */}
                              {isDown && !isWsGateway && (
                                <Button
                                  small
                                  colorStyle="success"
                                  label="Start"
                                  disabled={rowBusy}
                                  onClick={() => void runServiceAction(service.name, 'start')}
                                />
                              )}
                              <Button
                                small
                                colorStyle="warning"
                                label="Restart"
                                disabled={rowBusy}
                                onClick={() => void runServiceAction(service.name, 'restart')}
                              />
                              {/* Stopping the gateway (or the in-process ws gateway) is
                                  forbidden server-side; hide it. */}
                              {!isGateway && !isDown && (
                                <Button
                                  small
                                  colorStyle="danger"
                                  label="Stop"
                                  disabled={rowBusy}
                                  onClick={() => void runServiceAction(service.name, 'stop')}
                                />
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
                {!serviceControlSupported ? (
                  <Text className="mt-2 text-xs text-passive-1">
                    Service lifecycle controls are not available on this server (the /v1/admin/services endpoint is
                    missing). Update the server image to restart/stop/start services from here.
                  </Text>
                ) : !serviceControlAvailable ? (
                  <Text className="mt-2 text-xs text-passive-1">
                    Service lifecycle controls require a newer server image: supervisorctl cannot reach supervisord on
                    this deployment, so restart/stop/start are disabled.
                  </Text>
                ) : (
                  <Text className="mt-2 text-xs text-passive-1">
                    Restarting a service briefly interrupts what it powers. Restarting the API gateway will drop your
                    admin connection for a few seconds.
                  </Text>
                )}
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

            <HorizontalSeparator classes="my-1" />

            {/* --- Registration policy (default role + email-domain policy) --- */}
            <div className="flex flex-col gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <Subtitle>Default role for new users</Subtitle>
                  <SourceChip sources={settingsSources} keys={['registration.defaultRole']} />
                </div>
                <Text className="mt-1 text-xs">
                  The role assigned to every account created through self-service sign-up. New signups are never given
                  the admin role.
                </Text>
                <div className="mt-2 w-96 max-w-full">
                  <Dropdown
                    label="Default role for new users"
                    items={(serverSettings?.registration?.assignableRoles ?? ['CORE_USER', 'PRO_USER', 'VAULTS_USER']).map(
                      (role) => ({ label: registrationRoleLabel(role), value: role }),
                    )}
                    value={serverSettings?.registration?.defaultRole ?? 'CORE_USER'}
                    onChange={(role) => void saveRegistrationDefaultRole(role)}
                    disabled={settingsSaving}
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center gap-2">
                  <Subtitle>Email-domain policy</Subtitle>
                  <SourceChip sources={settingsSources} keys={['registration.domainMode']} />
                </div>
                <Text className="mt-1 text-xs">
                  Restrict which email domains may sign up. In <strong>allowlist</strong> mode only the listed domains may
                  register; in <strong>blocklist</strong> mode the listed domains are refused. A listed domain also
                  matches its subdomains (e.g. <code>example.com</code> matches <code>mail.example.com</code>). Matching
                  is case-insensitive.
                </Text>
                <div className="mt-2 w-96 max-w-full">
                  <Dropdown
                    label="Email-domain policy mode"
                    items={REGISTRATION_DOMAIN_MODE_ITEMS}
                    value={serverSettings?.registration?.domainMode ?? 'off'}
                    onChange={(mode) => void saveRegistrationDomainMode(mode)}
                    disabled={settingsSaving}
                  />
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <Text className="text-xs font-medium text-passive-1">Domains</Text>
                  <SourceChip sources={settingsSources} keys={['registration.domainList']} />
                </div>
                <textarea
                  className="mt-1 h-24 w-96 max-w-full rounded border border-border bg-default p-2 text-sm text-foreground"
                  placeholder={'example.com\npartner.org'}
                  value={domainListText}
                  onChange={(event) => setDomainListText(event.target.value)}
                  disabled={settingsSaving}
                />
                <Text className="mt-1 text-xs text-passive-1">
                  One domain per line (or comma-separated). The list applies to both allowlist and blocklist modes and is
                  ignored while the mode is Off.
                </Text>
                <div className="mt-2">
                  <Button
                    label={settingsSaving ? 'Saving…' : 'Save domains'}
                    onClick={() => void saveRegistrationDomainList()}
                    disabled={settingsSaving}
                  />
                </div>
              </div>

              {/* Standard Red Notes: EMAIL CONFIRMATION (part 2). OFF by default. */}
              <div className="border-t border-border pt-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Subtitle>Require email confirmation</Subtitle>
                    <SourceChip sources={settingsSources} keys={['registration.emailConfirmationEnabled']} />
                  </div>
                  <Switch
                    checked={Boolean(serverSettings?.registration?.emailConfirmationEnabled)}
                    onChange={(checked) => void saveEmailConfirmationEnabled(checked)}
                  />
                </div>
                <Text className="mt-1 text-xs">
                  When on, a new signup is emailed a single-use verification link and must confirm before the gate below
                  applies. Existing accounts are unaffected (they are treated as already confirmed). Requires SMTP to be
                  configured and the base URL below set so the link is absolute.
                </Text>

                {serverSettings?.registration?.emailConfirmationEnabled && (
                  <div className="mt-4 flex flex-col gap-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <Text className="text-xs font-medium text-passive-1">Gating mode</Text>
                        <SourceChip sources={settingsSources} keys={['registration.emailConfirmationGating']} />
                      </div>
                      <div className="mt-1 w-96 max-w-full">
                        <Dropdown
                          label="Confirmation gating mode"
                          items={(serverSettings?.registration?.gatingModes ?? ['block_signin', 'warn']).map((mode) => ({
                            label: mode === 'block_signin' ? 'Block sign-in until confirmed' : 'Warn only (allow sign-in)',
                            value: mode,
                          }))}
                          value={serverSettings?.registration?.emailConfirmationGating ?? 'block_signin'}
                          onChange={(mode) => void saveEmailConfirmationGating(mode)}
                          disabled={settingsSaving}
                        />
                      </div>
                    </div>

                    <div>
                      <div className="flex items-center gap-2">
                        <Text className="text-xs font-medium text-passive-1">Web app base URL</Text>
                        <SourceChip sources={settingsSources} keys={['registration.emailConfirmationBaseUrl']} />
                      </div>
                      <input
                        type="url"
                        className="mt-1 w-96 max-w-full rounded border border-border bg-default p-2 text-sm text-foreground"
                        placeholder="https://notes.example.com"
                        value={confirmationBaseUrl}
                        onChange={(event) => setConfirmationBaseUrl(event.target.value)}
                        disabled={settingsSaving}
                      />
                    </div>

                    <div>
                      <div className="flex items-center gap-2">
                        <Text className="text-xs font-medium text-passive-1">Email subject</Text>
                        <SourceChip sources={settingsSources} keys={['registration.emailConfirmationSubject']} />
                      </div>
                      <input
                        type="text"
                        className="mt-1 w-96 max-w-full rounded border border-border bg-default p-2 text-sm text-foreground"
                        value={confirmationSubject}
                        onChange={(event) => setConfirmationSubject(event.target.value)}
                        disabled={settingsSaving}
                      />
                    </div>

                    <div>
                      <div className="flex items-center gap-2">
                        <Text className="text-xs font-medium text-passive-1">Email body</Text>
                        <SourceChip sources={settingsSources} keys={['registration.emailConfirmationBody']} />
                      </div>
                      <textarea
                        className="mt-1 h-32 w-96 max-w-full rounded border border-border bg-default p-2 text-sm text-foreground"
                        value={confirmationBody}
                        onChange={(event) => setConfirmationBody(event.target.value)}
                        disabled={settingsSaving}
                      />
                      <Text className="mt-1 text-xs text-passive-1">
                        Use <code>{'{{confirmation_url}}'}</code> where the verification link should appear. If omitted,
                        the link is appended automatically.
                      </Text>
                    </div>

                    <div>
                      <Button
                        label={settingsSaving ? 'Saving…' : 'Save confirmation email'}
                        onClick={() => void saveEmailConfirmationTemplates()}
                        disabled={settingsSaving}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </PreferencesSegment>
    </>
  )
}

export default AdminServerTab
