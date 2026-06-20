import { WebApplication } from '@/Application/WebApplication'
import { PrefKey } from '@standardnotes/snjs'
import { useEffect, useState } from 'react'
import {
  AssistantUsage,
  assistantUsageService,
  EMPTY_USAGE,
} from '@/Assistant/AssistantUsageService'
import { ServerCap } from '@/Components/Footer/assistantUsageFormat'

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
 * in proxy mode, periodically reads the server's request cap from
 * GET /v1/assistant/usage. Both are best-effort: token counts are provider-
 * reported and the cap read silently no-ops when unavailable.
 */
export function useAssistantUsage(application: WebApplication): AssistantUsageState {
  const [session, setSession] = useState<AssistantUsage>(() => assistantUsageService.get() ?? EMPTY_USAGE)
  const [cap, setCap] = useState<ServerCap | null>(null)

  // Session token totals: re-render only when the accumulator actually changes.
  useEffect(() => {
    setSession(assistantUsageService.get())
    return assistantUsageService.subscribe(setSession)
  }, [])

  // Server request cap (proxy mode only). Refreshed when session usage advances
  // (a request just completed) and on a slow heartbeat as a safety net.
  useEffect(() => {
    const connectionMode = application.getPreference(PrefKey.AssistantConnectionMode, 'direct')
    if (connectionMode !== 'proxy' || !application.hasAccount()) {
      setCap(null)
      return
    }

    let disposed = false

    const refresh = async () => {
      try {
        const result = await application.assistantConfigRequest<{ used: number; limit: number }>('/v1/assistant/usage')
        if (disposed) {
          return
        }
        if (typeof result?.used === 'number' && typeof result?.limit === 'number') {
          setCap((prev) =>
            prev && prev.used === result.used && prev.limit === result.limit
              ? prev
              : { used: result.used, limit: result.limit },
          )
        }
      } catch {
        // Best-effort; leave the previous value in place.
      }
    }

    void refresh()
    // Re-read whenever the session accumulator ticks (a request just finished).
    const unsubscribe = assistantUsageService.subscribe(() => void refresh())
    const heartbeat = setInterval(() => void refresh(), 60_000)

    return () => {
      disposed = true
      unsubscribe()
      clearInterval(heartbeat)
    }
    // session.requests in deps so a mode change after a request still re-evaluates.
  }, [application, session.requests])

  return { session, cap }
}
