import { FunctionComponent, ReactNode, useCallback, useEffect, useMemo, useState } from 'react'

import { WebApplication } from '@/Application/WebApplication'
import Button from '@/Components/Button/Button'
import DecoratedInput from '@/Components/Input/DecoratedInput'
import { Subtitle, Text } from '@/Components/Preferences/PreferencesComponents/Content'
import Spinner from '@/Components/Spinner/Spinner'

import {
  EMAIL_LOG_OUTCOMES,
  EMAIL_QUEUE_STATES,
  EMAIL_RELAY_KINDS,
  EMAIL_RELAY_PROFILE_LIMIT,
  EmailLogOutcome,
  EmailLogsResponse,
  EmailQueueItem,
  EmailQueueResponse,
  EmailQueueState,
  EmailRelayKind,
  EmailTestResult,
  RELAY_KIND_LABELS,
  RELAY_PROVIDER_HELP,
  RelayDraft,
  RelayFallbackPolicy,
  RelaysResponse,
  controlPlaneError,
  createRelayDraft,
  decodeEmailTestResult,
  decodeLogsResponse,
  decodeQueueResponse,
  decodeRelaysResponse,
  normalizeRelayPriorities,
  relayConformityChecks,
  relayIsConformant,
  relayViewToDraft,
  serializeRelayDraft,
} from './emailDeliveryModels'

type Props = {
  application: WebApplication
  noteIfForbidden: (response: { status?: number }) => void
  onAvailabilityChange?: (availability: EmailDeliveryControlPlaneAvailability) => void
}

type PanelState = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'
type ControlTab = 'relays' | 'queue' | 'logs'

export type EmailDeliveryControlPlaneAvailability = 'probing' | 'available' | 'unavailable'

type QueuePage = { items: EmailQueueItem[]; nextCursor?: string }
type QueuePages = Record<EmailQueueState, QueuePage>

const emptyQueuePages = (): QueuePages => ({
  ready: { items: [] },
  leased: { items: [] },
  dead: { items: [] },
})

const selectClassName =
  'w-full rounded border border-border bg-default px-2 py-1.5 text-sm text-text focus:outline-none focus:ring-2 focus:ring-info'

const FormField: FunctionComponent<{
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: 'text' | 'number' | 'password'
  disabled?: boolean
  hint?: string
}> = ({ id, label, value, onChange, placeholder, type = 'text', disabled, hint }) => (
  <div>
    <label htmlFor={id} className="mb-1 block text-sm font-semibold">
      {label}
    </label>
    <DecoratedInput
      id={id}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      type={type}
      autocomplete={false}
      disabled={disabled}
    />
    {hint ? <Text className="mt-1 text-xs">{hint}</Text> : null}
  </div>
)

const SafeDate: FunctionComponent<{ value?: string }> = ({ value }) => {
  if (!value) {
    return <span>Not scheduled</span>
  }
  const date = new Date(value)
  return <span>{Number.isNaN(date.getTime()) ? 'Invalid timestamp' : date.toLocaleString()}</span>
}

const StatusChip: FunctionComponent<{ children: ReactNode; tone?: 'normal' | 'success' | 'warning' | 'danger' }> = ({
  children,
  tone = 'normal',
}) => {
  const colors =
    tone === 'success'
      ? 'bg-success-faded text-success'
      : tone === 'warning'
        ? 'bg-warning-faded text-warning'
        : tone === 'danger'
          ? 'bg-danger-faded text-danger'
          : 'bg-passive-4 text-text'
  return <span className={`rounded px-2 py-0.5 text-xs font-bold ${colors}`}>{children}</span>
}

