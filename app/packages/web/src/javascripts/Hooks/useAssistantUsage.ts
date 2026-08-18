import { WebApplication } from '@/Application/WebApplication'
import { PrefKey } from '@standardnotes/snjs'
import { useEffect, useState } from 'react'
import { AssistantUsage, assistantUsageService, EMPTY_USAGE } from '@/Assistant/AssistantUsageService'
import { ServerCap } from '@/Components/Footer/assistantUsageFormat'
import { AssistantUsageResponse } from '@/Assistant/usageMeter'

export interface AssistantUsageState {
  /** Session token/request totals accumulated from provider responses. */
  session: AssistantUsage
  /**
   * Server-enforced request cap (proxy mode only). null when no cap applies or
   * it can't be read. The proxy meters REQUESTS per day, not tokens.
   */
  cap: ServerCap | null
}

/**
 * Live AI-usage state for the footer chip. Subscribes to the session token
 * accumulator (updated by the Direct/Proxy providers as requests complete) and,
 * in proxy mode, reads the server cap once on mount and after completed requests.
 * STREAM_ASSISTANT only negotiates streaming RPC; it does not imply a usage-event
 * feed, so these bounded reads remain necessary without background polling.
 */
export function useAssistantUsage(application: WebApplication): AssistantUsageState {
  const [session, setSession] = useState<AssistantUsage>(() => assistantUsageService.get() ?? EMPTY_USAGE)
  const [cap, setCap] = useState<ServerCap | null>(null)

  // Session token totals: re-render only when the accumulator actually changes.
  useEffect(() => {
    setSession(assistantUsageService.get())
    return assistantUsageService.subscribe(setSession)
  }, [])

  const connectionMode = application.getPreference(PrefKey.AssistantConnectionMode, 'direct')

  // Server request cap (proxy mode only). The assistant websocket streams
  // completions, but currently has no separately negotiated usage-event feed.
  useEffect(() => {
    // Only poll the authenticated /v1/assistant/usage endpoint when there is an
    // actual signed-in server session whose access token can be attached. Note
    // hasAccount() is true for passcode-only / offline accounts that have NO
    // server session, which previously caused the usage chip to poll without a
    // token and spam 401s. Gate on isSignedIn() instead (the same signed-in check
    // the Footer uses) so signed-out / offline users just see local session token
    // usage (no cap) and never issue an unauthenticated request.
    if (connectionMode !== 'proxy' || !application.sessions.isSignedIn()) {
      setCap(null)
      return
    }

    let disposed = false

    const refresh = async () => {
      try {
        const result = await application.assistantConfigRequest<AssistantUsageResponse>('/v1/assistant/usage')
        if (disposed || typeof result?.used !== 'number' || typeof result?.limit !== 'number') {
          return
        }
        setCap((prev) => {
          return prev && prev.used === result.used && prev.limit === result.limit
            ? prev
            : { used: result.used, limit: result.limit }
        })
      } catch {
        // Best-effort; leave the previous value in place.
      }
    }

    void refresh()
    // A local usage tick means one request actually completed.
    const unsubscribe = assistantUsageService.subscribe(() => void refresh())

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [application, connectionMode])

  return { session, cap }
}
