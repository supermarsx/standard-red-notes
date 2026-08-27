import { FunctionComponent, ReactNode, useCallback, useEffect, useState } from 'react'
import { isErrorResponse } from '@standardnotes/snjs'
import { confirmDialog } from '@standardnotes/ui-services'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import Spinner from '@/Components/Spinner/Spinner'
import Icon from '@/Components/Icon/Icon'
import TabList from '@/Components/Tabs/TabList'
import Tab from '@/Components/Tabs/Tab'
import TabPanel from '@/Components/Tabs/TabPanel'
import { useTabState } from '@/Components/Tabs/useTabState'
import { filterSecurityAuditEntries, registrationBlockSource, registrationIsOpen } from './adminSecurityHelpers'

// Must match the server's persisted RoleName.NAMES.AdminUser value.
const ADMIN_USER = 'ADMIN_USER'

// How many recent security-relevant audit rows to preview here. The full,
// paginated log lives on the Audit tab.
const SECURITY_EVENTS_PREVIEW = 6
// The audit page we scan for security-relevant events (the newest slice).
const AUDIT_SCAN_LIMIT = 50

type Props = {
  application: WebApplication
  noteIfForbidden: (response: { status?: number }) => void
  // Switches the Admin pane to another sub-tab (where the actual control lives).
  goToTab: (id: string) => void
}

type RegistrationInfo = {
  persistedDisabled: boolean
  envDisabled: boolean | null
}

type MasterSwitches = {
  ocrServerEnabled?: boolean
  workflowsEnabled?: boolean
  assistantConfigured?: boolean
  assistantProviders?: string[]
}

type ServerHealth = {
  gateway?: { redis?: boolean | null }
  auth?: { reachable?: boolean; checks?: Record<string, boolean> }
}

type ServerStatus = {
  masterSwitches?: MasterSwitches
  health?: ServerHealth
}

type AuditEntry = {
  uuid: string
  actorUuid: string | null
  action: string
  targetType: string | null
  targetUuid: string | null
  ip: string | null
  createdAt: string
}

// Standard Red Notes: anti-abuse live view payload (GET /v1/admin/anti-abuse).
type AntiAbuseConfig = {
  enabled: boolean
  windowSeconds: number
  loginMax: number
  registrationMax: number
  userWindowSeconds: number
  userMax: number
  adaptiveEscalation: boolean
}

type AntiAbuseMetrics = {
  tierHits: Record<string, number>
  blockHits: number
  recent: Array<{ at: number; bucket: string; ip: string; method: string; path: string }>
}

type AntiAbuseView = {
  available: boolean
  config: AntiAbuseConfig | null
  ipLists: { allow: string[]; block: string[] }
  metrics: AntiAbuseMetrics
}

type LockedAccount = {
  identifier: string
  counter: number
  captchaCounter: number
  ttlSeconds: number
  locked: boolean
}

type LockedAccountsView = {
  available: boolean
  accounts: LockedAccount[]
}