const ProviderFields: FunctionComponent<{
  relay: RelayDraft
  disabled: boolean
  update: (patch: Partial<RelayDraft>) => void
}> = ({ relay, disabled, update }) => {
  const secretChanged = (patch: Partial<RelayDraft>) => update({ ...patch, clearCredentials: false })

  if (relay.kind === 'smtp') {
    return (
      <>
        <FormField
          id={`relay-${relay.id}-host`}
          label="SMTP host"
          value={relay.host}
          onChange={(host) => update({ host })}
          placeholder="smtp.example.com"
          disabled={disabled}
        />
        <FormField
          id={`relay-${relay.id}-port`}
          label="SMTP port"
          value={String(relay.port)}
          onChange={(value) => update({ port: Number(value) })}
          type="number"
          disabled={disabled}
        />
        <FormField
          id={`relay-${relay.id}-username`}
          label="Username (optional)"
          value={relay.username}
          onChange={(username) => update({ username })}
          disabled={disabled}
        />
        <div>
          <label htmlFor={`relay-${relay.id}-tls`} className="mb-1 block text-sm font-semibold">
            TLS mode
          </label>
          <select
            id={`relay-${relay.id}-tls`}
            className={selectClassName}
            value={relay.tlsMode}
            onChange={(event) => update({ tlsMode: event.target.value as RelayDraft['tlsMode'] })}
            disabled={disabled}
          >
            <option value="starttls">STARTTLS (recommended)</option>
            <option value="implicit">Implicit TLS</option>
            <option value="insecure">Insecure private relay</option>
          </select>
        </div>
        <FormField
          id={`relay-${relay.id}-password`}
          label="Password (write-only)"
          value={relay.password}
          onChange={(password) => secretChanged({ password })}
          placeholder={relay.credentialsConfigured ? 'Leave blank to preserve' : 'Enter a password if required'}
          type="password"
          disabled={disabled || relay.clearCredentials}
        />
      </>
    )
  }

  if (relay.kind === 'mailgun') {
    return (
      <>
        <FormField
          id={`relay-${relay.id}-domain`}
          label="Sending domain"
          value={relay.domain}
          onChange={(domain) => update({ domain })}
          placeholder="mg.example.com"
          disabled={disabled}
        />
        <FormField
          id={`relay-${relay.id}-base-url`}
          label="API base URL (optional)"
          value={relay.baseUrl}
          onChange={(baseUrl) => update({ baseUrl })}
          placeholder="Use the provider default"
          disabled={disabled}
        />
        <FormField
          id={`relay-${relay.id}-api-key`}
          label="API key (write-only)"
          value={relay.apiKey}
          onChange={(apiKey) => secretChanged({ apiKey })}
          placeholder={relay.credentialsConfigured ? 'Leave blank to preserve' : 'Enter API key'}
          type="password"
          disabled={disabled || relay.clearCredentials}
        />
      </>
    )
  }

  if (relay.kind === 'aws-ses') {
    return (
      <>
        <FormField
          id={`relay-${relay.id}-region`}
          label="AWS region"
          value={relay.region}
          onChange={(region) => update({ region })}
          placeholder="eu-west-1"
          disabled={disabled}
        />
        <FormField
          id={`relay-${relay.id}-access-key`}
          label="Access key ID (write-only)"
          value={relay.accessKeyId}
          onChange={(accessKeyId) => secretChanged({ accessKeyId })}
          placeholder={relay.credentialsConfigured ? 'Leave blank to preserve' : 'Enter access key ID'}
          type="password"
          disabled={disabled || relay.clearCredentials}
        />
        <FormField
          id={`relay-${relay.id}-secret-key`}
          label="Secret access key (write-only)"
          value={relay.secretAccessKey}
          onChange={(secretAccessKey) => secretChanged({ secretAccessKey })}
          placeholder={relay.credentialsConfigured ? 'Leave blank to preserve' : 'Enter secret access key'}
          type="password"
          disabled={disabled || relay.clearCredentials}
        />
        <FormField
          id={`relay-${relay.id}-session-token`}
          label="Session token (write-only, optional)"
          value={relay.sessionToken}
          onChange={(sessionToken) => secretChanged({ sessionToken })}
          placeholder={relay.credentialsConfigured ? 'Leave blank to preserve' : 'Only for temporary credentials'}
          type="password"
          disabled={disabled || relay.clearCredentials}
        />
      </>
    )
  }

  return (
    <FormField
      id={`relay-${relay.id}-api-key`}
      label="API key (write-only)"
      value={relay.apiKey}
      onChange={(apiKey) => secretChanged({ apiKey })}
      placeholder={relay.credentialsConfigured ? 'Leave blank to preserve' : 'Enter API key'}
      type="password"
      disabled={disabled || relay.clearCredentials}
    />
  )
}

