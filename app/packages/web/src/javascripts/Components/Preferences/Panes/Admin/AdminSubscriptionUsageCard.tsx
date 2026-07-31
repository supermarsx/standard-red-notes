import { FunctionComponent, useCallback, useEffect, useState } from 'react'

import {
  WebApplication,
  AssistantSubscriptionUsage,
  AssistantSubscriptionUsageWindow,
} from '@/Application/WebApplication'
import { Subtitle, Text } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import Button from '@/Components/Button/Button'
import { formatTokens } from '@/Components/Footer/assistantUsageFormat'
import { formatResetDuration } from '@/Assistant/usageMeter'
import { ToastType, addToast } from '@standardnotes/toast'
import { confirmDialog } from '@standardnotes/ui-services'

type Props = {
  application: WebApplication
  /** Called after a pairing is removed here so sibling views can refresh. */
  onChange?: () => void
}

/** One paired subscription's non-secret status (from /subscription/list). */
type SubscriptionEntry = {
  id: string
  paired: boolean
  legacyInvalidId?: boolean
  accountLabel?: string
  accountId?: string
  expiresAt?: number
  needsRepair?: boolean
  refreshRetryAt?: number
  refreshFailureCode?: string
  referencedByProfiles?: { id: string; name: string }[]
  profileReferencesKnown?: boolean
}

type WindowRowProps = {
  label: string
  window: AssistantSubscriptionUsageWindow | undefined
}

const WindowRow: FunctionComponent<WindowRowProps> = ({ label, window }) => {
  if (!window || window.unavailable) {
    return (
      <div className="flex items-center justify-between gap-2 py-1">
        <span className="text-foreground text-sm font-medium">{label}</span>
        <span className="text-passive-1 text-sm">Usage unavailable</span>
      </div>
    )
  }
  const resetIn = formatResetDuration(window.resetsAt)
  return (
    <div className="flex items-center justify-between gap-2 py-1">
      <span className="text-foreground text-sm font-medium">{label}</span>
      <span className="text-foreground text-sm tabular-nums">
        {formatTokens(window.usedTokens)} tokens
        {resetIn && resetIn !== 'now' && <span className="text-passive-1 ml-2">· resets in {resetIn}</span>}
      </span>
    </div>
  )
}

/**
 * Admin read-only "Subscription usage" card. Surfaces the tokens SRN has METERED
 * LOCALLY for subscription-backed (Codex/ChatGPT) proxy calls over the 5h +
 * weekly rolling windows — for the cross-subscription AGGREGATE and, when
 * MULTIPLE subscriptions are paired, for EACH one individually. Each paired
 * subscription can also be removed here.
 *
 * HONESTY: ChatGPT/Codex subscriptions expose no documented, queryable usage or
 * quota endpoint (rate-limit state only comes back in per-response headers), so
 * this is explicitly SRN-side metering — NOT OpenAI's official remaining quota.
 */
