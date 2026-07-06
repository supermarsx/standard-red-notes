import { FunctionComponent, ReactNode, useCallback, useEffect, useState } from 'react'
import { isErrorResponse } from '@standardnotes/snjs'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import Spinner from '@/Components/Spinner/Spinner'
import { filterSecurityAuditEntries, registrationBlockSource, registrationIsOpen } from './adminSecurityHelpers'

// Must match the server's RoleName.NAMES.AdminUser value (the admin role
// granted to ADMIN_EMAILS at sign-in).
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
    <span className={`inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs font-bold ${className}`}>
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
      {detail ? <Text className="text-xs text-passive-1">{detail}</Text> : null}
    </div>
    <div className="shrink-0">{chip}</div>
  </div>
)

const formatTimestamp = (createdAt: string): string => {
  const date = new Date(createdAt)
  return Number.isNaN(date.getTime()) ? createdAt : date.toLocaleString()
}

/**
 * Security overview: a Phase-1 CENTRALISATION of the app's already-exposed
 * security-relevant server state, pulled from the existing admin endpoints
 * (registration flag, server status/settings, audit log, users list). It is an
 * at-a-glance posture view — the actual controls stay on their own tabs, and
 * this tab links to each. No new server endpoints are introduced; the
 * anti-abuse / bans section is a clearly-labeled placeholder for a later wave.
 * Loaded lazily — this component only mounts when the Security tab is opened.
 */
const AdminSecurityTab: FunctionComponent<Props> = ({ application, noteIfForbidden, goToTab }) => {
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

  useEffect(() => {
    void loadRegistration()
    void loadStatus()
    void loadAdminCount()
    void loadSecurityEvents()
  }, [loadRegistration, loadStatus, loadAdminCount, loadSecurityEvents])

  const refreshAll = useCallback(() => {
    void loadRegistration()
    void loadStatus()
    void loadAdminCount()
    void loadSecurityEvents()
  }, [loadRegistration, loadStatus, loadAdminCount, loadSecurityEvents])

  const signupsOpen = registration ? registrationIsOpen(registration.persistedDisabled, registration.envDisabled) : null
  const blockSource = registration
    ? registrationBlockSource(registration.persistedDisabled, registration.envDisabled)
    : null

  const authRedis = health?.auth?.checks && 'redis' in health.auth.checks ? health.auth.checks.redis : null
  const gatewayRedis = health?.gateway?.redis ?? null

  return (
    <>
      <PreferencesSegment>
        <div className="flex items-center justify-between gap-2">
          <Title>Security overview</Title>
          <Button label="Refresh" onClick={refreshAll} disabled={statusLoading || auditLoading} small />
        </div>
        <Text>
          An at-a-glance view of this instance&apos;s security posture, pulled together from settings that already live
          across the other Admin tabs. This is a read-only summary &mdash; each item links to where its control actually
          lives.
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
          Admin access is the <strong>{ADMIN_USER}</strong> role. On sign-in, any account whose email is listed
          in the server&apos;s <strong>ADMIN_EMAILS</strong> environment variable is granted this role; it can also be
          assigned directly or via a group on the Groups &amp; roles tab. Every admin action is re-verified against this
          role on the server, so removing an email from ADMIN_EMAILS (or the role) revokes access on the next session
          refresh.
        </Text>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button label="Review admins in Users" onClick={() => goToTab('users')} small />
          <Button label="Roles & groups" onClick={() => goToTab('groups')} small />
        </div>
      </PreferencesSegment>

      <HorizontalSeparator classes="my-4" />

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
          end-to-end-encrypted boundary for a server-side feature. Read-only here; each is configured on the tab noted.
        </Text>
        {statusLoading ? (
          <Spinner className="mt-3 h-5 w-5" />
        ) : statusError ? (
          <Text className="mt-3 text-danger">{statusError}</Text>
        ) : (
          <div className="mt-3 divide-y divide-border rounded border border-border px-3">
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
              detail="When on, note data can be sent to the configured workflow engine. Off keeps data in-app. (Server tab)"
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
          Sessions are backed by refreshable access/refresh tokens issued by the auth server. Token lifetimes are fixed
          in the server configuration and are not exposed to this panel. The session/token cache state (Redis) is shown
          below when the server reports it.
        </Text>
        {statusLoading ? (
          <Spinner className="mt-3 h-5 w-5" />
        ) : (
          <div className="mt-3 divide-y divide-border rounded border border-border px-3">
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

      {/* --- Recent security events --------------------------------------- */}
      <PreferencesSegment>
        <div className="flex items-center justify-between gap-2">
          <Subtitle>Recent security events</Subtitle>
          <Button label="Open full audit log" onClick={() => goToTab('audit')} small />
        </div>
        <Text className="mt-1">
          The latest security-relevant entries from the audit log (sign-ins, role, ban, 2FA and registration changes).
          Newest first; the full, paginated record lives on the Audit log tab.
        </Text>
        {auditLoading ? (
          <Spinner className="mt-3 h-5 w-5" />
        ) : auditError ? (
          <Text className="mt-3 text-danger">{auditError}</Text>
        ) : securityEvents.length === 0 ? (
          <Text className="mt-3">No recent security-relevant events in the latest audit entries.</Text>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {securityEvents.map((entry) => (
              <div key={entry.uuid} className="rounded border border-border p-2">
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

      <HorizontalSeparator classes="my-4" />

      {/* --- Anti-abuse placeholder --------------------------------------- */}
      <PreferencesSegment>
        <div className="flex items-center justify-between gap-2">
          <Subtitle>Anti-abuse &amp; rate limiting</Subtitle>
          <span className="inline-block whitespace-nowrap rounded bg-passive-4 px-2 py-0.5 text-xs font-bold text-foreground">
            Coming soon
          </span>
        </div>
        <Text className="mt-1">
          Runtime controls for IP bans, login rate limiting and abuse thresholds are not yet configurable from this
          panel. Today these are governed by the server environment and the auth service&apos;s built-in limits. A later
          release will surface them here; account bans can already be applied per user from the Users tab.
        </Text>
      </PreferencesSegment>

      <HorizontalSeparator classes="my-4" />

      {/* --- Configured-via-env honesty note ------------------------------ */}
      <PreferencesSegment>
        <Subtitle>Configured via the server environment</Subtitle>
        <Text className="mt-1">
          Several security-relevant settings are intentionally not runtime-editable and are changed only by editing the
          server environment and redeploying: <strong>ADMIN_EMAILS</strong> (who is an admin),{' '}
          <strong>DISABLE_USER_REGISTRATION</strong> (hard signup block), token lifetimes, and the OCR / Workflows /
          AI-provider master switches shown above. This tab reflects their live values but does not change them.
        </Text>
      </PreferencesSegment>
    </>
  )
}

export default AdminSecurityTab