const RelayEditor: FunctionComponent<{
  relay: RelayDraft
  index: number
  count: number
  disabled: boolean
  removeArmed: boolean
  update: (patch: Partial<RelayDraft>) => void
  move: (direction: -1 | 1) => void
  armRemove: () => void
  remove: () => void
  test: () => void
  testing: boolean
  testRequiresSave: boolean
}> = ({
  relay,
  index,
  count,
  disabled,
  removeArmed,
  update,
  move,
  armRemove,
  remove,
  test,
  testing,
  testRequiresSave,
}) => {
  const checks = relayConformityChecks(relay)
  const passed = checks.filter((check) => check.passing).length
  const credentialsPassing = checks.find((check) => check.id === 'credentials')?.passing === true
  const usesUnauthenticatedSmtp = relay.kind === 'smtp' && relay.username.trim().length === 0
  const usesAwsDefaultChain =
    relay.kind === 'aws-ses' &&
    relay.accessKeyId.length === 0 &&
    relay.secretAccessKey.length === 0 &&
    relay.sessionToken.length === 0
  const credentialStatus = relay.clearCredentials
    ? 'Credentials will be cleared'
    : usesUnauthenticatedSmtp
      ? 'Authentication not required'
      : usesAwsDefaultChain
        ? 'AWS default credential chain'
        : relay.credentialsConfigured
          ? 'Credentials configured'
          : 'Credentials required'

  return (
    <article className="border-border rounded border p-4" aria-labelledby={`relay-${relay.id}-heading`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <div id={`relay-${relay.id}-heading`}>
              <Subtitle>
                Priority {relay.priority}: {relay.name || 'Unnamed relay'}
              </Subtitle>
            </div>
            <StatusChip tone={relay.enabled ? 'success' : 'normal'}>
              {relay.enabled ? 'Enabled' : 'Disabled'}
            </StatusChip>
            <StatusChip tone={credentialsPassing && !relay.clearCredentials ? 'success' : 'warning'}>
              {credentialStatus}
            </StatusChip>
          </div>
          <Text className="mt-1 text-xs">{RELAY_PROVIDER_HELP[relay.kind]}</Text>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button label="Move up" small onClick={() => move(-1)} disabled={disabled || index === 0} />
          <Button label="Move down" small onClick={() => move(1)} disabled={disabled || index === count - 1} />
          <Button
            label={removeArmed ? 'Confirm remove' : 'Remove'}
            small
            colorStyle="danger"
            onClick={removeArmed ? remove : armRemove}
            disabled={disabled}
          />
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <FormField
          id={`relay-${relay.id}-name`}
          label="Profile name"
          value={relay.name}
          onChange={(name) => update({ name })}
          disabled={disabled}
        />
        <div>
          <label htmlFor={`relay-${relay.id}-kind`} className="mb-1 block text-sm font-semibold">
            Provider
          </label>
          <select
            id={`relay-${relay.id}-kind`}
            className={selectClassName}
            value={relay.kind}
            onChange={(event) =>
              update({
                kind: event.target.value as EmailRelayKind,
                credentialsConfigured: false,
                storedUsername: '',
                clearCredentials: false,
                password: '',
                apiKey: '',
                accessKeyId: '',
                secretAccessKey: '',
                sessionToken: '',
              })
            }
            disabled={disabled}
          >
            {EMAIL_RELAY_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {RELAY_KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        </div>
        <FormField
          id={`relay-${relay.id}-from`}
          label="From identity"
          value={relay.from}
          onChange={(from) => update({ from })}
          placeholder="Standard Red Notes <notes@example.com>"
          disabled={disabled}
        />
        <div className="flex items-center gap-2 pt-6">
          <input
            id={`relay-${relay.id}-enabled`}
            type="checkbox"
            checked={relay.enabled}
            onChange={(event) => update({ enabled: event.target.checked })}
            disabled={disabled}
          />
          <label htmlFor={`relay-${relay.id}-enabled`} className="text-sm font-semibold">
            Eligible for delivery
          </label>
        </div>
        <FormField
          id={`relay-${relay.id}-rate-max`}
          label="Maximum sends"
          value={String(relay.rateLimit.max)}
          onChange={(value) => update({ rateLimit: { ...relay.rateLimit, max: Number(value) } })}
          type="number"
          disabled={disabled}
        />
        <FormField
          id={`relay-${relay.id}-rate-window`}
          label="Rate window (seconds)"
          value={String(relay.rateLimit.windowSeconds)}
          onChange={(value) => update({ rateLimit: { ...relay.rateLimit, windowSeconds: Number(value) } })}
          type="number"
          disabled={disabled}
        />
        <ProviderFields relay={relay} disabled={disabled} update={update} />
      </div>

      {relay.kind === 'smtp' && relay.tlsMode === 'insecure' ? (
        <div className="border-danger bg-danger-faded mt-4 rounded border p-3" role="alert">
          <Text className="text-xs">
            Insecure SMTP can expose credentials and message content. The server accepts it only for an explicitly
            trusted loopback or private relay.
          </Text>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          label={relay.clearCredentials ? 'Cancel credential clear' : 'Clear saved credentials'}
          small
          onClick={() =>
            update({
              clearCredentials: !relay.clearCredentials,
              ...(relay.clearCredentials || relay.kind === 'aws-ses' ? {} : { enabled: false }),
              ...(relay.kind === 'smtp' && !relay.clearCredentials ? { username: '' } : {}),
              password: '',
              apiKey: '',
              accessKeyId: '',
              secretAccessKey: '',
              sessionToken: '',
            })
          }
          disabled={disabled || !relay.credentialsConfigured}
        />
        <Button
          label={testing ? 'Testing…' : 'Send redacted test'}
          small
          onClick={test}
          disabled={disabled || testing || testRequiresSave || !relay.enabled || !relayIsConformant(relay)}
          disabledReason={testRequiresSave ? 'Save relay profile changes before sending a test.' : undefined}
        />
      </div>

      <details className="mt-4">
        <summary className="cursor-pointer text-sm font-semibold">
          Conformity preview: {passed}/{checks.length} checks pass
        </summary>
        <ul className="mt-2 grid gap-1 text-xs">
          {checks.map((check) => (
            <li key={check.id} className={check.passing ? 'text-success' : 'text-warning'}>
              {check.passing ? 'Pass' : 'Needs attention'} — {check.label}
            </li>
          ))}
        </ul>
      </details>
    </article>
  )
}

const EmailDeliveryControlPlane: FunctionComponent<Props> = ({
  application,
  noteIfForbidden,
  onAvailabilityChange,
}) => {
  const [activeTab, setActiveTab] = useState<ControlTab>('relays')
  const [relayState, setRelayState] = useState<PanelState>('loading')
  const [relayError, setRelayError] = useState<string | null>(null)
  const [relays, setRelays] = useState<RelayDraft[]>([])
  const [configured, setConfigured] = useState(false)
  const [fallbackPolicy, setFallbackPolicy] = useState<RelayFallbackPolicy>({ mode: 'next-enabled' })
  const [saving, setSaving] = useState(false)
  const [relaysDirty, setRelaysDirty] = useState(false)
  const [saveStatus, setSaveStatus] = useState<string | null>(null)
  const [removeArmed, setRemoveArmed] = useState<string | null>(null)
  const [testRecipient, setTestRecipient] = useState('')
  const [testingRelay, setTestingRelay] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<EmailTestResult | null>(null)
  const [testError, setTestError] = useState<string | null>(null)

  const [queueState, setQueueState] = useState<PanelState>('idle')
  const [queueError, setQueueError] = useState<string | null>(null)
  const [queueFilter, setQueueFilter] = useState<EmailQueueState>('ready')
  const [queuePages, setQueuePages] = useState<QueuePages>(emptyQueuePages)
  const [queueAction, setQueueAction] = useState<string | null>(null)
  const [queueActionStatus, setQueueActionStatus] = useState<string | null>(null)
  const [discardArmed, setDiscardArmed] = useState<string | null>(null)

  const [logsState, setLogsState] = useState<PanelState>('idle')
  const [logsError, setLogsError] = useState<string | null>(null)
  const [logs, setLogs] = useState<EmailLogsResponse>({ items: [] })
  const [logOutcome, setLogOutcome] = useState<EmailLogOutcome | ''>('')
  const [logRelayId, setLogRelayId] = useState('')

  const loadRelays = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (typeof application.serverGetJsonRequest !== 'function') {
        setRelayState('unavailable')
        return
      }
      setRelayState('loading')
      setRelayError(null)
      try {
        const response = await application.serverGetJsonRequest<RelaysResponse>(
          '/v1/admin/email-delivery/relays',
          signal,
        )
        if (!response.ok) {
          noteIfForbidden(response)
          if (response.status === 404 || response.status === 501) {
            setRelayState('unavailable')
          } else {
            setRelayError(controlPlaneError(response.status, 'Load relay profiles'))
            setRelayState('error')
          }
          return
        }
        const decoded = decodeRelaysResponse(response.data)
        if (!decoded) {
          setRelayError('The server returned an invalid redacted relay profile response.')
          setRelayState('error')
          return
        }
        setRelays(
          normalizeRelayPriorities(
            decoded.relays.sort((left, right) => left.priority - right.priority).map(relayViewToDraft),
          ),
        )
        setConfigured(decoded.configured)
        setFallbackPolicy(decoded.fallbackPolicy)
        setRelaysDirty(false)
        setRelayState('ready')
      } catch {
        if (!signal?.aborted) {
          setRelayError('Relay profiles could not be loaded. Check the server connection and try again.')
          setRelayState('error')
        }
      }
    },
    [application, noteIfForbidden],
  )

  useEffect(() => {
    const controller = new AbortController()
    void loadRelays(controller.signal)
    return () => controller.abort()
  }, [loadRelays])

  const updateRelay = (id: string, patch: Partial<RelayDraft>): void => {
    setRelays((current) => current.map((relay) => (relay.id === id ? { ...relay, ...patch } : relay)))
    setRelaysDirty(true)
    setSaveStatus(null)
  }

  const moveRelay = (index: number, direction: -1 | 1): void => {
    const destination = index + direction
    if (destination < 0 || destination >= relays.length) {
      return
    }
    const reordered = [...relays]
    ;[reordered[index], reordered[destination]] = [reordered[destination], reordered[index]]
    setRelays(normalizeRelayPriorities(reordered))
    setRelaysDirty(true)
    setSaveStatus(null)
  }

  const saveRelays = async (): Promise<void> => {
    const hasBlockingIssue = relays.some((relay) =>
      relayConformityChecks(relay).some(
        (check) => !check.passing && !(check.id === 'credentials' && relay.clearCredentials),
      ),
    )
    if (hasBlockingIssue) {
      setSaveStatus('Resolve every failed conformity check before saving.')
      return
    }
    if (typeof application.serverJsonRequestWithMethod !== 'function') {
      setSaveStatus('This app build cannot update relay profiles. Update the app and server first.')
      return
    }
    const normalized = normalizeRelayPriorities(relays)
    setRelays(normalized)
    setSaving(true)
    setSaveStatus(null)
    try {
      const response = await application.serverJsonRequestWithMethod<RelaysResponse>(
        '/v1/admin/email-delivery/relays',
        'PUT',
        { relays: normalized.map(serializeRelayDraft), fallbackPolicy },
      )
      if (!response.ok) {
        noteIfForbidden(response)
        setSaveStatus(controlPlaneError(response.status, 'Save relay profiles'))
        return
      }
      const decoded = decodeRelaysResponse(response.data)
      if (!decoded) {
        setSaveStatus('The profiles may have been saved, but the server returned an invalid redacted response.')
        return
      }
      setRelays(normalizeRelayPriorities(decoded.relays.sort((a, b) => a.priority - b.priority).map(relayViewToDraft)))
      setConfigured(decoded.configured)
      setFallbackPolicy(decoded.fallbackPolicy)
      setRelaysDirty(false)
      setSaveStatus('Relay profiles saved. Write-only credential inputs were cleared from this page.')
    } catch {
      setSaveStatus('Relay profiles could not be saved. Check the server connection and try again.')
    } finally {
      setSaving(false)
    }
  }

  const testRelay = async (relayId: string): Promise<void> => {
    if (!/^\S+@\S+\.\S+$/.test(testRecipient.trim())) {
      setTestError('Enter a valid test recipient address.')
      return
    }
    setTestingRelay(relayId)
    setTestError(null)
    setTestResult(null)
    try {
      const response = await application.serverJsonRequest<EmailTestResult>('/v1/admin/email-delivery/test', {
        recipient: testRecipient.trim(),
        relayId,
      })
      if (!response.ok) {
        noteIfForbidden(response)
        setTestError(controlPlaneError(response.status, 'Send test email'))
        return
      }
      const decoded = decodeEmailTestResult(response.data)
      if (!decoded) {
        setTestError('The provider test returned an invalid redacted result.')
        return
      }
      setTestResult(decoded)
      setTestRecipient('')
    } catch {
      setTestError('The provider test could not be completed. Check the server connection and try again.')
    } finally {
      setTestingRelay(null)
    }
  }

  const fetchQueuePage = useCallback(
    async (state: EmailQueueState, cursor?: string): Promise<EmailQueueResponse | undefined> => {
      const query = new URLSearchParams({ state, limit: '100' })
      if (cursor) {
        query.set('cursor', cursor)
      }
      const response = await application.serverGetJsonRequest<EmailQueueResponse>(
        `/v1/admin/email-delivery/queue?${query.toString()}`,
      )
      if (!response.ok) {
        noteIfForbidden(response)
        throw Object.assign(new Error('queue'), { status: response.status })
      }
      return decodeQueueResponse(response.data)
    },
    [application, noteIfForbidden],
  )

  const loadQueueOverview = useCallback(async (): Promise<void> => {
    if (typeof application.serverGetJsonRequest !== 'function') {
      setQueueState('unavailable')
      return
    }
    setQueueState('loading')
    setQueueError(null)
    try {
      const responses = await Promise.all(EMAIL_QUEUE_STATES.map((state) => fetchQueuePage(state)))
      if (responses.some((response) => !response)) {
        setQueueError('The server returned an invalid redacted delivery queue response.')
        setQueueState('error')
        return
      }
      setQueuePages({
        ready: responses[0] as EmailQueueResponse,
        leased: responses[1] as EmailQueueResponse,
        dead: responses[2] as EmailQueueResponse,
      })
      setQueueState('ready')
    } catch (error) {
      const status = (error as { status?: number }).status
      if (status === 404 || status === 501 || status === 503) {
        setQueueState('unavailable')
      } else {
        setQueueError(controlPlaneError(status ?? 0, 'Load delivery queue'))
        setQueueState('error')
      }
    }
  }, [application, fetchQueuePage])

  useEffect(() => {
    if (activeTab === 'queue' && queueState === 'idle') {
      void loadQueueOverview()
    }
  }, [activeTab, loadQueueOverview, queueState])

  const loadMoreQueue = async (): Promise<void> => {
    const cursor = queuePages[queueFilter].nextCursor
    if (!cursor) {
      return
    }
    setQueueAction('load-more')
    setQueueActionStatus(null)
    try {
      const page = await fetchQueuePage(queueFilter, cursor)
      if (!page) {
        setQueueActionStatus('The server returned an invalid redacted queue page.')
        return
      }
      setQueuePages((current) => ({
        ...current,
        [queueFilter]: { items: [...current[queueFilter].items, ...page.items], nextCursor: page.nextCursor },
      }))
    } catch (error) {
      setQueueActionStatus(controlPlaneError((error as { status?: number }).status ?? 0, 'Load more delivery jobs'))
    } finally {
      setQueueAction(null)
    }
  }

  const retryQueueItem = async (item: EmailQueueItem): Promise<void> => {
    setQueueAction(item.id)
    setQueueActionStatus(null)
    try {
      const response = await application.serverJsonRequest<EmailQueueItem>(
        `/v1/admin/email-delivery/queue/${encodeURIComponent(item.id)}/retry`,
        {},
      )
      if (!response.ok) {
        noteIfForbidden(response)
        setQueueActionStatus(controlPlaneError(response.status, 'Retry delivery'))
        return
      }
      setQueueActionStatus('The delivery job was returned to the ready queue.')
      await loadQueueOverview()
    } catch {
      setQueueActionStatus('Retry delivery failed. Check the server connection and try again.')
    } finally {
      setQueueAction(null)
    }
  }

  const discardQueueItem = async (item: EmailQueueItem): Promise<void> => {
    if (typeof application.serverJsonRequestWithMethod !== 'function') {
      setQueueActionStatus('This app build cannot discard delivery jobs. Update the app first.')
      return
    }
    setQueueAction(item.id)
    setQueueActionStatus(null)
    try {
      const response = await application.serverJsonRequestWithMethod<Record<string, never>>(
        `/v1/admin/email-delivery/queue/${encodeURIComponent(item.id)}`,
        'DELETE',
      )
      if (!response.ok) {
        noteIfForbidden(response)
        setQueueActionStatus(controlPlaneError(response.status, 'Discard delivery'))
        return
      }
      setDiscardArmed(null)
      setQueueActionStatus('The delivery job was discarded.')
      await loadQueueOverview()
    } catch {
      setQueueActionStatus('Discard delivery failed. Check the server connection and try again.')
    } finally {
      setQueueAction(null)
    }
  }

  const loadLogs = useCallback(
    async (cursor?: string, append = false): Promise<void> => {
      if (typeof application.serverGetJsonRequest !== 'function') {
        setLogsState('unavailable')
        return
      }
      setLogsState('loading')
      setLogsError(null)
      const query = new URLSearchParams({ limit: '100' })
      if (cursor) {
        query.set('cursor', cursor)
      }
      if (logRelayId) {
        query.set('relayId', logRelayId)
      }
      if (logOutcome) {
        query.set('outcome', logOutcome)
      }
      try {
        const response = await application.serverGetJsonRequest<EmailLogsResponse>(
          `/v1/admin/email-delivery/logs?${query.toString()}`,
        )
        if (!response.ok) {
          noteIfForbidden(response)
          if (response.status === 404 || response.status === 501 || response.status === 503) {
            setLogsState('unavailable')
          } else {
            setLogsError(controlPlaneError(response.status, 'Load delivery logs'))
            setLogsState('error')
          }
          return
        }
        const decoded = decodeLogsResponse(response.data)
        if (!decoded) {
          setLogsError('The server returned an invalid redacted delivery log response.')
          setLogsState('error')
          return
        }
        setLogs((current) => ({
          items: append ? [...current.items, ...decoded.items] : decoded.items,
          nextCursor: decoded.nextCursor,
        }))
        setLogsState('ready')
      } catch {
        setLogsError('Delivery logs could not be loaded. Check the server connection and try again.')
        setLogsState('error')
      }
    },
    [application, logOutcome, logRelayId, noteIfForbidden],
  )

  useEffect(() => {
    if (activeTab === 'logs') {
      void loadLogs()
    }
  }, [activeTab, loadLogs])

  const logSummary = useMemo(
    () =>
      EMAIL_LOG_OUTCOMES.map((outcome) => ({
        outcome,
        count: logs.items.filter((entry) => entry.outcome === outcome).length,
      })),
    [logs.items],
  )

  const unavailable = relayState === 'unavailable'
  const availability: EmailDeliveryControlPlaneAvailability = unavailable
    ? 'unavailable'
    : relayState === 'ready' || relayState === 'error'
      ? 'available'
      : 'probing'

  useEffect(() => {
    onAvailabilityChange?.(availability)
  }, [availability, onAvailabilityChange])

  return (
    <div className="border-border mt-7 border-t pt-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Subtitle>Relay routing and delivery activity</Subtitle>
          <Text className="mt-1 max-w-3xl text-xs">
            Route email through ordered SMTP or API relays, inspect a metadata-only queue, and review redacted outcomes.
            Credentials are write-only; recipient addresses, subjects, message bodies, and raw provider responses are
            never returned by these controls.
          </Text>
        </div>
        {relayState === 'ready' ? (
          <StatusChip tone={configured ? 'success' : 'warning'}>
            {configured ? 'Delivery configured' : 'No eligible relay'}
          </StatusChip>
        ) : null}
      </div>

      {relayState === 'loading' ? <Spinner className="mt-4 h-5 w-5" /> : null}
      {unavailable ? (
        <div className="border-border bg-passive-5 mt-4 rounded border p-3">
          <Text>
            Advanced relay management is unavailable on this server. The compatible single-SMTP editor is shown below
            until the server exposes the relay control-plane endpoints.
          </Text>
          <Button className="mt-2" label="Retry advanced controls" small onClick={() => void loadRelays()} />
        </div>
      ) : null}
      {relayState === 'error' ? (
        <div className="border-danger bg-danger-faded mt-4 rounded border p-3" role="alert">
          <Text>{relayError}</Text>
          <Button className="mt-2" label="Retry advanced controls" small onClick={() => void loadRelays()} />
        </div>
      ) : null}

      {relayState === 'ready' ? (
        <>
          <div className="border-border mt-5 flex flex-wrap gap-2 border-b" role="tablist" aria-label="Email delivery">
            {(['relays', 'queue', 'logs'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                id={`email-${tab}-tab`}
                aria-controls={`email-${tab}-panel`}
                aria-selected={activeTab === tab}
                className={`focus:ring-info border-b-2 px-3 py-2 text-sm font-semibold capitalize focus:ring-2 focus:outline-none ${
                  activeTab === tab ? 'border-info text-info' : 'text-passive-1 border-transparent'
                }`}
                onClick={() => setActiveTab(tab)}
              >
                {tab === 'relays' ? 'Relay profiles' : tab === 'queue' ? 'Delivery queue' : 'Redacted logs'}
              </button>
            ))}
          </div>

          <section
            role="tabpanel"
            id="email-relays-panel"
            aria-labelledby="email-relays-tab"
            hidden={activeTab !== 'relays'}
            className="mt-4"
          >
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="w-80 max-w-full">
                <label htmlFor="email-relay-fallback" className="mb-1 block text-sm font-semibold">
                  Failure policy
                </label>
                <select
                  id="email-relay-fallback"
                  className={selectClassName}
                  value={fallbackPolicy.mode}
                  onChange={(event) => {
                    setFallbackPolicy({ mode: event.target.value as RelayFallbackPolicy['mode'] })
                    setRelaysDirty(true)
                  }}
                  disabled={saving}
                >
                  <option value="next-enabled">Try the next enabled relay</option>
                  <option value="none">Do not fall back</option>
                </select>
              </div>
              <Button
                label="Add relay profile"
                onClick={() => {
                  setRelays((current) => [...current, createRelayDraft(current.length)])
                  setRelaysDirty(true)
                }}
                disabled={saving || relays.length >= EMAIL_RELAY_PROFILE_LIMIT}
                disabledReason={
                  relays.length >= EMAIL_RELAY_PROFILE_LIMIT
                    ? `At most ${EMAIL_RELAY_PROFILE_LIMIT} relay profiles can be configured.`
                    : undefined
                }
              />
            </div>

            <div className="mt-4 grid gap-4">
              {relays.length === 0 ? (
                <div className="border-border bg-passive-5 rounded border p-4">
                  <Text>No relay profiles exist. Add one to configure outbound delivery.</Text>
                </div>
              ) : null}
              {relays.map((relay, index) => (
                <RelayEditor
                  key={relay.id}
                  relay={relay}
                  index={index}
                  count={relays.length}
                  disabled={saving}
                  removeArmed={removeArmed === relay.id}
                  update={(patch) => updateRelay(relay.id, patch)}
                  move={(direction) => moveRelay(index, direction)}
                  armRemove={() => setRemoveArmed(relay.id)}
                  remove={() => {
                    setRelays((current) => normalizeRelayPriorities(current.filter((entry) => entry.id !== relay.id)))
                    setRelaysDirty(true)
                    setRemoveArmed(null)
                  }}
                  test={() => void testRelay(relay.id)}
                  testing={testingRelay === relay.id}
                  testRequiresSave={relaysDirty}
                />
              ))}
            </div>

            <div className="border-border mt-4 rounded border p-3">
              <label htmlFor="email-relay-test-recipient" className="mb-1 block text-sm font-semibold">
                Test recipient
              </label>
              <DecoratedInput
                id="email-relay-test-recipient"
                value={testRecipient}
                onChange={(value) => {
                  setTestRecipient(value)
                  setTestError(null)
                }}
                placeholder="operator@example.com"
                autocomplete={false}
                disabled={testingRelay !== null}
              />
              <Text className="mt-1 text-xs">
                The address is sent only with the explicit test request and is never echoed into the result or logs.
              </Text>
              {relaysDirty ? (
                <Text className="text-warning mt-1 text-xs">Save relay profile changes before sending a test.</Text>
              ) : null}
              {testError ? (
                <div role="alert">
                  <Text className="text-danger mt-2">{testError}</Text>
                </div>
              ) : null}
              {testResult ? (
                <div className="border-border bg-passive-5 mt-3 rounded border p-3" role="status">
                  <Subtitle>Provider test result</Subtitle>
                  <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
                    <dt className="font-semibold">Accepted</dt>
                    <dd>{testResult.accepted ? 'Yes' : 'No'}</dd>
                    <dt className="font-semibold">Outcome</dt>
                    <dd>{testResult.outcome}</dd>
                    <dt className="font-semibold">Relay kind</dt>
                    <dd>{testResult.relayKind ? RELAY_KIND_LABELS[testResult.relayKind] : 'None selected'}</dd>
                  </dl>
                </div>
              ) : null}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button
                label={saving ? 'Saving relay profiles…' : 'Save relay profiles'}
                primary
                onClick={() => void saveRelays()}
                disabled={saving}
              />
              {saveStatus ? (
                <div role="status">
                  <Text className="text-xs">{saveStatus}</Text>
                </div>
              ) : null}
            </div>
          </section>

          <section
            role="tabpanel"
            id="email-queue-panel"
            aria-labelledby="email-queue-tab"
            hidden={activeTab !== 'queue'}
            className="mt-4"
          >
            {queueState === 'loading' ? <Spinner className="h-5 w-5" /> : null}
            {queueState === 'unavailable' ? (
              <Text>The metadata-only delivery queue is unavailable on this server.</Text>
            ) : null}
            {queueState === 'error' ? (
              <div role="alert">
                <Text className="text-danger">{queueError}</Text>
                <Button className="mt-2" label="Retry queue" small onClick={() => void loadQueueOverview()} />
              </div>
            ) : null}
            {queueState === 'ready' ? (
              <>
                <div className="mb-3 flex justify-end">
                  <Button
                    label="Refresh queue"
                    small
                    onClick={() => void loadQueueOverview()}
                    disabled={queueAction !== null}
                  />
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" aria-label="Loaded queue summary">
                  {EMAIL_QUEUE_STATES.map((state) => (
                    <button
                      key={state}
                      type="button"
                      className={`border-border focus:ring-info rounded border p-3 text-left focus:ring-2 focus:outline-none ${
                        queueFilter === state ? 'bg-info-faded' : 'bg-passive-5'
                      }`}
                      aria-pressed={queueFilter === state}
                      onClick={() => setQueueFilter(state)}
                    >
                      <span className="block text-xs font-semibold capitalize">{state}</span>
                      <span className="text-lg font-bold">
                        {queuePages[state].items.length}
                        {queuePages[state].nextCursor ? '+' : ''}
                      </span>
                    </button>
                  ))}
                </div>
                <Text className="mt-2 text-xs">
                  Counts describe the loaded redacted snapshot; a plus sign means another page is available.
                </Text>

                <div className="mt-4 grid gap-3">
                  {queuePages[queueFilter].items.length === 0 ? <Text>No {queueFilter} jobs are visible.</Text> : null}
                  {queuePages[queueFilter].items.map((item) => (
                    <article key={item.id} className="border-border rounded border p-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="flex flex-wrap gap-2">
                          <StatusChip
                            tone={item.state === 'dead' ? 'danger' : item.state === 'leased' ? 'warning' : 'normal'}
                          >
                            {item.state}
                          </StatusChip>
                          <StatusChip>{item.source}</StatusChip>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {item.state === 'dead' ? (
                            <Button
                              label={queueAction === item.id ? 'Retrying…' : 'Retry'}
                              small
                              onClick={() => void retryQueueItem(item)}
                              disabled={queueAction !== null}
                            />
                          ) : null}
                          <Button
                            label={discardArmed === item.id ? 'Confirm discard' : 'Discard'}
                            small
                            colorStyle="danger"
                            onClick={() => {
                              if (discardArmed === item.id) {
                                void discardQueueItem(item)
                              } else {
                                setDiscardArmed(item.id)
                              }
                            }}
                            disabled={queueAction !== null || item.state === 'leased'}
                            disabledReason={
                              item.state === 'leased' ? 'Leased jobs cannot be discarded while in flight.' : undefined
                            }
                          />
                        </div>
                      </div>
                      <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
                        <dt className="font-semibold">Attempt</dt>
                        <dd>
                          {item.retryMode === 'indefinite'
                            ? `${item.attempt} (indefinite transient retry)`
                            : `${item.attempt} of ${item.maxAttempts}`}
                        </dd>
                        <dt className="font-semibold">Created</dt>
                        <dd>
                          <SafeDate value={item.createdAt} />
                        </dd>
                        <dt className="font-semibold">Next attempt</dt>
                        <dd>
                          <SafeDate value={item.nextAttemptAt} />
                        </dd>
                        {item.expiresAt ? (
                          <>
                            <dt className="font-semibold">Expires</dt>
                            <dd>
                              <SafeDate value={item.expiresAt} />
                            </dd>
                          </>
                        ) : null}
                        {item.leaseExpiresAt ? (
                          <>
                            <dt className="font-semibold">Lease expires</dt>
                            <dd>
                              <SafeDate value={item.leaseExpiresAt} />
                            </dd>
                          </>
                        ) : null}
                        {item.lastFailureClass ? (
                          <>
                            <dt className="font-semibold">Last failure class</dt>
                            <dd>{item.lastFailureClass}</dd>
                          </>
                        ) : null}
                      </dl>
                    </article>
                  ))}
                </div>
                {queuePages[queueFilter].nextCursor ? (
                  <Button
                    className="mt-3"
                    label={queueAction === 'load-more' ? 'Loading…' : 'Load more'}
                    small
                    onClick={() => void loadMoreQueue()}
                    disabled={queueAction !== null}
                  />
                ) : null}
                {queueActionStatus ? (
                  <div role="status">
                    <Text className="mt-3 text-xs">{queueActionStatus}</Text>
                  </div>
                ) : null}
              </>
            ) : null}
          </section>

          <section
            role="tabpanel"
            id="email-logs-panel"
            aria-labelledby="email-logs-tab"
            hidden={activeTab !== 'logs'}
            className="mt-4"
          >
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <label htmlFor="email-log-outcome" className="mb-1 block text-sm font-semibold">
                  Outcome
                </label>
                <select
                  id="email-log-outcome"
                  className={selectClassName}
                  value={logOutcome}
                  onChange={(event) => setLogOutcome(event.target.value as EmailLogOutcome | '')}
                >
                  <option value="">All outcomes</option>
                  {EMAIL_LOG_OUTCOMES.map((outcome) => (
                    <option key={outcome} value={outcome}>
                      {outcome}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="email-log-relay" className="mb-1 block text-sm font-semibold">
                  Relay profile
                </label>
                <select
                  id="email-log-relay"
                  className={selectClassName}
                  value={logRelayId}
                  onChange={(event) => setLogRelayId(event.target.value)}
                >
                  <option value="">All relays</option>
                  {relays.map((relay) => (
                    <option key={relay.id} value={relay.id}>
                      {relay.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {logsState === 'loading' && logs.items.length === 0 ? <Spinner className="mt-4 h-5 w-5" /> : null}
            {logsState === 'unavailable' ? (
              <Text className="mt-4">Redacted delivery logs are unavailable on this server.</Text>
            ) : null}
            {logsState === 'error' ? (
              <div className="mt-4" role="alert">
                <Text className="text-danger">{logsError}</Text>
                <Button className="mt-2" label="Retry logs" small onClick={() => void loadLogs()} />
              </div>
            ) : null}
            {logsState === 'ready' || (logsState === 'loading' && logs.items.length > 0) ? (
              <>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap gap-2" aria-label="Loaded log summary">
                    {logSummary.map(({ outcome, count }) => (
                      <StatusChip
                        key={outcome}
                        tone={outcome === 'sent' ? 'success' : count > 0 ? 'warning' : 'normal'}
                      >
                        {outcome}: {count}
                      </StatusChip>
                    ))}
                  </div>
                  <Button
                    label="Refresh logs"
                    small
                    onClick={() => void loadLogs()}
                    disabled={logsState === 'loading'}
                  />
                </div>
                <div className="mt-4 grid gap-3">
                  {logs.items.length === 0 ? <Text>No redacted log entries match these filters.</Text> : null}
                  {logs.items.map((entry) => {
                    const relayName = relays.find((relay) => relay.id === entry.relayId)?.name ?? 'Removed relay'
                    return (
                      <article key={entry.id} className="border-border rounded border p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusChip tone={entry.outcome === 'sent' ? 'success' : 'warning'}>
                            {entry.outcome}
                          </StatusChip>
                          <span className="text-sm font-semibold">{relayName}</span>
                          <span className="text-passive-1 text-xs">{RELAY_KIND_LABELS[entry.relayKind]}</span>
                        </div>
                        <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
                          <dt className="font-semibold">Recorded</dt>
                          <dd>
                            <SafeDate value={entry.createdAt} />
                          </dd>
                          <dt className="font-semibold">Attempt</dt>
                          <dd>{entry.attempt}</dd>
                          <dt className="font-semibold">Duration</dt>
                          <dd>{entry.durationMs} ms</dd>
                          {entry.failureClass ? (
                            <>
                              <dt className="font-semibold">Failure class</dt>
                              <dd>{entry.failureClass}</dd>
                            </>
                          ) : null}
                          {entry.providerCode ? (
                            <>
                              <dt className="font-semibold">Provider code</dt>
                              <dd>{entry.providerCode}</dd>
                            </>
                          ) : null}
                          {entry.httpStatus ? (
                            <>
                              <dt className="font-semibold">HTTP status</dt>
                              <dd>{entry.httpStatus}</dd>
                            </>
                          ) : null}
                        </dl>
                      </article>
                    )
                  })}
                </div>
                {logs.nextCursor ? (
                  <Button
                    className="mt-3"
                    label={logsState === 'loading' ? 'Loading…' : 'Load more'}
                    small
                    onClick={() => void loadLogs(logs.nextCursor, true)}
                    disabled={logsState === 'loading'}
                  />
                ) : null}
              </>
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  )
}

export default EmailDeliveryControlPlane
