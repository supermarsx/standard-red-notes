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
  accountLabel?: string
  accountId?: string
  expiresAt?: number
  needsRepair?: boolean
}

type WindowRowProps = {
  label: string
  window: AssistantSubscriptionUsageWindow | undefined
}

const WindowRow: FunctionComponent<WindowRowProps> = ({ label, window }) => {
  if (!window || window.unavailable) {
    return (
      <div className="flex items-center justify-between gap-2 py-1">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="text-sm text-passive-1">Usage unavailable</span>
      </div>
    )
  }
  const resetIn = formatResetDuration(window.resetsAt)
  return (
    <div className="flex items-center justify-between gap-2 py-1">
      <span className="text-sm font-medium text-foreground">{label}</span>
      <span className="text-sm tabular-nums text-foreground">
        {formatTokens(window.usedTokens)} tokens
        {resetIn && resetIn !== 'now' && <span className="ml-2 text-passive-1">· resets in {resetIn}</span>}
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
      const entries = list.ok ? list.data?.subscriptions ?? [] : []
      setSubscriptions(entries)
      const usageByIdEntries = await Promise.all(
        entries.map(async (entry) => {
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
      if (
        !(await confirmDialog({
          title: `Unpair subscription "${id}"?`,
          text: 'The stored credential for this pairing is removed from the server. Other pairings are unaffected.',
          confirmButtonText: 'Unpair',
          confirmButtonStyle: 'danger',
        }))
      ) {
        return
      }
      const { ok } = await application.serverJsonRequest<{ ok?: boolean }>('/v1/assistant/subscription/unpair', {
        subscriptionId: id,
      })
      if (ok) {
        addToast({ type: ToastType.Success, message: `Subscription "${id}" unpaired.` })
        onChange?.()
        await load()
      } else {
        addToast({ type: ToastType.Error, message: 'The server rejected the unpair request.' })
      }
    },
    [application, onChange, load],
  )

  if (!available) {
    return null
  }

  return (
    <PreferencesSegment>
      <div className="rounded border border-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Subtitle>Subscription usage</Subtitle>
          <Button label={loading ? 'Refreshing…' : 'Refresh'} onClick={() => void load()} disabled={loading} />
        </div>
        <Text className="mt-1 text-passive-1">
          Tokens Standard Red Notes has metered locally for subscription-backed (Codex / ChatGPT) proxy calls, over
          rolling windows. This is <strong>SRN-side metering, not OpenAI's official quota</strong>.
        </Text>
        {error ? (
          <Text className="mt-3 text-danger">{error}</Text>
        ) : (
          <>
            <div className="mt-3">
              <div className="text-sm font-semibold text-foreground">All subscriptions (aggregate)</div>
              <div className="divide-y divide-border">
                <WindowRow label="Last 5 hours" window={aggregate?.tokens?.fiveHour} />
                <WindowRow label="Last 7 days" window={aggregate?.tokens?.weekly} />
              </div>
            </div>

            {subscriptions.length > 0 && (
              <div className="mt-4 space-y-3">
                <div className="text-sm font-semibold text-foreground">Per paired subscription</div>
                {subscriptions.map((entry) => (
                  <div key={entry.id} className="rounded border border-border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {entry.id}
                        {entry.accountLabel ? ` · ${entry.accountLabel}` : ''}
                        {entry.needsRepair && <span className="ml-2 text-warning">needs re-pair</span>}
                      </span>
                      <Button
                        label="Unpair"
                        colorStyle="danger"
                        onClick={() => void removeOne(entry.id)}
                        disabled={loading}
                      />
                    </div>
                    <div className="mt-1 divide-y divide-border">
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
