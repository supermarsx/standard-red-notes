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

type Props = {
  application: WebApplication
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
 * weekly rolling windows.
 *
 * HONESTY: ChatGPT/Codex subscriptions expose no documented, queryable usage or
 * quota endpoint (rate-limit state only comes back in per-response headers), so
 * this is explicitly SRN-side metering — NOT OpenAI's official remaining quota.
 * Degrades silently (renders nothing) on an older server that lacks the endpoint.
 */
const AdminSubscriptionUsageCard: FunctionComponent<Props> = ({ application }) => {
  const [usage, setUsage] = useState<AssistantSubscriptionUsage | null>(null)
  const [available, setAvailable] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await application.assistantSubscriptionUsage()
      // 404 => the server predates subscription usage metering: degrade silently.
      if (Number(response.status) === 404) {
        setAvailable(false)
        return
      }
      // Any other non-ok response (500 etc.) is a real failure — surface it
      // rather than hiding the card and masking it as an absent endpoint.
      if (!response.ok) {
        setAvailable(true)
        setError(`Couldn't load usage (server responded ${response.status || 'error'}).`)
        return
      }
      setAvailable(true)
      setUsage(response.data ?? null)
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
          Tokens Standard Red Notes has metered locally for subscription-backed (Codex / ChatGPT) proxy calls, across
          all users, over rolling windows. This is <strong>SRN-side metering, not OpenAI's official quota</strong> —
          ChatGPT/Codex subscriptions do not expose a usage endpoint we can poll.
        </Text>
        {error ? (
          <Text className="mt-3 text-danger">{error}</Text>
        ) : (
          <div className="mt-3 divide-y divide-border">
            <WindowRow label="Last 5 hours" window={usage?.tokens?.fiveHour} />
            <WindowRow label="Last 7 days" window={usage?.tokens?.weekly} />
          </div>
        )}
      </div>
    </PreferencesSegment>
  )
}

export default AdminSubscriptionUsageCard
