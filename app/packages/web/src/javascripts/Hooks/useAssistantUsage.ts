import { WebApplication } from '@/Application/WebApplication'
import { ApplicationEvent, PrefKey } from '@standardnotes/snjs'
import { useEffect, useState } from 'react'
import { AssistantUsage, getAssistantUsageService } from '@/Assistant/AssistantUsageService'
import { ServerCap } from '@/Components/Footer/assistantUsageFormat'
import { AssistantUsageResponse } from '@/Assistant/usageMeter'
import {
  assistantSessionPrincipalMatches,
  captureAssistantSessionPrincipal,
} from '@/Assistant/assistantSessionPrincipal'

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
  const [session, setSession] = useState<AssistantUsage>(() => getAssistantUsageService(application).get())
  const [cap, setCap] = useState<ServerCap | null>(null)

  // Authentication events can change the principal without remounting this
  // memoized footer. Each boundary invalidates pending responses synchronously.
  useEffect(() => {
    let usageService = getAssistantUsageService(application)
    setSession(usageService.get())
    let unsubscribeSession = usageService.subscribe(setSession)
    let unsubscribeRefresh: (() => void) | undefined
    let disposed = false
    let epoch = 0
    let pendingEpoch: number | undefined
    let refreshAgain = false
    let mode = application.getPreference(PrefKey.AssistantConnectionMode, 'direct')
    let principal = captureAssistantSessionPrincipal(application.sessions)

    const refresh = async () => {
      const requestPrincipal = captureAssistantSessionPrincipal(application.sessions)
      if (disposed || mode !== 'proxy' || !requestPrincipal.valid || !requestPrincipal.signedIn) {
        setCap(null)
        return
      }
      if (pendingEpoch === epoch) {
        refreshAgain = true
        return
      }
      const requestEpoch = epoch
      pendingEpoch = requestEpoch
      try {
        const result = await application.assistantConfigRequest<AssistantUsageResponse>('/v1/assistant/usage')
        if (
          disposed ||
          requestEpoch !== epoch ||
          !assistantSessionPrincipalMatches(requestPrincipal, captureAssistantSessionPrincipal(application.sessions)) ||
          application.getPreference(PrefKey.AssistantConnectionMode, 'direct') !== 'proxy' ||
          typeof result?.used !== 'number' ||
          typeof result?.limit !== 'number'
        ) {
          return
        }
        setCap((prev) => {
          return prev && prev.used === result.used && prev.limit === result.limit
            ? prev
            : { used: result.used, limit: result.limit }
        })
      } catch {
        // Best-effort within the current principal; boundaries clear old figures.
      } finally {
        if (!disposed && requestEpoch === epoch) {
          pendingEpoch = undefined
          if (refreshAgain) {
            refreshAgain = false
            void refresh()
          }
        }
      }
    }
    const stopEvents = application.addEventObserver(async (event) => {
      if (
        event !== ApplicationEvent.SignedIn &&
        event !== ApplicationEvent.SignedOut &&
        event !== ApplicationEvent.PreparingForSignOut &&
        event !== ApplicationEvent.KeyStatusChanged &&
        event !== ApplicationEvent.PreferencesChanged
      ) {
        return
      }
      const nextPrincipal = captureAssistantSessionPrincipal(application.sessions)
      const nextMode = application.getPreference(PrefKey.AssistantConnectionMode, 'direct')
      if (
        event === ApplicationEvent.PreferencesChanged &&
        nextMode === mode &&
        assistantSessionPrincipalMatches(principal, nextPrincipal)
      ) {
        return
      }
      const nextService = getAssistantUsageService(application)
      if (nextService !== usageService) {
        unsubscribeSession()
        unsubscribeRefresh?.()
        usageService = nextService
        setSession(usageService.get())
        unsubscribeSession = usageService.subscribe(setSession)
        unsubscribeRefresh = usageService.subscribe(() => void refresh())
      }
      principal = nextPrincipal
      mode = nextMode
      epoch += 1
      refreshAgain = false
      setCap(null)
      if (event !== ApplicationEvent.PreparingForSignOut) {
        void refresh()
      }
    })
    void refresh()
    unsubscribeRefresh = usageService.subscribe(() => void refresh())
    return () => {
      disposed = true
      epoch += 1
      stopEvents()
      unsubscribeSession()
      unsubscribeRefresh?.()
    }
  }, [application])

  return { session, cap }
}