/** Small colored posture chip: green = safe/on, red = attention/off, neutral = unknown. */
const PostureChip: FunctionComponent<{
  state: boolean | null | undefined
  on?: string
  off?: string
  unknown?: string
  // When true, the "on" state is the reassuring (green) one; when false the
  // "off" state is green instead (e.g. "OCR off" is the privacy-safe state).
  onIsGood?: boolean
}> = ({ state, on = 'On', off = 'Off', unknown = 'Unknown', onIsGood = true }) => {
  const good = onIsGood ? state === true : state === false
  const bad = onIsGood ? state === false : state === true
  const className = good
    ? 'bg-success text-success-contrast'
    : bad
      ? 'bg-warning text-warning-contrast'
      : 'bg-passive-4 text-foreground'
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-bold whitespace-nowrap ${className}`}>
      {state === true ? on : state === false ? off : unknown}
    </span>
  )
}

/** One posture line: label + optional privacy note on the left, chip on the right. */
const PostureRow: FunctionComponent<{ name: ReactNode; detail?: ReactNode; chip: ReactNode }> = ({
  name,
  detail,
  chip,
}) => (
  <div className="flex items-start justify-between gap-4 py-2">
    <div className="flex min-w-0 flex-col">
      <Text>{name}</Text>
      {detail ? <Text className="text-passive-1 text-xs">{detail}</Text> : null}
    </div>
    <div className="shrink-0">{chip}</div>
  </div>
)

const formatTimestamp = (createdAt: string): string => {
  const date = new Date(createdAt)
  return Number.isNaN(date.getTime()) ? createdAt : date.toLocaleString()
}

/**
 * Current security console for the instance. The overview aggregates live
 * registration, status, audit, and administrator-role data. Dedicated subtabs
 * expose the implemented anti-abuse tier editor, IP allow/block lists, throttle
 * telemetry, locked-account listing/unlock flow, and authentication posture.
 * The component mounts only while the parent Security tab is open.
 */
const AdminSecurityTab: FunctionComponent<Props> = ({ application, noteIfForbidden, goToTab }) => {
  // Second-level tabs inside the Security pane (§2 IA): Overview / Anti-abuse &
  // rate limits / Account lockout / Authentication.
  const subTab = useTabState({ defaultTab: 'overview' })

  const [registration, setRegistration] = useState<RegistrationInfo | null>(null)
  const [registrationLoading, setRegistrationLoading] = useState(false)

  const [masterSwitches, setMasterSwitches] = useState<MasterSwitches | null>(null)
  const [health, setHealth] = useState<ServerHealth | null>(null)
  const [statusLoading, setStatusLoading] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)

  // Live count of accounts holding the internal-team (admin) role, if the
  // users-list endpoint accepts the role filter. null = not determined.
  const [adminCount, setAdminCount] = useState<number | null>(null)

  const [securityEvents, setSecurityEvents] = useState<AuditEntry[]>([])
  const [auditLoading, setAuditLoading] = useState(false)
  const [auditError, setAuditError] = useState<string | null>(null)

  // Anti-abuse: live view (config + IP lists + throttle telemetry) and its edits.
  const [antiAbuse, setAntiAbuse] = useState<AntiAbuseView | null>(null)
  const [antiAbuseLoading, setAntiAbuseLoading] = useState(false)
  const [antiAbuseError, setAntiAbuseError] = useState<string | null>(null)
  const [blockEntry, setBlockEntry] = useState('')
  const [allowEntry, setAllowEntry] = useState('')
  const [ipBusy, setIpBusy] = useState(false)
  const [configDraft, setConfigDraft] = useState<AntiAbuseConfig | null>(null)
  const [configSaving, setConfigSaving] = useState(false)

  const [lockedAccounts, setLockedAccounts] = useState<LockedAccountsView | null>(null)
  const [lockedLoading, setLockedLoading] = useState(false)
  const [lockedError, setLockedError] = useState<string | null>(null)
  const [unlockBusy, setUnlockBusy] = useState<string | null>(null)

  const loadRegistration = useCallback(async () => {
    setRegistrationLoading(true)
    try {
      const response = await application.legacyApi.adminGetRegistrationFlag()
      if (isErrorResponse(response)) {
        noteIfForbidden(response)
        return
      }
      const data = (
        response as {
          data?: {
            registrationDisabled?: boolean
            env?: { registrationDisabled?: boolean | null }
          }
        }
      ).data
      setRegistration({
        persistedDisabled: Boolean(data?.registrationDisabled),
        envDisabled: data?.env?.registrationDisabled ?? null,
      })
    } catch (error) {
      console.error(error)
    } finally {
      setRegistrationLoading(false)
    }
  }, [application, noteIfForbidden])

  const loadStatus = useCallback(async () => {
    setStatusLoading(true)
    setStatusError(null)
    try {
      const response = await application.legacyApi.adminGetServerStatus()
      if (isErrorResponse(response)) {
        noteIfForbidden(response)
        setStatusError('Could not load server status. The endpoint may not be available on this server.')
        return
      }
      const data = (response as { data?: ServerStatus }).data
      setMasterSwitches(data?.masterSwitches ?? null)
      setHealth(data?.health ?? null)
    } catch (error) {
      console.error(error)
      setStatusError('Could not load server status.')
    } finally {
      setStatusLoading(false)
    }
  }, [application, noteIfForbidden])

  const loadAdminCount = useCallback(async () => {
    try {
      const response = await application.legacyApi.adminListUsers({ role: ADMIN_USER, limit: 1, offset: 0 })
      if (isErrorResponse(response)) {
        noteIfForbidden(response)
        return
      }
      const data = (response as { data?: { total?: number } }).data
      if (typeof data?.total === 'number') {
        setAdminCount(data.total)
      }
    } catch (error) {
      console.error(error)
    }
  }, [application, noteIfForbidden])

  const loadSecurityEvents = useCallback(async () => {
    setAuditLoading(true)
    setAuditError(null)
    try {
      const response = await application.legacyApi.adminGetAuditLog({ limit: AUDIT_SCAN_LIMIT, offset: 0 })
      if (isErrorResponse(response)) {
        noteIfForbidden(response)
        setAuditError('Could not load recent security events. The audit log may not be enabled on this server.')
        return
      }
      const data = (response as { data?: { entries?: AuditEntry[] } }).data
      setSecurityEvents(filterSecurityAuditEntries(data?.entries ?? [], SECURITY_EVENTS_PREVIEW))
    } catch (error) {
      console.error(error)
      setAuditError('Could not load recent security events.')
    } finally {
      setAuditLoading(false)
    }
  }, [application, noteIfForbidden])

  const loadAntiAbuse = useCallback(async () => {
    setAntiAbuseLoading(true)
    setAntiAbuseError(null)
    try {
      const response = await application.legacyApi.adminGetAntiAbuse()
      if (isErrorResponse(response)) {
        noteIfForbidden(response)
        setAntiAbuseError('Could not load anti-abuse status. The endpoint may not be available on this server.')
        return
      }
      const data = (response as { data?: AntiAbuseView }).data ?? null
      setAntiAbuse(data)
      if (data?.config) {
        setConfigDraft(data.config)
      }
    } catch (error) {
      console.error(error)
      setAntiAbuseError('Could not load anti-abuse status.')
    } finally {
      setAntiAbuseLoading(false)
    }
  }, [application, noteIfForbidden])

  const loadLockedAccounts = useCallback(async () => {
    setLockedLoading(true)
    setLockedError(null)
    try {
      const response = await application.legacyApi.adminGetLockedAccounts()
      if (isErrorResponse(response)) {
        noteIfForbidden(response)
        setLockedError('Could not load locked accounts. The endpoint may not be available on this server.')
        return
      }
      const data = (response as { data?: LockedAccountsView }).data ?? null
      setLockedAccounts(data)
    } catch (error) {
      console.error(error)
      setLockedError('Could not load locked accounts.')
    } finally {
      setLockedLoading(false)
    }
  }, [application, noteIfForbidden])

  useEffect(() => {
    void loadRegistration()
    void loadStatus()
    void loadAdminCount()
    void loadSecurityEvents()
    void loadAntiAbuse()
    void loadLockedAccounts()
  }, [loadRegistration, loadStatus, loadAdminCount, loadSecurityEvents, loadAntiAbuse, loadLockedAccounts])

  const refreshAll = useCallback(() => {
    void loadRegistration()
    void loadStatus()
    void loadAdminCount()
    void loadSecurityEvents()
    void loadAntiAbuse()
    void loadLockedAccounts()
  }, [loadRegistration, loadStatus, loadAdminCount, loadSecurityEvents, loadAntiAbuse, loadLockedAccounts])

  const unlockAccount = useCallback(
    async (identifier: string) => {
      const confirmed = await confirmDialog({
        title: 'Unlock account',
        text: `Clear the failed-login lockout for "${identifier}"? They will be able to attempt sign-in immediately.`,
        confirmButtonText: 'Unlock account',
        confirmButtonStyle: 'danger',
      })
      if (!confirmed) {
        return
      }
      setUnlockBusy(identifier)
      setLockedError(null)
      try {
        const response = await application.legacyApi.adminUnlockAccount(identifier)
        if (isErrorResponse(response)) {
          noteIfForbidden(response)
          const message = (response as { data?: { error?: { message?: string } } }).data?.error?.message
          setLockedError(message ?? 'Could not unlock the account.')
          return
        }
        await loadLockedAccounts()
      } catch (error) {
        console.error(error)
        setLockedError('Could not unlock the account.')
      } finally {
        setUnlockBusy(null)
      }
    },
    [application, noteIfForbidden, loadLockedAccounts],
  )

  const mutateIp = useCallback(
    async (list: 'allow' | 'block', action: 'add' | 'remove', entry: string) => {
      const trimmed = entry.trim()
      if (trimmed === '') {
        return
      }
      setIpBusy(true)
      setAntiAbuseError(null)
      try {
        const response = await application.legacyApi.adminMutateAntiAbuseIp(list, action, trimmed)
        if (isErrorResponse(response)) {
          noteIfForbidden(response)
          const message = (response as { data?: { error?: { message?: string } } }).data?.error?.message
          setAntiAbuseError(message ?? 'Could not update the IP list.')
          return
        }
        const data = (response as { data?: { ipLists?: { allow: string[]; block: string[] } } }).data
        if (data?.ipLists) {
          const nextLists = data.ipLists as { allow: string[]; block: string[] }
          setAntiAbuse((prev) => (prev ? { ...prev, ipLists: nextLists } : prev))
        }
        if (action === 'add' && list === 'block') {
          setBlockEntry('')
        }
        if (action === 'add' && list === 'allow') {
          setAllowEntry('')
        }
      } catch (error) {
        console.error(error)
        setAntiAbuseError('Could not update the IP list.')
      } finally {
        setIpBusy(false)
      }
    },
    [application, noteIfForbidden],
  )

  const saveConfig = useCallback(async () => {
    if (!configDraft) {
      return
    }
    setConfigSaving(true)
    setAntiAbuseError(null)
    try {
      const response = await application.legacyApi.adminSetServerSettings({ security: { rateLimit: configDraft } })
      if (isErrorResponse(response)) {
        noteIfForbidden(response)
        const message = (response as { data?: { error?: { message?: string } } }).data?.error?.message
        setAntiAbuseError(message ?? 'Could not save the rate-limit settings.')
        return
      }
      await loadAntiAbuse()
    } catch (error) {
      console.error(error)
      setAntiAbuseError('Could not save the rate-limit settings.')
    } finally {
      setConfigSaving(false)
    }
  }, [application, configDraft, noteIfForbidden, loadAntiAbuse])

  const signupsOpen = registration ? registrationIsOpen(registration.persistedDisabled, registration.envDisabled) : null
  const blockSource = registration
    ? registrationBlockSource(registration.persistedDisabled, registration.envDisabled)
    : null

  const authRedis = health?.auth?.checks && 'redis' in health.auth.checks ? health.auth.checks.redis : null
  const gatewayRedis = health?.gateway?.redis ?? null

  return (
    <>
      <PreferencesSegment>
        <Title>Security</Title>
        <Text>
          This instance&apos;s security posture and the runtime anti-abuse controls, grouped into subtabs. The Overview
          is a read-only summary; each item links to where its control actually lives.
        </Text>
        <div className="border-border mt-3 overflow-x-auto border-b">
          <TabList state={subTab} className="flex min-w-max whitespace-nowrap">
            <Tab id="overview" className="inline-flex items-center gap-1.5 !text-xs">
              <Icon type="security" size="medium" />
              Overview
            </Tab>
            <Tab id="antiabuse" className="inline-flex items-center gap-1.5 !text-xs">
              <Icon type="list-check" size="medium" />
              Anti-abuse &amp; rate limits
            </Tab>
            <Tab id="lockout" className="inline-flex items-center gap-1.5 !text-xs">
              <Icon type="history" size="medium" />
              Account lockout
            </Tab>
            <Tab id="auth" className="inline-flex items-center gap-1.5 !text-xs">
              <Icon type="accessibility" size="medium" />
              Authentication
            </Tab>
          </TabList>
        </div>
      </PreferencesSegment>

      {/* ================= OVERVIEW ================= */}
      <TabPanel state={subTab} id="overview">
        <PreferencesSegment>
          <div className="flex items-center justify-between gap-2">
            <Title>Security overview</Title>
            <Button label="Refresh" onClick={refreshAll} disabled={statusLoading || auditLoading} small />
          </div>
          <Text>
            An at-a-glance view of this instance&apos;s security posture, pulled together from settings that already
            live across the other Admin tabs. This is a read-only summary &mdash; each item links to where its control
            actually lives.
          </Text>
        </PreferencesSegment>

        <HorizontalSeparator classes="my-4" />

        {/* --- Registration ------------------------------------------------- */}
        <PreferencesSegment>
          <div className="flex items-center justify-between gap-2">
            <Subtitle>Sign-up security</Subtitle>
            {registrationLoading ? (
              <Spinner className="h-4 w-4" />
            ) : (
              <PostureChip state={signupsOpen === null ? null : !signupsOpen} on="Signups closed" off="Signups open" />
            )}
          </div>
          <Text className="mt-1">
            {signupsOpen === null
              ? 'Whether new accounts can be created on this instance.'
              : signupsOpen
                ? 'New accounts can currently be created on this instance.'
                : blockSource === 'both'
                  ? 'New signups are blocked by both the in-app switch and the server environment (DISABLE_USER_REGISTRATION).'
                  : blockSource === 'persisted'
                    ? 'New signups are blocked by the in-app registration switch.'
                    : 'New signups are blocked by the server environment (DISABLE_USER_REGISTRATION).'}
            {registration && registration.envDisabled === null && (
              <> This server did not report its environment flag, so only the in-app switch is reflected above.</>
            )}
          </Text>
          <div className="mt-2">
            <Button label="Manage registration on the Server tab" onClick={() => goToTab('server')} small />
          </div>
        </PreferencesSegment>

        <HorizontalSeparator classes="my-4" />

        {/* --- Admin access model ------------------------------------------- */}
        <PreferencesSegment>
          <div className="flex items-center justify-between gap-2">
            <Subtitle>Administrator access model</Subtitle>
            <PostureChip
              state={adminCount === null ? null : true}
              on={`${adminCount} admin${adminCount === 1 ? '' : 's'}`}
              unknown="Count unavailable"
            />
          </div>
          <Text className="mt-1">
            Admin access is the persisted <strong>{ADMIN_USER}</strong> role. Bootstrap it locally after registration
            with <strong>srn-admin roles grant &lt;user&gt; ADMIN_USER</strong>, then manage it directly or through a
            group on the Groups &amp; roles tab. Every admin action is re-verified against this server-controlled role,
            so revoking the role takes effect on the next session refresh.
          </Text>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button label="Review admins in Users" onClick={() => goToTab('users')} small />
            <Button label="Roles & groups" onClick={() => goToTab('groups')} small />
          </div>
        </PreferencesSegment>

        <HorizontalSeparator classes="my-4" />

        {/* --- Recent security events --------------------------------------- */}
        <PreferencesSegment>
          <div className="flex items-center justify-between gap-2">
            <Subtitle>Recent security events</Subtitle>
            <Button label="Open full audit log" onClick={() => goToTab('logs')} small />
          </div>
          <Text className="mt-1">
            The latest security-relevant entries from the audit log: sign-ins and sessions, changes to sensitive
            settings (credentials, 2FA, admin feature gates), and privilege attributions (roles, group membership,
            invites, approvals) &mdash; including failed attempts. Newest first; the full, paginated record lives on the
            Logs tab.
          </Text>
          {auditLoading ? (
            <Spinner className="mt-3 h-5 w-5" />
          ) : auditError ? (
            <Text className="text-danger mt-3">{auditError}</Text>
          ) : securityEvents.length === 0 ? (
            <Text className="mt-3">No recent security-relevant events in the latest audit entries.</Text>
          ) : (
            <div className="mt-3 flex flex-col gap-2">
              {securityEvents.map((entry) => (
                <div key={entry.uuid} className="border-border rounded border p-2">
                  <div className="flex items-center justify-between gap-2">
                    <Subtitle>{entry.action}</Subtitle>
                    <Text className="text-xs">{formatTimestamp(entry.createdAt)}</Text>
                  </div>
                  <Text className="text-xs">
                    Actor: {entry.actorUuid ?? 'anonymous'}
                    {entry.targetUuid ? (
                      <>
                        {' '}
                        &rarr; {entry.targetType ?? 'target'} {entry.targetUuid}
                      </>
                    ) : null}
                    {entry.ip ? <> &middot; from {entry.ip}</> : null}
                  </Text>
                </div>
              ))}
            </div>
          )}
        </PreferencesSegment>
      </TabPanel>

      {/* ================= AUTHENTICATION ================= */}
      <TabPanel state={subTab} id="auth">
        {/* --- Two-factor authentication ------------------------------------ */}
        <PreferencesSegment>
          <Subtitle>Two-factor authentication (2FA)</Subtitle>
          <Text className="mt-1">
            2FA is opt-in per user and enforced by the auth server at sign-in. There is no instance-wide 2FA toggle to
            surface here. An admin can reset a locked-out user&apos;s 2FA from the Users tab &mdash; this clears their
            authenticator secret, so verify such requests out-of-band first. Each reset is written to the audit log.
          </Text>
          <div className="mt-2">
            <Button label="Reset a user's 2FA in Users" onClick={() => goToTab('users')} small />
          </div>
        </PreferencesSegment>

        <HorizontalSeparator classes="my-4" />

        {/* --- Data privacy / master switches ------------------------------- */}
        <PreferencesSegment>
          <Subtitle>Data privacy master switches</Subtitle>
          <Text className="mt-1">
            Operator-level switches (set in the server environment) that affect whether note content leaves the
            end-to-end-encrypted boundary for a server-side feature. Read-only here; each is configured on the tab
            noted.
          </Text>
          {statusLoading ? (
            <Spinner className="mt-3 h-5 w-5" />
          ) : statusError ? (
            <Text className="text-danger mt-3">{statusError}</Text>
          ) : (
            <div className="divide-border border-border mt-3 divide-y rounded border px-3">
              <PostureRow
                name="Server-side OCR"
                detail="When on, images are decrypted on the server to extract text — they leave the E2E boundary. Off is the privacy-safe state. (Server tab)"
                chip={
                  <PostureChip
                    state={masterSwitches ? Boolean(masterSwitches.ocrServerEnabled) : null}
                    onIsGood={false}
                  />
                }
              />
              <PostureRow
                name="Workflows / n8n"
                detail="When on, entitled users can discover the external n8n link. It does not send note data or grant n8n access; separately configured workflow credentials define any data exposure. (Server tab)"
                chip={
                  <PostureChip
                    state={masterSwitches ? Boolean(masterSwitches.workflowsEnabled) : null}
                    onIsGood={false}
                  />
                }
              />
              <PostureRow
                name="AI assistant providers"
                detail={
                  masterSwitches?.assistantConfigured && masterSwitches.assistantProviders?.length
                    ? `Configured (${masterSwitches.assistantProviders.join(
                        ', ',
                      )}). Prompts/content sent to AI go to the provider. Manage on the AI tab.`
                    : 'When configured, prompts and selected content are sent to the AI provider. Manage on the AI tab.'
                }
                chip={
                  <PostureChip
                    state={masterSwitches ? Boolean(masterSwitches.assistantConfigured) : null}
                    on="Configured"
                    off="Not configured"
                    onIsGood={false}
                  />
                }
              />
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button label="Server master switches" onClick={() => goToTab('server')} small />
            <Button label="AI settings" onClick={() => goToTab('ai')} small />
          </div>
        </PreferencesSegment>

        <HorizontalSeparator classes="my-4" />

        {/* --- Session infrastructure --------------------------------------- */}
        <PreferencesSegment>
          <Subtitle>Sessions &amp; tokens</Subtitle>
          <Text className="mt-1">
            Sessions are backed by refreshable access/refresh tokens issued by the auth server. Token lifetimes are
            fixed in the server configuration and are not exposed to this panel. The session/token cache state (Redis)
            is shown below when the server reports it.
          </Text>
          {statusLoading ? (
            <Spinner className="mt-3 h-5 w-5" />
          ) : (
            <div className="divide-border border-border mt-3 divide-y rounded border px-3">
              <PostureRow
                name="Auth session cache (Redis)"
                detail="Backs sessions and revocation."
                chip={<PostureChip state={authRedis} on="Reachable" off="Unreachable" unknown="Not reported" />}
              />
              <PostureRow
                name="Gateway cache (Redis)"
                detail="Cross-service token/session cache at the API gateway."
                chip={<PostureChip state={gatewayRedis} on="Reachable" off="Unreachable" unknown="Not configured" />}
              />
            </div>
          )}
        </PreferencesSegment>

        <HorizontalSeparator classes="my-4" />

        {/* --- Configured-via-env honesty note ------------------------------ */}
        <PreferencesSegment>
          <Subtitle>Configured via the server environment</Subtitle>
          <Text className="mt-1">
            Several security-relevant settings are intentionally not runtime-editable and are changed only by editing
            the server environment and redeploying: <strong>DISABLE_USER_REGISTRATION</strong> (hard signup block),
            token lifetimes, and the OCR / Workflows / AI-provider master switches shown above. This tab reflects their
            live values but does not change them. Administrator roles are persisted server-side and managed separately.
          </Text>
        </PreferencesSegment>
      </TabPanel>

      {/* ================= ANTI-ABUSE & RATE LIMITS ================= */}
      <TabPanel state={subTab} id="antiabuse">
        {/* --- Anti-abuse & rate limiting ----------------------------------- */}
        <PreferencesSegment>
          <div className="flex items-center justify-between gap-2">
            <Subtitle>Anti-abuse &amp; rate limiting</Subtitle>
            {antiAbuseLoading ? (
              <Spinner className="h-4 w-4" />
            ) : (
              <PostureChip
                state={antiAbuse?.config ? antiAbuse.config.enabled : null}
                on="Rate limiting on"
                off="Rate limiting off"
                unknown="Unavailable"
              />
            )}
          </div>
          <Text className="mt-1">
            Per-IP rate limiting on the unauthenticated auth surfaces (login, registration, magic-link, recovery), an
            admin-managed IP allow/block list, and live throttle counters. Tiers are tunable at runtime; a Redis outage
            fails <em>open</em> (limits and the block list are best-effort, so a cache blip never locks users out).
          </Text>

          {antiAbuseError ? <Text className="text-danger mt-3">{antiAbuseError}</Text> : null}

          {antiAbuse && !antiAbuse.available ? (
            <Text className="mt-3">
              This deployment has no Redis cache configured, so the rate-limit tiers, IP lists and telemetry are
              inactive.
            </Text>
          ) : null}

          {/* Tier configuration */}
          {configDraft ? (
            <div className="mt-4">
              <Subtitle>Rate-limit tiers</Subtitle>
              <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="flex items-center justify-between gap-2">
                  <Text>Enabled</Text>
                  <input
                    type="checkbox"
                    checked={configDraft.enabled}
                    onChange={(event) => setConfigDraft({ ...configDraft, enabled: event.target.checked })}
                  />
                </label>
                <label className="flex items-center justify-between gap-2">
                  <Text>Adaptive escalation</Text>
                  <input
                    type="checkbox"
                    checked={configDraft.adaptiveEscalation}
                    onChange={(event) => setConfigDraft({ ...configDraft, adaptiveEscalation: event.target.checked })}
                  />
                </label>
                {(
                  [
                    ['Window (seconds)', 'windowSeconds'],
                    ['Login max / window', 'loginMax'],
                    ['Registration max / window', 'registrationMax'],
                    ['Per-user window (seconds)', 'userWindowSeconds'],
                    ['Per-user max (0 = off)', 'userMax'],
                  ] as Array<[string, keyof AntiAbuseConfig]>
                ).map(([label, key]) => (
                  <label key={key} className="flex items-center justify-between gap-2">
                    <Text>{label}</Text>
                    <input
                      className="border-border bg-default w-24 rounded border px-2 py-1 text-right text-sm"
                      type="number"
                      min={0}
                      value={String(configDraft[key] as number)}
                      onChange={(event) =>
                        setConfigDraft({ ...configDraft, [key]: Math.max(0, Number(event.target.value) || 0) })
                      }
                    />
                  </label>
                ))}
              </div>
              <div className="mt-3">
                <Button
                  label={configSaving ? 'Saving…' : 'Save rate-limit tiers'}
                  onClick={() => void saveConfig()}
                  disabled={configSaving}
                  primary
                  small
                />
              </div>
            </div>
          ) : null}

          {/* IP block/allow lists */}
          {antiAbuse?.available ? (
            <div className="mt-5">
              <Subtitle>IP block list</Subtitle>
              <Text className="text-passive-1 text-xs">
                A blocklisted client IP is rejected (403) before any rate-limit tier. Accepts an IP, an IPv4 CIDR
                (a.b.c.d/24) or an IPv6 literal.
              </Text>
              <div className="mt-2 flex gap-2">
                <input
                  className="border-border bg-default min-w-0 flex-1 rounded border px-2 py-1 text-sm"
                  type="text"
                  placeholder="e.g. 203.0.113.7 or 203.0.113.0/24"
                  value={blockEntry}
                  onChange={(event) => setBlockEntry(event.target.value)}
                />
                <Button
                  label="Block"
                  onClick={() => void mutateIp('block', 'add', blockEntry)}
                  disabled={ipBusy}
                  small
                />
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {antiAbuse.ipLists.block.length === 0 ? (
                  <Text className="text-passive-1 text-xs">No blocked IPs.</Text>
                ) : (
                  antiAbuse.ipLists.block.map((entry) => (
                    <span
                      key={entry}
                      className="bg-warning text-warning-contrast inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs"
                    >
                      {entry}
                      <button
                        className="font-bold"
                        title="Unblock"
                        onClick={() => void mutateIp('block', 'remove', entry)}
                        disabled={ipBusy}
                      >
                        &times;
                      </button>
                    </span>
                  ))
                )}
              </div>

              <Subtitle className="mt-4">IP allow list</Subtitle>
              <Text className="text-passive-1 text-xs">
                An allowlisted IP bypasses the rate-limit tiers. Allow wins over block, so you cannot lock yourself out.
              </Text>
              <div className="mt-2 flex gap-2">
                <input
                  className="border-border bg-default min-w-0 flex-1 rounded border px-2 py-1 text-sm"
                  type="text"
                  placeholder="e.g. 198.51.100.0/24"
                  value={allowEntry}
                  onChange={(event) => setAllowEntry(event.target.value)}
                />
                <Button
                  label="Allow"
                  onClick={() => void mutateIp('allow', 'add', allowEntry)}
                  disabled={ipBusy}
                  small
                />
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {antiAbuse.ipLists.allow.length === 0 ? (
                  <Text className="text-passive-1 text-xs">No allowlisted IPs.</Text>
                ) : (
                  antiAbuse.ipLists.allow.map((entry) => (
                    <span
                      key={entry}
                      className="bg-success text-success-contrast inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs"
                    >
                      {entry}
                      <button
                        className="font-bold"
                        title="Remove"
                        onClick={() => void mutateIp('allow', 'remove', entry)}
                        disabled={ipBusy}
                      >
                        &times;
                      </button>
                    </span>
                  ))
                )}
              </div>
            </div>
          ) : null}

          {/* Throttle telemetry */}
          {antiAbuse?.available ? (
            <div className="mt-5">
              <Subtitle>Throttle activity (last 24h)</Subtitle>
              <div className="mt-2 flex flex-wrap gap-2">
                <span className="border-border rounded border px-2 py-0.5 text-xs">
                  IP blocks: <strong>{antiAbuse.metrics.blockHits}</strong>
                </span>
                {Object.keys(antiAbuse.metrics.tierHits).length === 0 ? (
                  <span className="border-border rounded border px-2 py-0.5 text-xs">No throttle hits recorded.</span>
                ) : (
                  Object.entries(antiAbuse.metrics.tierHits).map(([bucket, count]) => (
                    <span key={bucket} className="border-border rounded border px-2 py-0.5 text-xs">
                      {bucket}: <strong>{count}</strong>
                    </span>
                  ))
                )}
              </div>
              {antiAbuse.metrics.recent.length > 0 ? (
                <div className="mt-3 flex flex-col gap-1">
                  {antiAbuse.metrics.recent.slice(0, SECURITY_EVENTS_PREVIEW).map((event, index) => (
                    <Text key={`${event.at}-${index}`} className="text-passive-1 text-xs">
                      {formatTimestamp(new Date(event.at).toISOString())} &middot; {event.bucket} &middot; {event.ip}{' '}
                      &middot; {event.method} {event.path}
                    </Text>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </PreferencesSegment>
      </TabPanel>

      {/* ================= ACCOUNT LOCKOUT ================= */}
      <TabPanel state={subTab} id="lockout">
        <PreferencesSegment>
          <Title>Account lockout</Title>
          <Text className="mt-1">
            Accounts currently rate-limited by the failed-login lockout, and the container CLI equivalents.
          </Text>
          {/* Locked accounts (failed-login lockout) */}
          <div className="mt-5">
            <div className="flex items-center justify-between gap-2">
              <Subtitle>Locked accounts</Subtitle>
              <Button label="Refresh" onClick={() => void loadLockedAccounts()} disabled={lockedLoading} small />
            </div>
            <Text className="text-passive-1 text-xs">
              Accounts currently rate-limited by the failed-login lockout. Unlocking clears the attempt counters so the
              user can sign in again. The identifier is whatever the failed attempts were keyed on (a user id or email).
            </Text>
            {lockedError ? <Text className="text-danger mt-2">{lockedError}</Text> : null}
            {lockedLoading && !lockedAccounts ? (
              <div className="mt-2">
                <Spinner className="h-4 w-4" />
              </div>
            ) : lockedAccounts && !lockedAccounts.available ? (
              <Text className="text-passive-1 mt-2 text-xs">
                Locked-account listing is not available on this deployment (requires a Redis-backed cache).
              </Text>
            ) : lockedAccounts && lockedAccounts.accounts.length === 0 ? (
              <Text className="text-passive-1 mt-2 text-xs">No accounts are currently locked.</Text>
            ) : lockedAccounts ? (
              <div className="mt-2 flex flex-col gap-1">
                {lockedAccounts.accounts.map((account) => (
                  <div
                    key={account.identifier}
                    className="border-border flex items-center justify-between gap-2 rounded border px-2 py-1"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold">{account.identifier}</span>
                        {account.locked ? (
                          <span className="bg-danger text-danger-contrast rounded px-1.5 py-0.5 text-xs">locked</span>
                        ) : (
                          <span className="bg-warning text-warning-contrast rounded px-1.5 py-0.5 text-xs">
                            tracking
                          </span>
                        )}
                      </div>
                      <Text className="text-passive-1 text-xs">
                        attempts: {account.counter} &middot; captcha: {account.captchaCounter}
                        {account.ttlSeconds >= 0 ? <> &middot; expires in {account.ttlSeconds}s</> : null}
                      </Text>
                    </div>
                    <Button
                      label="Unlock"
                      onClick={() => void unlockAccount(account.identifier)}
                      disabled={unlockBusy === account.identifier}
                      small
                    />
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <div className="mt-3">
            <Text className="text-passive-1 text-xs">
              The same tiers, IP lists and lockout config are viewable/manageable from the container CLI:{' '}
              <code>srn-admin limits</code>, <code>srn-admin ip list</code>, <code>srn-admin ip block &lt;ip&gt;</code>.
            </Text>
          </div>
        </PreferencesSegment>
      </TabPanel>
    </>
  )
}

export default AdminSecurityTab