const AdminSubscriptionUsageCard: FunctionComponent<Props> = ({ application, onChange }) => {
  const [aggregate, setAggregate] = useState<AssistantSubscriptionUsage | null>(null)
  const [subscriptions, setSubscriptions] = useState<SubscriptionEntry[]>([])
  const [perId, setPerId] = useState<Record<string, AssistantSubscriptionUsage>>({})
  const [available, setAvailable] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await application.assistantSubscriptionUsage()
      if (Number(response.status) === 404) {
        setAvailable(false)
        return
      }
      if (!response.ok) {
        setAvailable(true)
        setError(`Couldn't load usage (server responded ${response.status || 'error'}).`)
        return
      }
      setAvailable(true)
      setAggregate(response.data ?? null)

      // List every paired subscription, then fetch each one's per-id usage.
      const list = await application.serverGetJsonRequest<{ subscriptions?: SubscriptionEntry[] }>(
        '/v1/assistant/subscription/list',
      )
      const entries = list.ok ? (list.data?.subscriptions ?? []) : []
      setSubscriptions(entries)
      const usageByIdEntries = await Promise.all(
        entries
          .filter((entry) => !entry.legacyInvalidId)
          .map(async (entry) => {
            const usage = await application.serverGetJsonRequest<AssistantSubscriptionUsage>(
              `/v1/assistant/subscription/usage?subscriptionId=${encodeURIComponent(entry.id)}`,
            )
            return [entry.id, usage.ok ? usage.data : {}] as const
          }),
      )
      setPerId(Object.fromEntries(usageByIdEntries))
    } catch {
      setAvailable(true)
      setError("Couldn't load usage. Please try again.")
    } finally {
      setLoading(false)
    }
  }, [application])

  useEffect(() => {
    void load()
  }, [load])

  const removeOne = useCallback(
    async (id: string) => {
      const entry = subscriptions.find((candidate) => candidate.id === id)
      const references = entry?.referencedByProfiles ?? []
      if (
        !(await confirmDialog({
          title: entry?.legacyInvalidId ? `Remove legacy pairing "${id}"?` : `Unpair subscription "${id}"?`,
          text:
            entry?.profileReferencesKnown === false
              ? 'Profile references could not be checked. The server will fail closed and refuse this operation.'
              : references.length > 0
                ? `This leaves ${references.length} assistant or backend profile(s) without a credential until the same id is re-paired or those profiles are changed.`
                : entry?.legacyInvalidId
                  ? 'This historical id is visible for remediation but is already blocked from runtime use. Its stored credential will be permanently removed; other pairings are unaffected.'
                  : 'The stored credential and pending attempts for this id are removed. Other pairings are unaffected.',
          confirmButtonText: entry?.legacyInvalidId ? 'Remove legacy pairing' : 'Unpair',
          confirmButtonStyle: 'danger',
        }))
      ) {
        return
      }
      const { ok } = await application.assistantSubscriptionUnpair(
        id,
        references.length > 0,
        entry?.legacyInvalidId ? id : undefined,
      )
      if (ok) {
        addToast({ type: ToastType.Success, message: `Subscription "${id}" unpaired.` })
        onChange?.()
        await load()
      } else {
        addToast({ type: ToastType.Error, message: 'The server rejected the unpair request.' })
      }
    },
    [application, onChange, load, subscriptions],
  )

  if (!available) {
    return null
  }

  return (
    <PreferencesSegment>
      <div className="border-border rounded border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Subtitle>Subscription usage</Subtitle>
          <Button label={loading ? 'Refreshing…' : 'Refresh'} onClick={() => void load()} disabled={loading} />
        </div>
        <Text className="text-passive-1 mt-1">
          Tokens Standard Red Notes has metered locally for subscription-backed (Codex / ChatGPT) proxy calls, over
          rolling windows. This is <strong>SRN-side metering, not OpenAI's official quota</strong>.
        </Text>
        {error ? (
          <Text className="text-danger mt-3">{error}</Text>
        ) : (
          <>
            <div className="mt-3">
              <div className="text-foreground text-sm font-semibold">All subscriptions (aggregate)</div>
              <div className="divide-border divide-y">
                <WindowRow label="Last 5 hours" window={aggregate?.tokens?.fiveHour} />
                <WindowRow label="Last 7 days" window={aggregate?.tokens?.weekly} />
              </div>
            </div>

            {subscriptions.length > 0 && (
              <div className="mt-4 space-y-3">
                <div className="text-foreground text-sm font-semibold">Per paired subscription</div>
                {subscriptions.map((entry) => (
                  <div key={entry.id} className="border-border rounded border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-foreground text-sm font-medium">
                        {entry.id}
                        {entry.accountLabel ? ` · ${entry.accountLabel}` : ''}
                        {entry.legacyInvalidId && (
                          <span className="text-danger ml-2">legacy id — runtime disabled; remove or re-pair</span>
                        )}
                        {entry.needsRepair && <span className="text-warning ml-2">needs re-pair</span>}
                        {!entry.needsRepair && entry.refreshRetryAt && entry.refreshRetryAt > Date.now() && (
                          <span className="text-warning ml-2">refresh retry scheduled</span>
                        )}
                      </span>
                      <Button
                        label={entry.legacyInvalidId ? 'Remove legacy pairing' : 'Unpair'}
                        colorStyle="danger"
                        onClick={() => void removeOne(entry.id)}
                        disabled={loading}
                      />
                    </div>
                    {entry.profileReferencesKnown === false && (
                      <Text className="text-danger mt-1">
                        Profile references are unavailable; targeted unpairing will fail closed.
                      </Text>
                    )}
                    {(entry.referencedByProfiles?.length ?? 0) > 0 && (
                      <Text className="text-passive-1 mt-1">
                        Used by: {entry.referencedByProfiles?.map((profile) => profile.name).join(', ')}
                      </Text>
                    )}
                    <div className="divide-border mt-1 divide-y">
                      <WindowRow label="Last 5 hours" window={perId[entry.id]?.tokens?.fiveHour} />
                      <WindowRow label="Last 7 days" window={perId[entry.id]?.tokens?.weekly} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </PreferencesSegment>
  )
}

export default AdminSubscriptionUsageCard
