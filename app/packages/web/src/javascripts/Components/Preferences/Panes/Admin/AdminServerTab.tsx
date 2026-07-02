import { FunctionComponent, useCallback, useEffect, useState } from 'react'
import { isErrorResponse } from '@standardnotes/snjs'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import Switch from '@/Components/Switch/Switch'
import Spinner from '@/Components/Spinner/Spinner'
import { ToastType, addToast } from '@standardnotes/toast'
import { ServerService, serviceStatusChipClass, serviceStatusLabel } from './adminHelpers'

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

  useEffect(() => {
    void loadRegistrationFlag()
    void loadServerStatus()
  }, [loadRegistrationFlag, loadServerStatus])

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
          <div className="mt-3 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <Text>Auth server (accounts, sessions, settings)</Text>
              <StateChip state={auth ? Boolean(auth.reachable) : null} on="Reachable" off="Unreachable" />
            </div>
            {auth?.reachable && auth.checks && (
              <>
                {'db' in auth.checks && (
                  <div className="flex items-center justify-between gap-2 pl-4">
                    <Text>Database</Text>
                    <StateChip state={auth.checks.db} />
                  </div>
                )}
                {'redis' in auth.checks && (
                  <div className="flex items-center justify-between gap-2 pl-4">
                    <Text>Cache (Redis)</Text>
                    <StateChip state={auth.checks.redis} />
                  </div>
                )}
              </>
            )}
            <div className="flex items-center justify-between gap-2">
              <Text>Gateway cache (Redis)</Text>
              <StateChip state={gatewayRedis ?? null} unknown="Not configured" />
            </div>

            {services.length > 0 && (
              <>
                <HorizontalSeparator classes="my-2" />
                <Text>All services</Text>
                <div className="flex flex-wrap gap-2">
                  {services.map((service) => (
                    <span
                      key={service.name}
                      title={service.detail ?? serviceStatusLabel(service.status)}
                      className={`inline-flex items-center gap-1 whitespace-nowrap rounded px-2 py-0.5 text-xs font-bold ${serviceStatusChipClass(
                        service.status,
                      )}`}
                    >
                      {service.name}: {serviceStatusLabel(service.status)}
                    </span>
                  ))}
                </div>
                {services.some((service) => service.detail) && (
                  <div className="mt-1 flex flex-col gap-0.5">
                    {services
                      .filter((service) => service.detail)
                      .map((service) => (
                        <Text key={service.name} className="text-xs">
                          <strong>{service.name}</strong>: {service.detail}
                        </Text>
                      ))}
                  </div>
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
    </>
  )
}

export default AdminServerTab
