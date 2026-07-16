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
import Icon from '@/Components/Icon/Icon'
import TabList from '@/Components/Tabs/TabList'
import Tab from '@/Components/Tabs/Tab'
import TabPanel from '@/Components/Tabs/TabPanel'
import { useTabState } from '@/Components/Tabs/useTabState'
import { ToastType, addToast } from '@standardnotes/toast'
import {
  AdminInviteLinkCreated,
  AdminInviteLinkView,
  AdminPendingUserRow,
  AdminServerSettings,
  AdminServerSettingsResponse,
  CreateInviteLinkForm,
  DockerControl,
  LOG_LEVEL_OPTIONS,
  ServerService,
  ServiceControlAction,
  WS_GATEWAY_SERVICE,
  buildCreateInviteLinkBody,
  buildInvitesPerUserUpdate,
  buildMaxTotalAccountsUpdate,
  buildSignupCapUpdate,
  buildSignupWindowUpdate,
  buildUrlSettingUpdate,
  datetimeLocalUtcToISO,
  dockerContainerLabel,
  dockerRestartDialogCopy,
  emptyCreateInviteLinkForm,
  formatInviteLinkDate,
  formatServiceLatency,
  formatUtcClock,
  inviteLinkAbsoluteUrl,
  inviteLinkStatusChipClass,
  inviteLinkStatusLabel,
  inviteLinkUsesLabel,
  isoToDatetimeLocalUtc,
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

// The snjs client's PUT param type for /v1/admin/server-settings.
type AdminSetServerSettingsPartial = Parameters<WebApplication['legacyApi']['adminSetServerSettings']>[0]

// Standard Red Notes (t69): the invite-URL signup-control registration overlay keys
// the gateway already accepts but the snjs param type (a different executor's
// package) does not yet enumerate. We widen the local save-partial with them and
// cast at the adminSetServerSettings boundary.
type ServerSettingsPatch = AdminSetServerSettingsPartial & {
  registration?: {
    inviteOnly?: boolean | null
    approvalRequired?: boolean | null
    maxTotalAccounts?: number | null
    signupsOpenAt?: string | null
    signupsCloseAt?: string | null
    invitesPerUser?: number | null
  }
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
  // Standard Red Notes: read-only forwarded-client-IP config (boot settings). null =
  // built-in default (trust proxy: loopback/linklocal/uniquelocal) / no trusted header.
  network?: {
    trustProxy?: string | null
    clientIpHeader?: string | null
  }
}

type EnvFlags = {
  registrationDisabled: boolean | null
  nextcloudBackupsEnabled: boolean | null
}

/** Small colored state chip: green = healthy/on, red = down/off, neutral = unknown. */
const StateChip: FunctionComponent<{
  state: boolean | null | undefined
  on?: string
  off?: string
  unknown?: string
}> = ({ state, on = 'OK', off = 'Down', unknown = 'Unknown' }) => {
  const className =
    state === true
      ? 'bg-success text-success-contrast'
      : state === false
        ? 'bg-danger text-danger-contrast'
        : 'bg-passive-4 text-foreground'
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-bold whitespace-nowrap ${className}`}>
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
      {detail ? <Text className="text-passive-1 text-xs">{detail}</Text> : null}
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
      className={`inline-block rounded px-2 py-0.5 text-xs font-bold whitespace-nowrap ${settingSourceChipClass(
        source,
      )}`}
    >
      {settingSourceLabel(source)}
    </span>
  )
}

const AdminServerTab: FunctionComponent<Props> = ({ application, noteIfForbidden }) => {
  // Second-level tabs inside the Server pane (§2 IA): split the long single
  // scroll into General / Registration / Health / Integrations / Logging.
  const subTab = useTabState({ defaultTab: 'general' })

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
  // Standard Red Notes: PLUGINS gallery repo base URL. The gateway proxies the
  // repo server-side so the browse-plugins gallery loads same-origin under the
  // strict CSP; empty clears the override (falls back to env/default).
  const [pluginsRepoUrl, setPluginsRepoUrl] = useState('')
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
  // Standard Red Notes: OCR + workflows editable free-form fields. Booleans save
  // immediately on toggle; the string/number knobs are edited here and saved with
  // their own button (same pattern as the update-check URL / domain list above).
  const [ocrDefaultLanguage, setOcrDefaultLanguage] = useState('')
  const [ocrMaxPages, setOcrMaxPages] = useState('')
  const [ocrMaxImageBytes, setOcrMaxImageBytes] = useState('')
  const [ocrClientDefaultLanguage, setOcrClientDefaultLanguage] = useState('')
  const [workflowsN8nUrl, setWorkflowsN8nUrl] = useState('')
  const [workflowsUiBasePath, setWorkflowsUiBasePath] = useState('')
  const [workflowsUiTokenTtl, setWorkflowsUiTokenTtl] = useState('')
  // Standard Red Notes: SIGNUP CAPS (t50). Save-on-button text rows; blank/0 max =
  // unlimited (clears the cap), windows in hours. per-device is a soft, per-browser
  // cap (see the copy on that row). Populated from the server view below.
  const [signupsPerIpMax, setSignupsPerIpMax] = useState('')
  const [signupsPerIpWindowHours, setSignupsPerIpWindowHours] = useState('')
  const [signupsPerWeekMax, setSignupsPerWeekMax] = useState('')
  const [signupsPerDeviceMax, setSignupsPerDeviceMax] = useState('')
  const [signupsPerDeviceWindowHours, setSignupsPerDeviceWindowHours] = useState('')
  const [settingsSaving, setSettingsSaving] = useState(false)

  // Standard Red Notes: INVITE-URL signup control (t69). Extra config-field inputs
  // (global total cap, signup window bounds, per-user invite quota) — save-on-button
  // text rows, populated from the server view below. The window bounds are entered
  // and displayed in UTC (see the live UTC clock note by those controls).
  const [maxTotalAccounts, setMaxTotalAccounts] = useState('')
  const [signupsOpenAt, setSignupsOpenAt] = useState('')
  const [signupsCloseAt, setSignupsCloseAt] = useState('')
  const [invitesPerUser, setInvitesPerUser] = useState('')

  // Live UTC clock for the signup-window note (ticks each second while mounted). The
  // window is evaluated on the SERVER clock in UTC — this shows the current UTC
  // instant so the admin sets the bounds unambiguously.
  const [utcNowMs, setUtcNowMs] = useState(() => Date.now())

  // Standard Red Notes: INVITE LINKS management. The list is loaded on mount; a
  // create returns the raw token+path EXACTLY ONCE, held in `createdInviteLink`
  // until the admin dismisses it (it can never be re-listed).
  const [inviteLinks, setInviteLinks] = useState<AdminInviteLinkView[]>([])
  const [inviteLinksLoading, setInviteLinksLoading] = useState(false)
  const [inviteLinksNotAvailable, setInviteLinksNotAvailable] = useState(false)
  const [inviteForm, setInviteForm] = useState<CreateInviteLinkForm>(emptyCreateInviteLinkForm)
  const [creatingInviteLink, setCreatingInviteLink] = useState(false)
  const [createdInviteLink, setCreatedInviteLink] = useState<AdminInviteLinkCreated | null>(null)
  // uuid of the link whose revoke is in flight, or null.
  const [revokingInviteUuid, setRevokingInviteUuid] = useState<string | null>(null)

  // Standard Red Notes: APPROVAL QUEUE. Pending (approved=false) users loaded on
  // mount; Approve/Reject act per row and refresh the list.
  const [pendingUsers, setPendingUsers] = useState<AdminPendingUserRow[]>([])
  const [pendingUsersLoading, setPendingUsersLoading] = useState(false)
  const [pendingUsersNotAvailable, setPendingUsersNotAvailable] = useState(false)
  // `${action}:${uuid}` of an in-flight approve/reject, or null.
  const [pendingActionInFlight, setPendingActionInFlight] = useState<string | null>(null)

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
    setPluginsRepoUrl(data?.settings?.plugins?.repoUrl ?? '')
    setDomainListText((data?.settings?.registration?.domainList ?? []).join('\n'))
    setConfirmationSubject(data?.settings?.registration?.emailConfirmationSubject ?? '')
    setConfirmationBody(data?.settings?.registration?.emailConfirmationBody ?? '')
    setConfirmationBaseUrl(data?.settings?.registration?.emailConfirmationBaseUrl ?? '')
    setOcrDefaultLanguage(data?.settings?.ocr?.defaultLanguage ?? '')
    setOcrMaxPages(data?.settings?.ocr?.maxPages != null ? String(data.settings.ocr.maxPages) : '')
    setOcrMaxImageBytes(data?.settings?.ocr?.maxImageBytes != null ? String(data.settings.ocr.maxImageBytes) : '')
    setOcrClientDefaultLanguage(data?.settings?.ocr?.clientDefaultLanguage ?? '')
    setWorkflowsN8nUrl(data?.settings?.workflows?.n8nUrl ?? '')
    setWorkflowsUiBasePath(data?.settings?.workflows?.uiBasePath ?? '')
    setWorkflowsUiTokenTtl(
      data?.settings?.workflows?.uiTokenTtlSeconds != null ? String(data.settings.workflows.uiTokenTtlSeconds) : '',
    )
    // Signup caps: show a positive max as its number, unlimited (0/absent) as blank;
    // windows always carry a resolved value, shown as-is.
    const reg = data?.settings?.registration
    const capToInput = (value: number | null | undefined): string => (value != null && value > 0 ? String(value) : '')
    const windowToInput = (value: number | null | undefined): string => (value != null ? String(value) : '')
    setSignupsPerIpMax(capToInput(reg?.signupsPerIpMax))
    setSignupsPerIpWindowHours(windowToInput(reg?.signupsPerIpWindowHours))
    setSignupsPerWeekMax(capToInput(reg?.signupsPerWeekMax))
    setSignupsPerDeviceMax(capToInput(reg?.signupsPerDeviceMax))
    setSignupsPerDeviceWindowHours(windowToInput(reg?.signupsPerDeviceWindowHours))
    // t69 invite-URL signup control config fields. maxTotalAccounts/invitesPerUser
    // show 0 as blank (0 = unlimited/disabled); the window bounds convert the stored
    // UTC instant back into a UTC datetime-local value for the picker.
    setMaxTotalAccounts(capToInput(reg?.maxTotalAccounts))
    setInvitesPerUser(capToInput(reg?.invitesPerUser))
    setSignupsOpenAt(isoToDatetimeLocalUtc(reg?.signupsOpenAt))
    setSignupsCloseAt(isoToDatetimeLocalUtc(reg?.signupsCloseAt))
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

  // Standard Red Notes: INVITE LINKS list loader (t69). A 404/500 (older server
  // without the feature) hides the section behind a "not available" note rather
  // than erroring.
  const loadInviteLinks = useCallback(async () => {
    setInviteLinksLoading(true)
    try {
      const response = await application.legacyApi.adminListInviteLinks()
      if (isErrorResponse(response)) {
        noteIfForbidden(response)
        if (Number(response.status) === 404 || Number(response.status) === 500) {
          setInviteLinksNotAvailable(true)
        }
        return
      }
      setInviteLinksNotAvailable(false)
      const data = (response as { data?: { inviteLinks?: AdminInviteLinkView[] } }).data
      setInviteLinks(Array.isArray(data?.inviteLinks) ? (data?.inviteLinks as AdminInviteLinkView[]) : [])
    } catch (error) {
      console.error(error)
    } finally {
      setInviteLinksLoading(false)
    }
  }, [application, noteIfForbidden])

  // Standard Red Notes: APPROVAL QUEUE list loader (t69). Same graceful-degrade as
  // the invite links when the endpoint is missing.
  const loadPendingUsers = useCallback(async () => {
    setPendingUsersLoading(true)
    try {
      const response = await application.legacyApi.listPendingUsers({ limit: 100 })
      if (isErrorResponse(response)) {
        noteIfForbidden(response)
        if (Number(response.status) === 404 || Number(response.status) === 500) {
          setPendingUsersNotAvailable(true)
        }
        return
      }
      setPendingUsersNotAvailable(false)
      const data = (response as { data?: { users?: AdminPendingUserRow[] } }).data
      setPendingUsers(Array.isArray(data?.users) ? (data?.users as AdminPendingUserRow[]) : [])
    } catch (error) {
      console.error(error)
    } finally {
      setPendingUsersLoading(false)
    }
  }, [application, noteIfForbidden])

  useEffect(() => {
    void loadRegistrationFlag()
    void loadServerStatus()
    void loadServerSettings()
    void loadControllableServices()
    void loadInviteLinks()
    void loadPendingUsers()
  }, [
    loadRegistrationFlag,
    loadServerStatus,
    loadServerSettings,
    loadControllableServices,
    loadInviteLinks,
    loadPendingUsers,
  ])

  // Tick the UTC clock shown by the signup-window controls once a second.
  useEffect(() => {
    const id = window.setInterval(() => setUtcNowMs(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  /** PUT a partial server-settings update and re-apply the returned view. */
  const saveServerSettings = useCallback(
    async (partial: ServerSettingsPatch, successMessage: string): Promise<boolean> => {
      setSettingsSaving(true)
      try {
        // t69: the snjs client's adminSetServerSettings param type (owned by the
        // snjs package) does not yet list the invite-URL signup-control registration
        // keys, though the gateway validator already accepts them. Widen locally
        // (ServerSettingsPatch) and cast at the boundary rather than reach across
        // into another executor's package.
        const response = await application.legacyApi.adminSetServerSettings(partial as AdminSetServerSettingsPartial)
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

  const savePluginsRepoUrl = useCallback(async () => {
    const update = buildUrlSettingUpdate(pluginsRepoUrl)
    if (!update.ok) {
      addToast({ type: ToastType.Error, message: update.error })
      return
    }
    await saveServerSettings(
      { plugins: { repoUrl: update.value } },
      update.value === null ? 'Plugins repository URL cleared.' : 'Plugins repository URL saved.',
    )
  }, [pluginsRepoUrl, saveServerSettings])

  const togglePluginsSameOriginRendering = useCallback(
    async (nextValue: boolean) => {
      await saveServerSettings(
        { plugins: { sameOriginRendering: nextValue } },
        nextValue ? 'Same-origin plugin rendering enabled.' : 'Same-origin plugin rendering disabled.',
      )
    },
    [saveServerSettings],
  )

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

  // Standard Red Notes: SIGNUP CAPS (t50) save handlers. Each is its own
  // save-on-button row PUTting a partial registration patch (blank/0 max =
  // unlimited → null clears the cap; windows blank → null resets to env/default).
  const saveSignupsPerIpMax = useCallback(async () => {
    const update = buildSignupCapUpdate(signupsPerIpMax)
    if (!update.ok) {
      addToast({ type: ToastType.Error, message: update.error })
      return
    }
    await saveServerSettings(
      { registration: { signupsPerIpMax: update.value } },
      update.value === null ? 'Per-IP signup cap cleared (unlimited).' : 'Per-IP signup cap saved.',
    )
  }, [signupsPerIpMax, saveServerSettings])

  const saveSignupsPerIpWindow = useCallback(async () => {
    const update = buildSignupWindowUpdate(signupsPerIpWindowHours)
    if (!update.ok) {
      addToast({ type: ToastType.Error, message: update.error })
      return
    }
    await saveServerSettings(
      { registration: { signupsPerIpWindowHours: update.value } },
      update.value === null ? 'Per-IP window reset to default.' : 'Per-IP window saved.',
    )
  }, [signupsPerIpWindowHours, saveServerSettings])

  const saveSignupsPerWeekMax = useCallback(async () => {
    const update = buildSignupCapUpdate(signupsPerWeekMax)
    if (!update.ok) {
      addToast({ type: ToastType.Error, message: update.error })
      return
    }
    await saveServerSettings(
      { registration: { signupsPerWeekMax: update.value } },
      update.value === null ? 'Weekly signup cap cleared (unlimited).' : 'Weekly signup cap saved.',
    )
  }, [signupsPerWeekMax, saveServerSettings])

  const saveSignupsPerDeviceMax = useCallback(async () => {
    const update = buildSignupCapUpdate(signupsPerDeviceMax)
    if (!update.ok) {
      addToast({ type: ToastType.Error, message: update.error })
      return
    }
    await saveServerSettings(
      { registration: { signupsPerDeviceMax: update.value } },
      update.value === null ? 'Per-device signup cap cleared (unlimited).' : 'Per-device signup cap saved.',
    )
  }, [signupsPerDeviceMax, saveServerSettings])

  const saveSignupsPerDeviceWindow = useCallback(async () => {
    const update = buildSignupWindowUpdate(signupsPerDeviceWindowHours)
    if (!update.ok) {
      addToast({ type: ToastType.Error, message: update.error })
      return
    }
    await saveServerSettings(
      { registration: { signupsPerDeviceWindowHours: update.value } },
      update.value === null ? 'Per-device window reset to default.' : 'Per-device window saved.',
    )
  }, [signupsPerDeviceWindowHours, saveServerSettings])

  // Standard Red Notes: INVITE-URL signup control (t69) toggles + config saves.
  const saveInviteOnly = useCallback(
    async (enabled: boolean) => {
      await saveServerSettings(
        { registration: { inviteOnly: enabled } },
        enabled ? 'Invite-only signups enabled — a valid invite URL is now required.' : 'Invite-only signups disabled.',
      )
    },
    [saveServerSettings],
  )

  const saveApprovalRequired = useCallback(
    async (enabled: boolean) => {
      await saveServerSettings(
        { registration: { approvalRequired: enabled } },
        enabled
          ? 'Approval required — new signups are held pending until an admin approves.'
          : 'Approval requirement disabled.',
      )
    },
    [saveServerSettings],
  )

  const saveMaxTotalAccounts = useCallback(async () => {
    const update = buildMaxTotalAccountsUpdate(maxTotalAccounts)
    if (!update.ok) {
      addToast({ type: ToastType.Error, message: update.error })
      return
    }
    await saveServerSettings(
      { registration: { maxTotalAccounts: update.value } },
      update.value === null ? 'Total-accounts cap reset to default.' : 'Total-accounts cap saved.',
    )
  }, [maxTotalAccounts, saveServerSettings])

  const saveInvitesPerUser = useCallback(async () => {
    const update = buildInvitesPerUserUpdate(invitesPerUser)
    if (!update.ok) {
      addToast({ type: ToastType.Error, message: update.error })
      return
    }
    await saveServerSettings(
      { registration: { invitesPerUser: update.value } },
      update.value === null ? 'Per-user invite quota reset to default.' : 'Per-user invite quota saved.',
    )
  }, [invitesPerUser, saveServerSettings])

  const saveSignupsOpenAt = useCallback(async () => {
    const update = datetimeLocalUtcToISO(signupsOpenAt)
    if (!update.ok) {
      addToast({ type: ToastType.Error, message: update.error })
      return
    }
    await saveServerSettings(
      { registration: { signupsOpenAt: update.value } },
      update.value === null ? 'Signup window open time cleared.' : 'Signup window open time saved.',
    )
  }, [signupsOpenAt, saveServerSettings])

  const saveSignupsCloseAt = useCallback(async () => {
    const update = datetimeLocalUtcToISO(signupsCloseAt)
    if (!update.ok) {
      addToast({ type: ToastType.Error, message: update.error })
      return
    }
    await saveServerSettings(
      { registration: { signupsCloseAt: update.value } },
      update.value === null ? 'Signup window close time cleared.' : 'Signup window close time saved.',
    )
  }, [signupsCloseAt, saveServerSettings])

  // Standard Red Notes: create an invite link. On success the raw token + path are
  // shown EXACTLY ONCE (held in createdInviteLink) and the list is refreshed.
  const createInviteLink = useCallback(async () => {
    const body = buildCreateInviteLinkBody(inviteForm)
    if (!body.ok) {
      addToast({ type: ToastType.Error, message: body.error })
      return
    }
    setCreatingInviteLink(true)
    try {
      const response = await application.legacyApi.adminCreateInviteLink(body.value)
      if (isErrorResponse(response)) {
        noteIfForbidden(response)
        const message =
          (response as { data?: { error?: { message?: string } } }).data?.error?.message ??
          'Failed to create the invite link.'
        addToast({ type: ToastType.Error, message })
        return
      }
      const created = (response as { data?: { inviteLink?: AdminInviteLinkCreated } }).data?.inviteLink ?? null
      setCreatedInviteLink(created)
      setInviteForm(emptyCreateInviteLinkForm())
      addToast({ type: ToastType.Success, message: 'Invite link created. Copy the URL now — it is shown only once.' })
      void loadInviteLinks()
    } catch (error) {
      console.error(error)
      addToast({ type: ToastType.Error, message: 'Failed to create the invite link.' })
    } finally {
      setCreatingInviteLink(false)
    }
  }, [application, inviteForm, noteIfForbidden, loadInviteLinks])

  const copyCreatedInviteUrl = useCallback(async () => {
    if (!createdInviteLink) {
      return
    }
    const url = inviteLinkAbsoluteUrl(window.location.origin, createdInviteLink.path)
    try {
      await navigator.clipboard.writeText(url)
      addToast({ type: ToastType.Success, message: 'Invite URL copied.' })
    } catch {
      addToast({ type: ToastType.Error, message: 'Could not copy — select the URL and copy it manually.' })
    }
  }, [createdInviteLink])

  const revokeInviteLink = useCallback(
    async (link: AdminInviteLinkView) => {
      const confirmed = await confirmDialog({
        title: 'Revoke this invite link?',
        text: `Revoking${
          link.label ? ` "${link.label}"` : ' this link'
        } permanently disables it — anyone who still has the URL can no longer sign up with it. This cannot be undone.`,
        confirmButtonText: 'Revoke link',
        confirmButtonStyle: 'danger',
      })
      if (!confirmed) {
        return
      }
      setRevokingInviteUuid(link.uuid)
      try {
        const response = await application.legacyApi.adminRevokeInviteLink(link.uuid)
        if (isErrorResponse(response)) {
          noteIfForbidden(response)
          addToast({ type: ToastType.Error, message: 'Failed to revoke the invite link.' })
          return
        }
        addToast({ type: ToastType.Success, message: 'Invite link revoked.' })
        void loadInviteLinks()
      } catch (error) {
        console.error(error)
        addToast({ type: ToastType.Error, message: 'Failed to revoke the invite link.' })
      } finally {
        setRevokingInviteUuid(null)
      }
    },
    [application, noteIfForbidden, loadInviteLinks],
  )

  // Standard Red Notes: APPROVAL QUEUE actions. Approve flips the access gate;
  // Reject hard-deletes the pending row (confirmed). Both refresh the list.
  const approvePendingUser = useCallback(
    async (row: AdminPendingUserRow) => {
      setPendingActionInFlight(`approve:${row.uuid}`)
      try {
        const response = await application.legacyApi.approveUser(row.uuid)
        if (isErrorResponse(response)) {
          noteIfForbidden(response)
          addToast({ type: ToastType.Error, message: `Failed to approve ${row.email}.` })
          return
        }
        addToast({ type: ToastType.Success, message: `Approved ${row.email}.` })
        void loadPendingUsers()
      } catch (error) {
        console.error(error)
        addToast({ type: ToastType.Error, message: `Failed to approve ${row.email}.` })
      } finally {
        setPendingActionInFlight(null)
      }
    },
    [application, noteIfForbidden, loadPendingUsers],
  )

  const rejectPendingUser = useCallback(
    async (row: AdminPendingUserRow) => {
      const confirmed = await confirmDialog({
        title: 'Reject this signup?',
        text: `Rejecting "${row.email}" permanently deletes the pending account. They can register again later. Continue?`,
        confirmButtonText: 'Reject signup',
        confirmButtonStyle: 'danger',
      })
      if (!confirmed) {
        return
      }
      setPendingActionInFlight(`reject:${row.uuid}`)
      try {
        const response = await application.legacyApi.rejectUser(row.uuid)
        if (isErrorResponse(response)) {
          noteIfForbidden(response)
          addToast({ type: ToastType.Error, message: `Failed to reject ${row.email}.` })
          return
        }
        addToast({ type: ToastType.Success, message: `Rejected ${row.email}.` })
        void loadPendingUsers()
      } catch (error) {
        console.error(error)
        addToast({ type: ToastType.Error, message: `Failed to reject ${row.email}.` })
      } finally {
        setPendingActionInFlight(null)
      }
    },
    [application, noteIfForbidden, loadPendingUsers],
  )

  // Standard Red Notes: runtime LOG VERBOSITY (t50). Saves immediately on change;
  // the server applies it to the gateway + auth loggers within the poll interval.
  const saveLoggingLevel = useCallback(
    async (level: string) => {
      await saveServerSettings({ logging: { level } }, `Server log level set to "${level}".`)
    },
    [saveServerSettings],
  )

  // Standard Red Notes: OCR + workflows save handlers. A blank text/number field
  // saves as `null` (clear the override → fall back to env/default); a non-empty
  // number field must be an integer.
  const parseIntegerOrClear = useCallback((raw: string): number | null | undefined => {
    const trimmed = raw.trim()
    if (trimmed === '') {
      return null
    }
    const value = Number(trimmed)
    return Number.isInteger(value) ? value : undefined
  }, [])

  const toggleOcrServerEnabled = useCallback(
    async (nextValue: boolean) => {
      await saveServerSettings(
        { ocr: { serverEnabled: nextValue } },
        nextValue ? 'Server-side OCR enabled.' : 'Server-side OCR disabled.',
      )
    },
    [saveServerSettings],
  )

  const toggleOcrClientEnabled = useCallback(
    async (nextValue: boolean) => {
      await saveServerSettings(
        { ocr: { clientEnabled: nextValue } },
        nextValue ? 'Browser (on-device) OCR enabled.' : 'Browser (on-device) OCR disabled.',
      )
    },
    [saveServerSettings],
  )

  const saveOcrDefaultLanguage = useCallback(async () => {
    const trimmed = ocrDefaultLanguage.trim()
    await saveServerSettings(
      { ocr: { defaultLanguage: trimmed === '' ? null : trimmed } },
      trimmed === '' ? 'Server OCR default language cleared.' : 'Server OCR default language saved.',
    )
  }, [ocrDefaultLanguage, saveServerSettings])

  const saveOcrClientDefaultLanguage = useCallback(async () => {
    const trimmed = ocrClientDefaultLanguage.trim()
    await saveServerSettings(
      { ocr: { clientDefaultLanguage: trimmed === '' ? null : trimmed } },
      trimmed === '' ? 'Browser OCR default language cleared.' : 'Browser OCR default language saved.',
    )
  }, [ocrClientDefaultLanguage, saveServerSettings])

  const saveOcrMaxPages = useCallback(async () => {
    const value = parseIntegerOrClear(ocrMaxPages)
    if (value === undefined) {
      addToast({ type: ToastType.Error, message: 'Max pages must be a whole number.' })
      return
    }
    await saveServerSettings(
      { ocr: { maxPages: value } },
      value === null ? 'Server OCR page limit cleared.' : 'Server OCR page limit saved.',
    )
  }, [ocrMaxPages, parseIntegerOrClear, saveServerSettings])

  const saveOcrMaxImageBytes = useCallback(async () => {
    const value = parseIntegerOrClear(ocrMaxImageBytes)
    if (value === undefined) {
      addToast({ type: ToastType.Error, message: 'Max image size must be a whole number of bytes.' })
      return
    }
    await saveServerSettings(
      { ocr: { maxImageBytes: value } },
      value === null ? 'Server OCR image-size limit cleared.' : 'Server OCR image-size limit saved.',
    )
  }, [ocrMaxImageBytes, parseIntegerOrClear, saveServerSettings])

  const toggleWorkflowsEnabled = useCallback(
    async (nextValue: boolean) => {
      await saveServerSettings(
        { workflows: { enabled: nextValue } },
        nextValue ? 'Workflows (n8n) enabled.' : 'Workflows (n8n) disabled.',
      )
    },
    [saveServerSettings],
  )

  const saveWorkflowsN8nUrl = useCallback(async () => {
    const trimmed = workflowsN8nUrl.trim()
    if (trimmed !== '' && !/^https?:\/\/.+/i.test(trimmed)) {
      addToast({ type: ToastType.Error, message: 'The n8n URL must be an http(s) URL.' })
      return
    }
    await saveServerSettings(
      { workflows: { n8nUrl: trimmed === '' ? null : trimmed } },
      trimmed === '' ? 'n8n URL cleared.' : 'n8n URL saved.',
    )
  }, [workflowsN8nUrl, saveServerSettings])

  const saveWorkflowsUiBasePath = useCallback(async () => {
    const trimmed = workflowsUiBasePath.trim()
    if (trimmed !== '' && !trimmed.startsWith('/')) {
      addToast({ type: ToastType.Error, message: 'The editor path must be an absolute path (start with /).' })
      return
    }
    await saveServerSettings(
      { workflows: { uiBasePath: trimmed === '' ? null : trimmed } },
      trimmed === ''
        ? 'Workflows editor path cleared.'
        : 'Workflows editor path saved (applies on next gateway restart).',
    )
  }, [workflowsUiBasePath, saveServerSettings])

  const saveWorkflowsUiTokenTtl = useCallback(async () => {
    const value = parseIntegerOrClear(workflowsUiTokenTtl)
    if (value === undefined) {
      addToast({ type: ToastType.Error, message: 'The editor cookie lifetime must be a whole number of seconds.' })
      return
    }
    await saveServerSettings(
      { workflows: { uiTokenTtlSeconds: value } },
      value === null ? 'Workflows editor cookie lifetime cleared.' : 'Workflows editor cookie lifetime saved.',
    )
  }, [workflowsUiTokenTtl, parseIntegerOrClear, saveServerSettings])

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
  const network = serverStatus?.network

  return (
    <>
      <PreferencesSegment>
        <Title>Server</Title>
        <Text>
          Instance configuration, health and integrations, grouped into subtabs. Editable settings are persisted and
          override the matching environment variable until cleared.
        </Text>
        <div className="border-border mt-3 border-b">
          <TabList state={subTab} className="flex flex-wrap">
            <Tab id="general" className="inline-flex items-center gap-1.5 !text-xs">
              <Icon type="tune" size="medium" />
              General
            </Tab>
            <Tab id="registration" className="inline-flex items-center gap-1.5 !text-xs">
              <Icon type="user-switch" size="medium" />
              Registration &amp; signups
            </Tab>
            <Tab id="health" className="inline-flex items-center gap-1.5 !text-xs">
              <Icon type="server" size="medium" />
              Health &amp; services
            </Tab>
            <Tab id="integrations" className="inline-flex items-center gap-1.5 !text-xs">
              <Icon type="dashboard" size="medium" />
              Integrations
            </Tab>
            <Tab id="logging" className="inline-flex items-center gap-1.5 !text-xs">
              <Icon type="list-bulleted" size="medium" />
              Logging
            </Tab>
          </TabList>
        </div>
      </PreferencesSegment>

      {/* ================= HEALTH & SERVICES ================= */}
      <TabPanel state={subTab} id="health">
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
            <Text className="text-danger mt-3">{statusError}</Text>
          ) : serverStatus ? (
            <div className="mt-3 flex flex-col">
              {/* Dependency states: one per line, chip aligned right. */}
              <div className="divide-border border-border divide-y rounded border px-3">
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
                  <Subtitle className="mt-4 mb-2">Infrastructure containers</Subtitle>
                  <div className="divide-border border-border divide-y rounded border px-3">
                    {dockerControl.containers.map((container) => {
                      const rowBusy = containerActionInFlight === `container:${container}`
                      return (
                        <div key={container} className="flex items-center justify-between gap-4 py-2">
                          <div className="flex min-w-0 flex-col">
                            <Text>{dockerContainerLabel(container)}</Text>
                            <Text className="text-passive-1 text-xs">
                              Restarts the whole container via the docker-socket-proxy
                            </Text>
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
                  <Text className="text-passive-1 mt-2 text-xs">
                    Restarting the database or cache briefly interrupts every service that depends on it.
                  </Text>
                </>
              ) : dockerControl?.enabled && !dockerControl.available ? (
                <Text className="text-passive-1 mt-3 text-xs">
                  Container restart is enabled but the docker-socket-proxy is not reachable, so restarting Redis/MariaDB
                  is not available right now.
                </Text>
              ) : null}

              {services.length > 0 && (
                <>
                  <Subtitle className="mt-4 mb-2">All services</Subtitle>
                  <div className="divide-border border-border divide-y rounded border px-3">
                    {services.map((service) => {
                      const chip = (
                        <span
                          className={`inline-block rounded px-2 py-0.5 text-xs font-bold whitespace-nowrap ${serviceStatusChipClass(
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
                      const rowBusy =
                        serviceActionInFlight !== null && serviceActionInFlight.startsWith(`${service.name}:`)
                      // Friendly label for the in-process WebSocket gateway.
                      const displayName = isWsGateway ? 'WebSocket gateway' : service.name
                      const wsDetail = isWsGateway
                        ? 'Realtime sync — runs inside the API gateway process'
                        : service.detail
                      const latency = formatServiceLatency(service.responseTimeMs)

                      return (
                        <div key={service.name} className="flex items-center justify-between gap-4 py-2">
                          <div className="flex min-w-0 flex-col">
                            <Text>{displayName}</Text>
                            {wsDetail ? <Text className="text-passive-1 text-xs">{wsDetail}</Text> : null}
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            {latency ? (
                              <span
                                className={`text-xs tabular-nums ${serviceLatencyClass(
                                  service.responseTimeMs,
                                  service.status,
                                )}`}
                              >
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
                    <Text className="text-passive-1 mt-2 text-xs">
                      Service lifecycle controls are not available on this server (the /v1/admin/services endpoint is
                      missing). Update the server image to restart/stop/start services from here.
                    </Text>
                  ) : !serviceControlAvailable ? (
                    <Text className="text-passive-1 mt-2 text-xs">
                      Service lifecycle controls require a newer server image: supervisorctl cannot reach supervisord on
                      this deployment, so restart/stop/start are disabled.
                    </Text>
                  ) : (
                    <Text className="text-passive-1 mt-2 text-xs">
                      Restarting a service briefly interrupts what it powers. Restarting the API gateway will drop your
                      admin connection for a few seconds.
                    </Text>
                  )}
                </>
              )}
            </div>
          ) : null}
        </PreferencesSegment>
      </TabPanel>

      {/* ================= GENERAL ================= */}
      <TabPanel state={subTab} id="general">
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

        {/* Standard Red Notes: read-only forwarded-client-IP resolution. These are boot
          settings (TRUST_PROXY / CLIENT_IP_HEADER) — changing them requires editing the
          server environment and redeploying. They govern how the real client IP is
          derived for rate limiting, IP allow/block lists and session security. */}
        <PreferencesSegment>
          <Title>Client IP resolution</Title>
          <Text>
            How the server derives each request's real client IP (used for rate limiting, IP allow/block lists and the
            IP recorded on sessions). These are read-only boot settings; only trust forwarded headers when this instance
            is actually behind a proxy that sets them and strips inbound copies. Changing them requires editing the
            server environment and redeploying.
          </Text>
          {statusLoading ? (
            <Spinner className="mt-3 h-5 w-5" />
          ) : (
            <div className="divide-border border-border mt-3 divide-y rounded border px-3">
              <StatusRow
                name="Trusted proxy (TRUST_PROXY)"
                detail="Which upstream hops Express trusts for X-Forwarded-* headers"
                chip={
                  <span className="bg-passive-4 text-foreground inline-block rounded px-2 py-0.5 text-xs font-bold whitespace-nowrap">
                    {network?.trustProxy ?? 'Default (loopback/private)'}
                  </span>
                }
              />
              <StatusRow
                name="Trusted client-IP header (CLIENT_IP_HEADER)"
                detail="Named header read for the client IP, when set by a trusted proxy"
                chip={
                  <span className="bg-passive-4 text-foreground inline-block rounded px-2 py-0.5 text-xs font-bold whitespace-nowrap">
                    {network?.clientIpHeader ?? 'Off (request.ip only)'}
                  </span>
                }
              />
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
              <Text className="text-danger mt-3">{settingsError}</Text>
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

              <div>
                <div className="flex items-center gap-2">
                  <Subtitle>Plugins repository URL</Subtitle>
                  <SourceChip sources={settingsSources} keys={['plugins.repoUrl', 'pluginsRepoUrl']} />
                </div>
                <Text className="mt-1 text-xs">
                  Base URL of the plugins (extensions) repository powering Preferences → Plugins → Browse. The server
                  fetches <code>{'<url>/packages.json'}</code> and returns it to the app from this origin (so the strict
                  CSP is satisfied — no external CDN fetch). Leave empty and save to clear the override (falls back to
                  the Standard Notes repository).
                </Text>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <DecoratedInput
                    className={{ container: 'w-96 max-w-full' }}
                    placeholder="https://raw.githubusercontent.com/standardnotes/plugins/main/cdn/dist"
                    value={pluginsRepoUrl}
                    onChange={setPluginsRepoUrl}
                    onEnter={() => void savePluginsRepoUrl()}
                    disabled={settingsSaving}
                  />
                  <Button
                    label={settingsSaving ? 'Saving…' : 'Save'}
                    onClick={() => void savePluginsRepoUrl()}
                    disabled={settingsSaving}
                  />
                </div>
              </div>

              <div className="flex items-center justify-between gap-4">
                <div className="flex min-w-0 flex-col">
                  <div className="flex items-center gap-2">
                    <Subtitle>Same-origin plugin rendering</Subtitle>
                    <SourceChip
                      sources={settingsSources}
                      keys={['plugins.sameOriginRendering', 'pluginsSameOriginRendering']}
                    />
                  </div>
                  <Text className="mt-1 text-xs">
                    Render externally-hosted plugin components from the repository above by serving their files through
                    this server under <code>/v1/plugins/component/…</code>, so the plugin&apos;s iframe loads
                    same-origin and the strict Content-Security-Policy (<code>frame-src &apos;self&apos;</code>) allows
                    it — no CSP change. Only files under the configured repository URL are ever served (SSRF-guarded).{' '}
                    <strong>Security note:</strong> this serves third-party plugin code from this server&apos;s origin.
                    The plugin still runs in a sandboxed iframe with no access to your notes&apos; origin (it
                    communicates only through the plugin message API), but enabling this is a trust decision — leave it
                    off unless you trust the configured repository. When off, external plugins remain blocked by the CSP
                    as before.
                  </Text>
                </div>
                {settingsSaving ? (
                  <Spinner className="h-5 w-5 shrink-0" />
                ) : (
                  <Switch
                    checked={Boolean(serverSettings?.plugins?.sameOriginRendering)}
                    onChange={(checked) => void togglePluginsSameOriginRendering(checked)}
                  />
                )}
              </div>

              <div className="flex items-center justify-between gap-4">
                <div className="flex min-w-0 flex-col">
                  <div className="flex items-center gap-2">
                    <Subtitle>Nextcloud backups</Subtitle>
                    <SourceChip
                      sources={settingsSources}
                      keys={['nextcloudBackups.enabled', 'nextcloudBackupsEnabled']}
                    />
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
      </TabPanel>

      {/* ================= REGISTRATION & SIGNUPS ================= */}
      <TabPanel state={subTab} id="registration">
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
          <Title>Registration policy &amp; signup caps</Title>
          <Text>
            Who may create an account, and how many new accounts are allowed. Saved values override the matching
            environment variables until cleared; the chip by each control shows where its active value comes from.
          </Text>
          {settingsLoading ? (
            <Spinner className="mt-3 h-5 w-5" />
          ) : settingsNotAvailable ? (
            <Text className="mt-3">
              Editable server settings are not available on this server (the /v1/admin/server-settings endpoint is
              missing). Update the server to manage the registration policy and signup caps from here.
            </Text>
          ) : settingsError ? (
            <>
              <Text className="text-danger mt-3">{settingsError}</Text>
              <div className="mt-2">
                <Button label="Retry" onClick={() => void loadServerSettings()} />
              </div>
            </>
          ) : (
            <div className="mt-3 flex flex-col gap-4">
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
                      items={(
                        serverSettings?.registration?.assignableRoles ?? ['CORE_USER', 'PRO_USER', 'VAULTS_USER']
                      ).map((role) => ({ label: registrationRoleLabel(role), value: role }))}
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
                    Restrict which email domains may sign up. In <strong>allowlist</strong> mode only the listed domains
                    may register; in <strong>blocklist</strong> mode the listed domains are refused. A listed domain
                    also matches its subdomains (e.g. <code>example.com</code> matches <code>mail.example.com</code>).
                    Matching is case-insensitive.
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
                    <Text className="text-passive-1 text-xs font-medium">Domains</Text>
                    <SourceChip sources={settingsSources} keys={['registration.domainList']} />
                  </div>
                  <textarea
                    className="border-border bg-default text-foreground mt-1 h-24 w-96 max-w-full rounded border p-2 text-sm"
                    placeholder={'example.com\npartner.org'}
                    value={domainListText}
                    onChange={(event) => setDomainListText(event.target.value)}
                    disabled={settingsSaving}
                  />
                  <Text className="text-passive-1 mt-1 text-xs">
                    One domain per line (or comma-separated). The list applies to both allowlist and blocklist modes and
                    is ignored while the mode is Off.
                  </Text>
                  <div className="mt-2">
                    <Button
                      label={settingsSaving ? 'Saving…' : 'Save domains'}
                      onClick={() => void saveRegistrationDomainList()}
                      disabled={settingsSaving}
                    />
                  </div>
                </div>

                {/* Standard Red Notes: SIGNUP CAPS (t50). Admin-owned overlay keys
                  enforced auth-side; a max of 0/blank = unlimited. */}
                <div className="border-border border-t pt-4">
                  <Subtitle>Signup rate caps</Subtitle>
                  <Text className="mt-1 text-xs">
                    Limit how many new accounts can be created. Enforced server-side on top of the anti-abuse rate
                    limits (Security tab). A cap of 0 or blank means unlimited. Enforcement fails open — a cache outage
                    never blocks legitimate signups.
                  </Text>

                  <div className="mt-3 flex flex-col gap-4">
                    {/* Per-IP cap + window */}
                    <div>
                      <div className="flex items-center gap-2">
                        <Text className="text-passive-1 text-xs font-medium">Per-IP signups</Text>
                        <SourceChip sources={settingsSources} keys={['registration.signupsPerIpMax']} />
                      </div>
                      <Text className="text-passive-1 mt-1 text-xs">
                        Maximum new accounts allowed from one client IP within the rolling window.
                      </Text>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <DecoratedInput
                          className={{ container: 'w-32 max-w-full' }}
                          placeholder="0 (unlimited)"
                          value={signupsPerIpMax}
                          onChange={setSignupsPerIpMax}
                          onEnter={() => void saveSignupsPerIpMax()}
                          disabled={settingsSaving}
                        />
                        <Button
                          label={settingsSaving ? 'Saving…' : 'Save'}
                          onClick={() => void saveSignupsPerIpMax()}
                          disabled={settingsSaving}
                        />
                        <Text className="text-passive-1 text-xs">within</Text>
                        <DecoratedInput
                          className={{ container: 'w-24 max-w-full' }}
                          placeholder="24"
                          value={signupsPerIpWindowHours}
                          onChange={setSignupsPerIpWindowHours}
                          onEnter={() => void saveSignupsPerIpWindow()}
                          disabled={settingsSaving}
                        />
                        <Text className="text-passive-1 text-xs">hours</Text>
                        <Button
                          label={settingsSaving ? 'Saving…' : 'Save window'}
                          onClick={() => void saveSignupsPerIpWindow()}
                          disabled={settingsSaving}
                        />
                        <SourceChip sources={settingsSources} keys={['registration.signupsPerIpWindowHours']} />
                      </div>
                    </div>

                    {/* Per-week global cap */}
                    <div>
                      <div className="flex items-center gap-2">
                        <Text className="text-passive-1 text-xs font-medium">Per-week (whole instance)</Text>
                        <SourceChip sources={settingsSources} keys={['registration.signupsPerWeekMax']} />
                      </div>
                      <Text className="text-passive-1 mt-1 text-xs">
                        Global cap on new accounts created across the whole instance in any rolling 7-day period.
                      </Text>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <DecoratedInput
                          className={{ container: 'w-40 max-w-full' }}
                          placeholder="0 (unlimited)"
                          value={signupsPerWeekMax}
                          onChange={setSignupsPerWeekMax}
                          onEnter={() => void saveSignupsPerWeekMax()}
                          disabled={settingsSaving}
                        />
                        <Button
                          label={settingsSaving ? 'Saving…' : 'Save'}
                          onClick={() => void saveSignupsPerWeekMax()}
                          disabled={settingsSaving}
                        />
                      </div>
                    </div>

                    {/* Per-device SOFT cap + window */}
                    <div>
                      <div className="flex items-center gap-2">
                        <Text className="text-passive-1 text-xs font-medium">Per-device (soft)</Text>
                        <SourceChip sources={settingsSources} keys={['registration.signupsPerDeviceMax']} />
                      </div>
                      <Text className="text-passive-1 mt-1 text-xs">
                        Maximum new accounts per browser within the window.{' '}
                        <strong>Best-effort, per-browser and bypassable:</strong> it relies on a device id the client
                        sends, which the client fully controls (incognito, another browser or a script defeats it), so
                        it is a speed-bump, <strong>not</strong> a security boundary. Native apps send no device id, so
                        this cap does not apply there.
                      </Text>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <DecoratedInput
                          className={{ container: 'w-32 max-w-full' }}
                          placeholder="0 (unlimited)"
                          value={signupsPerDeviceMax}
                          onChange={setSignupsPerDeviceMax}
                          onEnter={() => void saveSignupsPerDeviceMax()}
                          disabled={settingsSaving}
                        />
                        <Button
                          label={settingsSaving ? 'Saving…' : 'Save'}
                          onClick={() => void saveSignupsPerDeviceMax()}
                          disabled={settingsSaving}
                        />
                        <Text className="text-passive-1 text-xs">within</Text>
                        <DecoratedInput
                          className={{ container: 'w-24 max-w-full' }}
                          placeholder="24"
                          value={signupsPerDeviceWindowHours}
                          onChange={setSignupsPerDeviceWindowHours}
                          onEnter={() => void saveSignupsPerDeviceWindow()}
                          disabled={settingsSaving}
                        />
                        <Text className="text-passive-1 text-xs">hours</Text>
                        <Button
                          label={settingsSaving ? 'Saving…' : 'Save window'}
                          onClick={() => void saveSignupsPerDeviceWindow()}
                          disabled={settingsSaving}
                        />
                        <SourceChip sources={settingsSources} keys={['registration.signupsPerDeviceWindowHours']} />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Standard Red Notes: EMAIL CONFIRMATION (part 2). OFF by default. */}
                <div className="border-border border-t pt-4">
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
                    When on, a new signup is emailed a single-use verification link and must confirm before the gate
                    below applies. Existing accounts are unaffected (they are treated as already confirmed). Requires
                    SMTP to be configured and the base URL below set so the link is absolute.
                  </Text>

                  {serverSettings?.registration?.emailConfirmationEnabled && (
                    <div className="mt-4 flex flex-col gap-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <Text className="text-passive-1 text-xs font-medium">Gating mode</Text>
                          <SourceChip sources={settingsSources} keys={['registration.emailConfirmationGating']} />
                        </div>
                        <div className="mt-1 w-96 max-w-full">
                          <Dropdown
                            label="Confirmation gating mode"
                            items={(serverSettings?.registration?.gatingModes ?? ['block_signin', 'warn']).map(
                              (mode) => ({
                                label:
                                  mode === 'block_signin'
                                    ? 'Block sign-in until confirmed'
                                    : 'Warn only (allow sign-in)',
                                value: mode,
                              }),
                            )}
                            value={serverSettings?.registration?.emailConfirmationGating ?? 'block_signin'}
                            onChange={(mode) => void saveEmailConfirmationGating(mode)}
                            disabled={settingsSaving}
                          />
                        </div>
                      </div>

                      <div>
                        <div className="flex items-center gap-2">
                          <Text className="text-passive-1 text-xs font-medium">Web app base URL</Text>
                          <SourceChip sources={settingsSources} keys={['registration.emailConfirmationBaseUrl']} />
                        </div>
                        <input
                          type="url"
                          className="border-border bg-default text-foreground mt-1 w-96 max-w-full rounded border p-2 text-sm"
                          placeholder="https://notes.example.com"
                          value={confirmationBaseUrl}
                          onChange={(event) => setConfirmationBaseUrl(event.target.value)}
                          disabled={settingsSaving}
                        />
                      </div>

                      <div>
                        <div className="flex items-center gap-2">
                          <Text className="text-passive-1 text-xs font-medium">Email subject</Text>
                          <SourceChip sources={settingsSources} keys={['registration.emailConfirmationSubject']} />
                        </div>
                        <input
                          type="text"
                          className="border-border bg-default text-foreground mt-1 w-96 max-w-full rounded border p-2 text-sm"
                          value={confirmationSubject}
                          onChange={(event) => setConfirmationSubject(event.target.value)}
                          disabled={settingsSaving}
                        />
                      </div>

                      <div>
                        <div className="flex items-center gap-2">
                          <Text className="text-passive-1 text-xs font-medium">Email body</Text>
                          <SourceChip sources={settingsSources} keys={['registration.emailConfirmationBody']} />
                        </div>
                        <textarea
                          className="border-border bg-default text-foreground mt-1 h-32 w-96 max-w-full rounded border p-2 text-sm"
                          value={confirmationBody}
                          onChange={(event) => setConfirmationBody(event.target.value)}
                          disabled={settingsSaving}
                        />
                        <Text className="text-passive-1 mt-1 text-xs">
                          Use <code>{'{{confirmation_url}}'}</code> where the verification link should appear. If
                          omitted, the link is appended automatically.
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

        <HorizontalSeparator classes="my-4" />

        {/* ===== Standard Red Notes: INVITE-ONLY signups + invite links (t69) ===== */}
        <PreferencesSegment>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Title>Invite-only signups</Title>
              <SourceChip sources={settingsSources} keys={['registration.inviteOnly']} />
            </div>
            {settingsLoading ? (
              <Spinner className="h-5 w-5" />
            ) : settingsNotAvailable ? null : (
              <Switch
                checked={Boolean(serverSettings?.registration?.inviteOnly)}
                onChange={(checked) => void saveInviteOnly(checked)}
              />
            )}
          </div>
          <Text className="mt-1 text-xs">
            When on, registration requires a valid, unused invite URL created below. Missing or invalid invites are
            refused. This is a hard gate — if the server cannot verify an invite it fails closed (refuses), so signups
            stay restricted even during a database blip.
          </Text>

          <Subtitle className="mt-4">Create an invite link</Subtitle>
          {inviteLinksNotAvailable ? (
            <Text className="text-passive-1 mt-2 text-xs">
              Invite-link management is not available on this server. Update the server image to create and manage
              invite links from here.
            </Text>
          ) : (
            <>
              <Text className="mt-1 text-xs">
                Set how many accounts the link may create (1 = single-use, more = a batch), an optional expiry, and
                optional label / role / email-domain lock. The URL is shown <strong>once</strong> right after you create
                it — copy it then.
              </Text>
              <div className="mt-3 flex flex-col gap-3">
                <div className="flex flex-wrap items-end gap-3">
                  <label className="text-passive-1 flex flex-col text-xs">
                    Max uses
                    <DecoratedInput
                      className={{ container: 'mt-1 w-28' }}
                      placeholder="1"
                      value={inviteForm.maxUses}
                      onChange={(maxUses) => setInviteForm((form) => ({ ...form, maxUses }))}
                      disabled={creatingInviteLink}
                    />
                  </label>
                  <label className="text-passive-1 flex flex-col text-xs">
                    Expiry (hours, blank = never)
                    <DecoratedInput
                      className={{ container: 'mt-1 w-44' }}
                      placeholder="never"
                      value={inviteForm.expiresInHours}
                      onChange={(expiresInHours) => setInviteForm((form) => ({ ...form, expiresInHours }))}
                      disabled={creatingInviteLink}
                    />
                  </label>
                </div>
                <label className="text-passive-1 flex flex-col text-xs">
                  Label (optional note)
                  <DecoratedInput
                    className={{ container: 'mt-1 w-96 max-w-full' }}
                    placeholder="e.g. Design team, spring cohort"
                    value={inviteForm.label}
                    onChange={(label) => setInviteForm((form) => ({ ...form, label }))}
                    disabled={creatingInviteLink}
                  />
                </label>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="text-passive-1 flex flex-col text-xs">
                    Role for accounts from this link
                    <div className="mt-1 w-64 max-w-full">
                      <Dropdown
                        label="Role for accounts from this link"
                        items={[
                          { label: 'Instance default role', value: '' },
                          ...(
                            serverSettings?.registration?.assignableRoles ?? ['CORE_USER', 'PRO_USER', 'VAULTS_USER']
                          ).map((role) => ({ label: registrationRoleLabel(role), value: role })),
                        ]}
                        value={inviteForm.defaultRole}
                        onChange={(defaultRole) => setInviteForm((form) => ({ ...form, defaultRole }))}
                        disabled={creatingInviteLink}
                      />
                    </div>
                  </div>
                  <label className="text-passive-1 flex flex-col text-xs">
                    Email-domain lock (optional)
                    <DecoratedInput
                      className={{ container: 'mt-1 w-64 max-w-full' }}
                      placeholder="example.com"
                      value={inviteForm.allowedDomain}
                      onChange={(allowedDomain) => setInviteForm((form) => ({ ...form, allowedDomain }))}
                      disabled={creatingInviteLink}
                    />
                  </label>
                </div>
                <div>
                  <Button
                    primary
                    label={creatingInviteLink ? 'Creating…' : 'Create invite link'}
                    onClick={() => void createInviteLink()}
                    disabled={creatingInviteLink}
                  />
                </div>
              </div>

              {/* The ONE-TIME URL panel: the raw token is only ever available here. */}
              {createdInviteLink && (
                <div className="border-info bg-info-backdrop mt-4 rounded border p-3">
                  <div className="flex items-center gap-2">
                    <Icon type="info" size="medium" className="text-info" />
                    <Subtitle>Copy this invite URL now — it is shown only once</Subtitle>
                  </div>
                  <Text className="mt-1 text-xs">
                    For security the URL (which contains the secret token) is never stored or shown again. If you lose
                    it, revoke this link and create a new one.
                  </Text>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <code className="border-border bg-default text-foreground max-w-full overflow-x-auto rounded border px-2 py-1 text-xs whitespace-nowrap">
                      {inviteLinkAbsoluteUrl(window.location.origin, createdInviteLink.path)}
                    </code>
                    <Button label="Copy URL" onClick={() => void copyCreatedInviteUrl()} />
                    <Button label="Dismiss" onClick={() => setCreatedInviteLink(null)} />
                  </div>
                </div>
              )}

              <Subtitle className="mt-5">Existing invite links</Subtitle>
              {inviteLinksLoading ? (
                <Spinner className="mt-2 h-5 w-5" />
              ) : inviteLinks.length === 0 ? (
                <Text className="text-passive-1 mt-2 text-xs">No invite links yet.</Text>
              ) : (
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full min-w-[40rem] text-left text-sm">
                    <thead>
                      <tr className="border-border text-passive-1 border-b text-xs">
                        <th className="py-2 pr-3 font-medium">Label</th>
                        <th className="py-2 pr-3 font-medium">Uses</th>
                        <th className="py-2 pr-3 font-medium">Status</th>
                        <th className="py-2 pr-3 font-medium">Expires</th>
                        <th className="py-2 pr-3 font-medium">Domain lock</th>
                        <th className="py-2 pr-3 font-medium">Created</th>
                        <th className="py-2 pr-3 font-medium"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-border divide-y">
                      {inviteLinks.map((link) => {
                        const rowBusy = revokingInviteUuid === link.uuid
                        return (
                          <tr key={link.uuid}>
                            <td className="py-2 pr-3">{link.label && link.label.trim() !== '' ? link.label : '—'}</td>
                            <td className="py-2 pr-3 tabular-nums">
                              {inviteLinkUsesLabel(link.usedCount, link.maxUses)}
                            </td>
                            <td className="py-2 pr-3">
                              <span
                                className={`inline-block rounded px-2 py-0.5 text-xs font-bold whitespace-nowrap ${inviteLinkStatusChipClass(
                                  link.status,
                                )}`}
                              >
                                {inviteLinkStatusLabel(link.status)}
                              </span>
                            </td>
                            <td className="py-2 pr-3 text-xs">{formatInviteLinkDate(link.expiresAt, 'Never')}</td>
                            <td className="py-2 pr-3 text-xs">
                              {link.allowedDomain && link.allowedDomain.trim() !== '' ? link.allowedDomain : '—'}
                            </td>
                            <td className="py-2 pr-3 text-xs">{formatInviteLinkDate(link.createdAt)}</td>
                            <td className="py-2 pr-3">
                              {link.status !== 'revoked' && (
                                <div className="flex items-center gap-2">
                                  {rowBusy && <Spinner className="h-4 w-4" />}
                                  <Button
                                    small
                                    colorStyle="danger"
                                    label="Revoke"
                                    disabled={rowBusy}
                                    onClick={() => void revokeInviteLink(link)}
                                  />
                                </div>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </PreferencesSegment>

        <HorizontalSeparator classes="my-4" />

        {/* ===== Standard Red Notes: APPROVAL QUEUE (t69) ===== */}
        <PreferencesSegment>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Title>Approval queue</Title>
              <SourceChip sources={settingsSources} keys={['registration.approvalRequired']} />
            </div>
            {settingsLoading ? (
              <Spinner className="h-5 w-5" />
            ) : settingsNotAvailable ? null : (
              <Switch
                checked={Boolean(serverSettings?.registration?.approvalRequired)}
                onChange={(checked) => void saveApprovalRequired(checked)}
              />
            )}
          </div>
          <Text className="mt-1 text-xs">
            When on, a new signup is created but cannot sign in until an admin approves it below. Existing accounts are
            unaffected. Signups made through an admin invite link above are auto-approved (issuing the link is itself
            the vetting step).
          </Text>

          <Subtitle className="mt-4">Pending approvals</Subtitle>
          {pendingUsersNotAvailable ? (
            <Text className="text-passive-1 mt-2 text-xs">
              The approval queue is not available on this server. Update the server image to review pending signups from
              here.
            </Text>
          ) : pendingUsersLoading ? (
            <Spinner className="mt-2 h-5 w-5" />
          ) : pendingUsers.length === 0 ? (
            <Text className="text-passive-1 mt-2 text-xs">No signups are awaiting approval.</Text>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[32rem] text-left text-sm">
                <thead>
                  <tr className="border-border text-passive-1 border-b text-xs">
                    <th className="py-2 pr-3 font-medium">Email</th>
                    <th className="py-2 pr-3 font-medium">Requested</th>
                    <th className="py-2 pr-3 font-medium"></th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {pendingUsers.map((row) => {
                    const approveBusy = pendingActionInFlight === `approve:${row.uuid}`
                    const rejectBusy = pendingActionInFlight === `reject:${row.uuid}`
                    const rowBusy = approveBusy || rejectBusy
                    return (
                      <tr key={row.uuid}>
                        <td className="py-2 pr-3">{row.email}</td>
                        <td className="py-2 pr-3 text-xs">{formatInviteLinkDate(row.createdAt)}</td>
                        <td className="py-2 pr-3">
                          <div className="flex items-center gap-2">
                            {rowBusy && <Spinner className="h-4 w-4" />}
                            <Button
                              small
                              colorStyle="success"
                              label="Approve"
                              disabled={rowBusy}
                              onClick={() => void approvePendingUser(row)}
                            />
                            <Button
                              small
                              colorStyle="danger"
                              label="Reject"
                              disabled={rowBusy}
                              onClick={() => void rejectPendingUser(row)}
                            />
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </PreferencesSegment>

        <HorizontalSeparator classes="my-4" />

        {/* ===== Standard Red Notes: account limits + signup window (t69) ===== */}
        <PreferencesSegment>
          <Title>Account limits &amp; signup window</Title>
          <Text>
            A global cap on total accounts, an optional open/close window for signups, and the per-user quota for
            self-serve referral invites. Saved values override the matching environment variable until cleared.
          </Text>
          {settingsLoading ? (
            <Spinner className="mt-3 h-5 w-5" />
          ) : settingsNotAvailable ? (
            <Text className="mt-3">
              Editable server settings are not available on this server (the /v1/admin/server-settings endpoint is
              missing).
            </Text>
          ) : settingsError ? (
            <>
              <Text className="text-danger mt-3">{settingsError}</Text>
              <div className="mt-2">
                <Button label="Retry" onClick={() => void loadServerSettings()} />
              </div>
            </>
          ) : (
            <div className="mt-3 flex flex-col gap-4">
              {/* Global max-total-accounts cap */}
              <div>
                <div className="flex items-center gap-2">
                  <Text className="text-passive-1 text-xs font-medium">Maximum total accounts</Text>
                  <SourceChip sources={settingsSources} keys={['registration.maxTotalAccounts']} />
                </div>
                <Text className="text-passive-1 mt-1 text-xs">
                  Hard cap on the total number of accounts on this instance. 0 or blank means unlimited. Enforcement
                  fails open — a counting error never blocks a signup.
                </Text>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <DecoratedInput
                    className={{ container: 'w-40 max-w-full' }}
                    placeholder="0 (no cap)"
                    value={maxTotalAccounts}
                    onChange={setMaxTotalAccounts}
                    onEnter={() => void saveMaxTotalAccounts()}
                    disabled={settingsSaving}
                  />
                  <Button
                    label={settingsSaving ? 'Saving…' : 'Save'}
                    onClick={() => void saveMaxTotalAccounts()}
                    disabled={settingsSaving}
                  />
                </div>
              </div>

              {/* Signup window (UTC) */}
              <div className="border-border border-t pt-4">
                <Subtitle>Signup window</Subtitle>
                <Text className="text-passive-1 mt-1 text-xs">
                  Allow signups only between an open and a close time. Leave a side blank to leave it open-ended; leave
                  both blank for always-open. <strong>Times are in UTC</strong> and evaluated against the server clock —
                  set them relative to the UTC time shown below. (If the server clock is wrong, the window shifts with
                  it.)
                </Text>
                <Text className="text-info mt-1 text-xs font-medium">
                  Current UTC time (this browser): {formatUtcClock(utcNowMs)}
                </Text>

                <div className="mt-3 flex flex-wrap items-end gap-4">
                  <div className="text-passive-1 flex flex-col text-xs">
                    <div className="flex items-center gap-2">
                      Opens at (UTC)
                      <SourceChip sources={settingsSources} keys={['registration.signupsOpenAt']} />
                    </div>
                    <input
                      type="datetime-local"
                      aria-label="Signup window opens at (UTC)"
                      className="border-border bg-default text-foreground mt-1 rounded border p-2 text-sm"
                      value={signupsOpenAt}
                      onChange={(event) => setSignupsOpenAt(event.target.value)}
                      disabled={settingsSaving}
                    />
                    <Button
                      className="mt-2 self-start"
                      label={settingsSaving ? 'Saving…' : 'Save open time'}
                      onClick={() => void saveSignupsOpenAt()}
                      disabled={settingsSaving}
                    />
                  </div>
                  <div className="text-passive-1 flex flex-col text-xs">
                    <div className="flex items-center gap-2">
                      Closes at (UTC)
                      <SourceChip sources={settingsSources} keys={['registration.signupsCloseAt']} />
                    </div>
                    <input
                      type="datetime-local"
                      aria-label="Signup window closes at (UTC)"
                      className="border-border bg-default text-foreground mt-1 rounded border p-2 text-sm"
                      value={signupsCloseAt}
                      onChange={(event) => setSignupsCloseAt(event.target.value)}
                      disabled={settingsSaving}
                    />
                    <Button
                      className="mt-2 self-start"
                      label={settingsSaving ? 'Saving…' : 'Save close time'}
                      onClick={() => void saveSignupsCloseAt()}
                      disabled={settingsSaving}
                    />
                  </div>
                </div>
              </div>

              {/* Per-user self-serve invite quota */}
              <div className="border-border border-t pt-4">
                <div className="flex items-center gap-2">
                  <Text className="text-passive-1 text-xs font-medium">Invites per user</Text>
                  <SourceChip sources={settingsSources} keys={['registration.invitesPerUser']} />
                </div>
                <Text className="text-passive-1 mt-1 text-xs">
                  How many active invite links each normal user may hold, letting them invite others without an admin. 0
                  or blank disables self-serve referral invites (only admins can create links).
                </Text>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <DecoratedInput
                    className={{ container: 'w-40 max-w-full' }}
                    placeholder="0 (disabled)"
                    value={invitesPerUser}
                    onChange={setInvitesPerUser}
                    onEnter={() => void saveInvitesPerUser()}
                    disabled={settingsSaving}
                  />
                  <Button
                    label={settingsSaving ? 'Saving…' : 'Save'}
                    onClick={() => void saveInvitesPerUser()}
                    disabled={settingsSaving}
                  />
                </div>
              </div>
            </div>
          )}
        </PreferencesSegment>
      </TabPanel>

      {/* ================= INTEGRATIONS ================= */}
      <TabPanel state={subTab} id="integrations">
        {settingsLoading || settingsNotAvailable || settingsError || !serverSettings ? (
          <PreferencesSegment>
            <Title>Integrations</Title>
            <Text className="text-passive-1 mt-3">
              {settingsLoading
                ? 'Loading integration settings…'
                : 'Integration settings (OCR, Workflows) are unavailable until this server reports editable settings.'}
            </Text>
          </PreferencesSegment>
        ) : (
          <>
            <PreferencesSegment>
              <Title>OCR (text extraction)</Title>
              <Text>
                Two independent OCR paths. <strong>Server-side OCR</strong> uploads decrypted PDF page images to this
                server for recognition — that content <strong>leaves end-to-end encryption</strong>, exactly like the AI
                assistant, so it is off by default and additionally gated per user (Users tab).{' '}
                <strong>Browser OCR</strong> runs entirely on the device and never leaves it. Server-side changes apply
                immediately; browser-OCR changes apply on the next page load.
              </Text>
              <div className="mt-3 flex flex-col gap-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex min-w-0 flex-col">
                    <div className="flex items-center gap-2">
                      <Subtitle>Server-side OCR</Subtitle>
                      <SourceChip sources={settingsSources} keys={['ocr.serverEnabled']} />
                    </div>
                    <Text className="mt-1 text-xs">
                      Master switch for the <code>/v1/ocr/recognize</code> endpoint (OCR_SERVER_ENABLED). A user must
                      also be allowed on the Users tab before it is offered to them.
                    </Text>
                  </div>
                  {settingsSaving ? (
                    <Spinner className="h-5 w-5 shrink-0" />
                  ) : (
                    <Switch
                      checked={Boolean(serverSettings?.ocr?.serverEnabled)}
                      onChange={(checked) => void toggleOcrServerEnabled(checked)}
                    />
                  )}
                </div>

                <div>
                  <div className="flex items-center gap-2">
                    <Subtitle>Server OCR default language</Subtitle>
                    <SourceChip sources={settingsSources} keys={['ocr.defaultLanguage']} />
                  </div>
                  <Text className="mt-1 text-xs">
                    Tesseract language code used when a request does not specify one (e.g. <code>eng</code> or{' '}
                    <code>eng+deu</code>). Leave empty and save to clear the override.
                  </Text>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <DecoratedInput
                      className={{ container: 'w-48 max-w-full' }}
                      placeholder="eng"
                      value={ocrDefaultLanguage}
                      onChange={setOcrDefaultLanguage}
                      onEnter={() => void saveOcrDefaultLanguage()}
                      disabled={settingsSaving}
                    />
                    <Button
                      label={settingsSaving ? 'Saving…' : 'Save'}
                      onClick={() => void saveOcrDefaultLanguage()}
                      disabled={settingsSaving}
                    />
                  </div>
                </div>

                <div className="flex flex-wrap gap-6">
                  <div>
                    <div className="flex items-center gap-2">
                      <Subtitle>Max pages / request</Subtitle>
                      <SourceChip sources={settingsSources} keys={['ocr.maxPages']} />
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <DecoratedInput
                        className={{ container: 'w-32 max-w-full' }}
                        placeholder="50"
                        value={ocrMaxPages}
                        onChange={setOcrMaxPages}
                        onEnter={() => void saveOcrMaxPages()}
                        disabled={settingsSaving}
                      />
                      <Button label="Save" onClick={() => void saveOcrMaxPages()} disabled={settingsSaving} />
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <Subtitle>Max image bytes / page</Subtitle>
                      <SourceChip sources={settingsSources} keys={['ocr.maxImageBytes']} />
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <DecoratedInput
                        className={{ container: 'w-40 max-w-full' }}
                        placeholder="12582912"
                        value={ocrMaxImageBytes}
                        onChange={setOcrMaxImageBytes}
                        onEnter={() => void saveOcrMaxImageBytes()}
                        disabled={settingsSaving}
                      />
                      <Button label="Save" onClick={() => void saveOcrMaxImageBytes()} disabled={settingsSaving} />
                    </div>
                  </div>
                </div>

                <HorizontalSeparator classes="my-1" />

                <div className="flex items-center justify-between gap-4">
                  <div className="flex min-w-0 flex-col">
                    <div className="flex items-center gap-2">
                      <Subtitle>Browser (on-device) OCR</Subtitle>
                      <SourceChip sources={settingsSources} keys={['ocr.clientEnabled']} />
                    </div>
                    <Text className="mt-1 text-xs">
                      Offers the client-side "Extract text (OCR)" action (OCR_ENABLED). Nothing leaves the device.
                      Applies on the next page load.
                    </Text>
                  </div>
                  {settingsSaving ? (
                    <Spinner className="h-5 w-5 shrink-0" />
                  ) : (
                    <Switch
                      checked={Boolean(serverSettings?.ocr?.clientEnabled)}
                      onChange={(checked) => void toggleOcrClientEnabled(checked)}
                    />
                  )}
                </div>

                <div>
                  <div className="flex items-center gap-2">
                    <Subtitle>Browser OCR default language</Subtitle>
                    <SourceChip sources={settingsSources} keys={['ocr.clientDefaultLanguage']} />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <DecoratedInput
                      className={{ container: 'w-48 max-w-full' }}
                      placeholder="eng"
                      value={ocrClientDefaultLanguage}
                      onChange={setOcrClientDefaultLanguage}
                      onEnter={() => void saveOcrClientDefaultLanguage()}
                      disabled={settingsSaving}
                    />
                    <Button
                      label={settingsSaving ? 'Saving…' : 'Save'}
                      onClick={() => void saveOcrClientDefaultLanguage()}
                      disabled={settingsSaving}
                    />
                  </div>
                </div>
              </div>
            </PreferencesSegment>

            <HorizontalSeparator classes="my-4" />
            <PreferencesSegment>
              <Title>Workflows (n8n automation)</Title>
              <Text>
                The n8n-backed automation engine. The master switch and internal engine URL apply immediately; per-user
                access is still managed on the Users tab. The editor-proxy path is bound when the gateway starts, so a
                change to it only takes effect after the gateway restarts.
              </Text>
              <div className="mt-3 flex flex-col gap-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex min-w-0 flex-col">
                    <div className="flex items-center gap-2">
                      <Subtitle>Workflows enabled</Subtitle>
                      <SourceChip sources={settingsSources} keys={['workflows.enabled']} />
                    </div>
                    <Text className="mt-1 text-xs">
                      Master switch (WORKFLOWS_ENABLED). A user must also be enabled on the Users tab.
                    </Text>
                  </div>
                  {settingsSaving ? (
                    <Spinner className="h-5 w-5 shrink-0" />
                  ) : (
                    <Switch
                      checked={Boolean(serverSettings?.workflows?.enabled)}
                      onChange={(checked) => void toggleWorkflowsEnabled(checked)}
                    />
                  )}
                </div>

                <div>
                  <div className="flex items-center gap-2">
                    <Subtitle>Internal n8n URL</Subtitle>
                    <SourceChip sources={settingsSources} keys={['workflows.n8nUrl']} />
                  </div>
                  <Text className="mt-1 text-xs">
                    The engine's address on the internal network (WORKFLOWS_N8N_URL). The editor is only reachable
                    through the authenticated gateway proxy. Leave empty and save to clear the override.
                  </Text>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <DecoratedInput
                      className={{ container: 'w-96 max-w-full' }}
                      placeholder="http://n8n:5678"
                      value={workflowsN8nUrl}
                      onChange={setWorkflowsN8nUrl}
                      onEnter={() => void saveWorkflowsN8nUrl()}
                      disabled={settingsSaving}
                    />
                    <Button
                      label={settingsSaving ? 'Saving…' : 'Save'}
                      onClick={() => void saveWorkflowsN8nUrl()}
                      disabled={settingsSaving}
                    />
                  </div>
                </div>

                <div>
                  <div className="flex items-center gap-2">
                    <Subtitle>Editor proxy path</Subtitle>
                    <SourceChip sources={settingsSources} keys={['workflows.uiBasePath']} />
                  </div>
                  <Text className="mt-1 text-xs">
                    Same-origin path the embedded editor loads (WORKFLOWS_UI_BASE_PATH).{' '}
                    <strong>Applies on the next gateway restart.</strong> Leave empty and save to clear the override.
                  </Text>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <DecoratedInput
                      className={{ container: 'w-64 max-w-full' }}
                      placeholder="/workflows-ui"
                      value={workflowsUiBasePath}
                      onChange={setWorkflowsUiBasePath}
                      onEnter={() => void saveWorkflowsUiBasePath()}
                      disabled={settingsSaving}
                    />
                    <Button
                      label={settingsSaving ? 'Saving…' : 'Save'}
                      onClick={() => void saveWorkflowsUiBasePath()}
                      disabled={settingsSaving}
                    />
                  </div>
                </div>

                <div>
                  <div className="flex items-center gap-2">
                    <Subtitle>Editor cookie lifetime (seconds)</Subtitle>
                    <SourceChip sources={settingsSources} keys={['workflows.uiTokenTtlSeconds']} />
                  </div>
                  <Text className="mt-1 text-xs">
                    How long an editor-access cookie stays valid (WORKFLOWS_UI_TOKEN_TTL_SECONDS). Applies to newly
                    issued cookies.
                  </Text>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <DecoratedInput
                      className={{ container: 'w-40 max-w-full' }}
                      placeholder="43200"
                      value={workflowsUiTokenTtl}
                      onChange={setWorkflowsUiTokenTtl}
                      onEnter={() => void saveWorkflowsUiTokenTtl()}
                      disabled={settingsSaving}
                    />
                    <Button
                      label={settingsSaving ? 'Saving…' : 'Save'}
                      onClick={() => void saveWorkflowsUiTokenTtl()}
                      disabled={settingsSaving}
                    />
                  </div>
                </div>
              </div>
            </PreferencesSegment>
          </>
        )}
      </TabPanel>

      {/* ================= LOGGING ================= */}
      <TabPanel state={subTab} id="logging">
        <PreferencesSegment>
          <Title>Logging</Title>
          <Text>
            Runtime log verbosity for the server. Changing this alters <strong>what the server writes</strong> to its
            logs and takes effect within about 30 seconds — no restart or redeploy. This is distinct from the level
            filter on the Logs tab, which only changes which already-written lines are displayed.
          </Text>
          {settingsLoading ? (
            <Spinner className="mt-3 h-5 w-5" />
          ) : settingsNotAvailable ? (
            <Text className="mt-3">
              Editable server settings are not available on this server (the /v1/admin/server-settings endpoint is
              missing), so the log level cannot be changed from here.
            </Text>
          ) : settingsError ? (
            <>
              <Text className="text-danger mt-3">{settingsError}</Text>
              <div className="mt-2">
                <Button label="Retry" onClick={() => void loadServerSettings()} />
              </div>
            </>
          ) : (
            <div className="mt-3 flex flex-col gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <Subtitle>Log level</Subtitle>
                  <SourceChip sources={settingsSources} keys={['logging.level']} />
                </div>
                <Text className="mt-1 text-xs">
                  From least to most verbose: error, warn, info, http, verbose, debug, silly. The default is info.
                </Text>
                <div className="mt-2 w-96 max-w-full">
                  <Dropdown
                    label="Server log level"
                    items={LOG_LEVEL_OPTIONS.map((level) => ({ label: level, value: level }))}
                    value={serverSettings?.logging?.level ?? 'info'}
                    onChange={(level) => void saveLoggingLevel(level)}
                    disabled={settingsSaving}
                  />
                </div>
              </div>
              <Text className="text-passive-1 text-xs">
                Scope: this control changes the <strong>api-gateway</strong> and <strong>auth</strong> service loggers
                (the highest-value surfaces). Other services keep honoring their <code>LOG_LEVEL</code> environment
                variable until a later release adds them. In deployments where services do not share the settings
                volume, this only affects services that can read the overlay.
              </Text>
            </div>
          )}
        </PreferencesSegment>
      </TabPanel>
    </>
  )
}

export default AdminServerTab
