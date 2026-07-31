import { FunctionComponent, useCallback, useEffect, useRef, useState } from 'react'

import { AssistantSubscriptionStatus, WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import DecoratedInput from '@/Components/Input/DecoratedInput'
import { ToastType, addToast } from '@standardnotes/toast'
import { confirmDialog } from '@standardnotes/ui-services'
import {
  assistantAuthorizeOrigin,
  DEFAULT_ASSISTANT_SUBSCRIPTION_ID,
  isValidAssistantPairingState,
  isValidAssistantSubscriptionId,
  safeAssistantAuthorizeUrl,
} from '@/Assistant/subscriptionPairing'

/**
 * Standard Red Notes: GUIDED ChatGPT / Codex subscription pairing wizard.
 *
 * A proper step-by-step UI over the REAL server pairing endpoints
 * (/v1/assistant/subscription/{status,start,complete,unpair,callback}) — nothing
 * is simulated. The PKCE verifier + OAuth token exchange all happen server-side;
 * this walks the admin through the manual external-OAuth step explicitly:
 *
 *   1. Generate the authorization URL (server creates PKCE + state).
 *   2. Open it, log in to ChatGPT, and authorize (external, manual).
 *   3a. The redirect lands on the server which completes the exchange, OR
 *   3b. paste the returned code here and the server completes it.
 *   4. Success — the token is held + auto-refreshed server-side, never shown.
 */

const POLL_INTERVAL_MS = 2500
const POLL_TIMEOUT_MS = 180000

type WizardStep = 'idle' | 'authorize' | 'done'

const formatExpiry = (expiresAt?: number | string): string | null => {
  if (expiresAt === undefined || expiresAt === null || expiresAt === '') {
    return null
  }
  const ms = typeof expiresAt === 'number' ? (expiresAt < 1e12 ? expiresAt * 1000 : expiresAt) : Date.parse(expiresAt)
  if (!Number.isFinite(ms)) {
    return typeof expiresAt === 'string' ? expiresAt : null
  }
  return new Date(ms).toLocaleString()
}

const StepBadge: FunctionComponent<{ n: number; active: boolean; done: boolean }> = ({ n, active, done }) => (
  <span
    className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold ${
      done ? 'bg-success text-success-contrast' : active ? 'bg-info text-info-contrast' : 'bg-passive-4 text-foreground'
    }`}
  >
    {done ? '✓' : n}
  </span>
)

const CodexPairingWizard: FunctionComponent<{ application: WebApplication; onStatusChange?: () => void }> = ({
  application,
  onStatusChange,
}) => {
  const [status, setStatus] = useState<AssistantSubscriptionStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [step, setStep] = useState<WizardStep>('idle')
  const [authorizeUrl, setAuthorizeUrl] = useState('')
  const [state, setState] = useState('')
  // Standard Red Notes: MULTIPLE pairings — an optional slot id this pairing
  // lands in, so adding another never drops the existing ones. Empty = 'default'.
  const [subscriptionId, setSubscriptionId] = useState('')
  const [activeSubscriptionId, setActiveSubscriptionId] = useState(DEFAULT_ASSISTANT_SUBSCRIPTION_ID)
  const [pastedCode, setPastedCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [polling, setPolling] = useState(false)

  const pollRef = useRef<number | null>(null)
  const timeoutRef = useRef<number | null>(null)
  const mountedRef = useRef(true)
  const activeSubscriptionIdRef = useRef(DEFAULT_ASSISTANT_SUBSCRIPTION_ID)
  // Last paired state we told the parent about. Starts unknown (null) so the
  // very first (passive) status read never notifies.
  const lastNotifiedPairedRef = useRef<boolean | null>(null)

  const refreshStatus = useCallback(async (): Promise<AssistantSubscriptionStatus> => {
    const result = await application.assistantSubscriptionStatus(activeSubscriptionIdRef.current)
    if (mountedRef.current) {
      setStatus(result)
      if (result.paired) {
        setStep('done')
      }
    }
    // Only tell the parent to refresh when the paired state actually TRANSITIONS.
    // Notifying on every passive read (mount, poll tick) made the parent reload
    // its whole view, which unmounted+remounted this wizard, which read status
    // again and notified again — an endless spinner/flicker loop.
    if (lastNotifiedPairedRef.current !== null && lastNotifiedPairedRef.current !== result.paired) {
      onStatusChange?.()
    }
    lastNotifiedPairedRef.current = result.paired
    return result
  }, [application, onStatusChange])

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current)
      pollRef.current = null
    }
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    if (mountedRef.current) {
      setPolling(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    setLoading(true)
    void refreshStatus().finally(() => mountedRef.current && setLoading(false))
    return () => {
      mountedRef.current = false
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current)
      }
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current)
      }
    }
  }, [refreshStatus])

  const startPolling = useCallback(() => {
    stopPolling()
    setPolling(true)
    pollRef.current = window.setInterval(() => {
      void refreshStatus().then((result) => {
        if (result.paired) {
          stopPolling()
        }
      })
    }, POLL_INTERVAL_MS)
    timeoutRef.current = window.setTimeout(() => {
      stopPolling()
      if (mountedRef.current) {
        setError(
          'Timed out waiting for pairing. Finish the ChatGPT login, then click "Check pairing" or paste the code.',
        )
      }
    }, POLL_TIMEOUT_MS)
  }, [refreshStatus, stopPolling])

  const handleGenerate = useCallback(async () => {
    setError(null)
    const targetId = subscriptionId === '' ? DEFAULT_ASSISTANT_SUBSCRIPTION_ID : subscriptionId
    if (!isValidAssistantSubscriptionId(targetId)) {
      setError('Use 1-128 letters, numbers, dots, underscores, or hyphens for the subscription id.')
      return
    }
    setLoading(true)
    try {
      // Send the (optional) target slot id so multiple subscriptions can be paired.
      const { ok, status: httpStatus, data } = await application.assistantSubscriptionStart(targetId)
      if (!ok || !data?.authorizeUrl || !isValidAssistantPairingState(data.state)) {
        throw new Error(
          httpStatus === 503
            ? 'Subscription pairing is not configured on this server (set ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY).'
            : 'The server did not return an authorization URL.',
        )
      }
      if (data.subscriptionId !== targetId) {
        throw new Error('The server did not bind the authorization attempt to the requested subscription id.')
      }
      if (!safeAssistantAuthorizeUrl(data.authorizeUrl, data.state)) {
        throw new Error('The server returned an unsafe or mismatched authorization URL.')
      }
      if (mountedRef.current) {
        activeSubscriptionIdRef.current = targetId
        setActiveSubscriptionId(targetId)
        setAuthorizeUrl(data.authorizeUrl)
        setState(data.state)
        setStep('authorize')
      }
    } catch (e) {
      if (mountedRef.current) {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false)
      }
    }
  }, [application, subscriptionId])

  const handleOpenAuthorize = useCallback(() => {
    const safeUrl = safeAssistantAuthorizeUrl(authorizeUrl, state)
    if (!safeUrl) {
      setError('The authorization URL is no longer safe to open. Generate a new link.')
      return
    }
    window.open(safeUrl, '_blank', 'noopener,noreferrer,width=520,height=760')
    startPolling()
  }, [authorizeUrl, startPolling, state])

  const handlePasteComplete = useCallback(async () => {
    setError(null)
    if (pastedCode.trim() === '') {
      setError('Paste the authorization code first.')
      return
    }
    setLoading(true)
    try {
      const { ok, data } = await application.serverJsonRequest<{ ok?: boolean; error?: { message?: string } }>(
        '/v1/assistant/subscription/complete',
        { state, code: pastedCode.trim() },
      )
      if (!ok || data?.ok === false) {
        throw new Error(data?.error?.message ?? 'The server rejected the pairing code.')
      }
      stopPolling()
      setPastedCode('')
      await refreshStatus()
      addToast({ type: ToastType.Success, message: 'ChatGPT subscription paired.' })
    } catch (e) {
      if (mountedRef.current) {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false)
      }
    }
  }, [application, pastedCode, state, refreshStatus, stopPolling])

  const handleUnpair = useCallback(async () => {
    setError(null)
    const references = status?.referencedByProfiles ?? []
    if (status?.profileReferencesKnown === false) {
      setError('The server could not verify assistant or backend profile references, so unpairing is blocked safely.')
      return
    }
    if (
      !(await confirmDialog({
        title: `Unpair subscription "${activeSubscriptionId}"?`,
        text:
          references.length > 0
            ? `This id is still used by ${references.length} assistant or backend profile(s). They will fail closed until the same id is paired again or those profiles are changed.`
            : 'The encrypted server-held credential and pending attempts for this id will be removed. Other pairings are unaffected.',
        confirmButtonText: 'Unpair',
        confirmButtonStyle: 'danger',
      }))
    ) {
      return
    }
    setLoading(true)
    try {
      const { ok } = await application.assistantSubscriptionUnpair(activeSubscriptionId, references.length > 0)
      if (!ok) {
        throw new Error('The server rejected the unpair request.')
      }
      setStep('idle')
      setAuthorizeUrl('')
      setState('')
      await refreshStatus()
      addToast({ type: ToastType.Success, message: 'Subscription unpaired.' })
    } catch (e) {
      if (mountedRef.current) {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false)
      }
    }
  }, [activeSubscriptionId, application, refreshStatus, status?.profileReferencesKnown, status?.referencedByProfiles])

  const paired = status?.paired === true
  const expiry = formatExpiry(status?.expiresAt)
  const authorizeOrigin = assistantAuthorizeOrigin(authorizeUrl)

  return (
    <PreferencesSegment>
      <Title>Guided ChatGPT / Codex subscription pairing</Title>
      <Text className="mt-1">
        Pair a ChatGPT/Codex subscription once so the server can use it for the assistant. The OAuth token is exchanged,
        held, and auto-refreshed on the server and is never shown here.
      </Text>

      <div className="border-warning bg-warning-faded mt-3 rounded border border-solid p-3">
        <Subtitle className="text-warning">Best-effort, unverified integration</Subtitle>
        <Text className="mt-1">
          The ChatGPT/Codex OAuth flow is not a stable public API — endpoints, client id and scopes are best-effort
          defaults, fully overridable with server environment variables. OpenAI&rsquo;s Codex client historically only
          permits a <code>localhost</code> redirect, so the server-hosted redirect may be rejected. If so, use the{' '}
          <strong>paste the code</strong> path in step 3.
        </Text>
      </div>

      <div className="border-danger bg-danger-faded mt-3 rounded border border-solid p-3">
        <Subtitle className="text-danger">Server credential security</Subtitle>
        <Text className="mt-1">
          Pairing grants this instance a renewable credential for your ChatGPT account. Protect the instance host,
          backups, and <code>ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY</code>; restrict this page to trusted administrators
          and unpair immediately after suspected host or key compromise.
        </Text>
      </div>

      <HorizontalSeparator classes="my-4" />

      {/* Current status */}
      <div className="mb-4 flex items-center justify-between gap-2">
        <Subtitle>Current status · {activeSubscriptionId}</Subtitle>
        <span
          className={`inline-block rounded px-2 py-0.5 text-xs font-bold whitespace-nowrap ${
            paired ? 'bg-success text-success-contrast' : 'bg-passive-4 text-foreground'
          }`}
        >
          {status === null ? 'Unknown' : paired ? 'Paired' : 'Not paired'}
        </span>
      </div>
      {paired && (
        <Text className="mb-3">
          Paired
          {status?.accountLabel ? ` as ${status.accountLabel}` : status?.accountId ? ` (${status.accountId})` : ''}
          {expiry ? `. Access token expires: ${expiry}` : '.'}
          {status?.needsRepair && (
            <span className="text-warning block">The stored token needs re-pairing — run the wizard again.</span>
          )}
          {!status?.needsRepair && status?.refreshRetryAt && status.refreshRetryAt > Date.now() && (
            <span className="text-warning block">
              Refresh is temporarily paused after a provider/network failure and will retry after{' '}
              {new Date(status.refreshRetryAt).toLocaleString()}. Re-pairing is not required.
            </span>
          )}
          {(status?.referencedByProfiles?.length ?? 0) > 0 && (
            <span className="text-passive-1 block">
              Used by assistant or backend profile(s):{' '}
              {status?.referencedByProfiles?.map((profile) => profile.name).join(', ')}.
            </span>
          )}
          {status?.profileReferencesKnown === false && (
            <span className="text-danger block">
              Assistant or backend profile references could not be checked; unpairing is blocked until settings are
              readable.
            </span>
          )}
        </Text>
      )}
      {!paired && status?.usingEnvFallback && (
        <Text className="text-passive-1 mb-3">
          The server is using an explicitly configured legacy environment bearer because durable pairing is not
          configured. Once durable pairing is enabled, missing, repair-required, or unreadable slots fail closed.
        </Text>
      )}
      {!paired && status?.reason && <Text className="text-passive-1 mb-3">{status.reason}</Text>}

      {/* Step 1 */}
      <div className="mb-4 flex items-start gap-3">
        <StepBadge n={1} active={step === 'idle'} done={step !== 'idle'} />
        <div className="flex-1">
          <Subtitle>Generate the authorization link</Subtitle>
          <Text className="mt-1">
            The authorization URL contains a one-time state and PKCE challenge. The verifier remains encrypted
            server-side, and no access or refresh credential is returned to this app.
          </Text>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <DecoratedInput
              className={{ container: 'w-64' }}
              placeholder="Subscription id (default or e.g. team-a)"
              value={subscriptionId}
              onChange={setSubscriptionId}
              disabled={loading}
            />
            <Button
              label={loading && step === 'idle' ? 'Generating…' : 'Generate authorization link'}
              primary
              onClick={() => void handleGenerate()}
              disabled={loading}
            />
          </div>
          <Text className="text-passive-1 mt-1 text-xs">
            Leave the id empty for the default subscription, or set one (matching a subscription backend profile) to add
            an additional pairing without dropping the existing ones.
          </Text>
        </div>
      </div>

      {/* Step 2 */}
      <div className="mb-4 flex items-start gap-3">
        <StepBadge n={2} active={step === 'authorize'} done={step === 'done'} />
        <div className="flex-1">
          <Subtitle>Open the link and authorize</Subtitle>
          <Text className="mt-1">Open the URL, log in to ChatGPT, and approve access.</Text>
          {step === 'authorize' && authorizeUrl && (
            <>
              <Text className="text-passive-1 mt-2">
                The one-time URL is intentionally not displayed or copied into the page. Open it directly in an isolated
                tab.
              </Text>
              {authorizeOrigin && (
                <Text className="text-warning mt-1">
                  Authorization will open at <code>{authorizeOrigin}</code>. Verify this is the OAuth provider your
                  operator configured before entering credentials or approving access.
                </Text>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button label="Open in new tab" primary onClick={handleOpenAuthorize} disabled={loading} />
                <Button label="Check pairing" onClick={() => void refreshStatus()} disabled={loading} />
                {polling && <Text className="text-passive-1">Waiting for you to finish in ChatGPT…</Text>}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Step 3 */}
      <div className="mb-2 flex items-start gap-3">
        <StepBadge n={3} active={step === 'authorize'} done={step === 'done'} />
        <div className="flex-1">
          <Subtitle>Finish pairing</Subtitle>
          <Text className="mt-1">
            If the redirect returned to this server, pairing completes automatically. Otherwise paste the authorization
            code shown after login below.
          </Text>
          {step === 'authorize' && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <DecoratedInput
                className={{ container: 'w-80' }}
                type="password"
                autocomplete={false}
                spellcheck={false}
                placeholder="Paste authorization code"
                value={pastedCode}
                onChange={setPastedCode}
                onEnter={() => void handlePasteComplete()}
                disabled={loading}
              />
              <Button
                label={loading ? 'Completing…' : 'Complete pairing'}
                primary
                onClick={() => void handlePasteComplete()}
                disabled={loading || pastedCode.trim() === ''}
              />
            </div>
          )}
        </div>
      </div>

      {error && <Text className="text-danger mt-3">{error}</Text>}

      {(paired || step === 'done') && (
        <>
          <HorizontalSeparator classes="my-4" />
          <div className="flex flex-wrap items-center gap-2">
            <Button label="Re-pair" onClick={() => void handleGenerate()} disabled={loading} />
            <Button label="Unpair" colorStyle="danger" onClick={() => void handleUnpair()} disabled={loading} />
          </div>
        </>
      )}
    </PreferencesSegment>
  )
}

export default CodexPairingWizard
