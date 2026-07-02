import { useCallback, useEffect, useState } from 'react'
import { ApplicationEvent } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { WorkflowsStatusState, workflowsStatusService } from './workflowsStatus'

export type UseWorkflowsStatusResult = {
  /** Cached module-wide status state (shared by the sidebar button and pane). */
  state: WorkflowsStatusState
  /** Whether there is an actual signed-in server session (not passcode-only). */
  signedIn: boolean
  /** Force a refetch of GET /v1/workflows/status. */
  refresh: () => Promise<void>
}

/**
 * Live workflows-status state for the sidebar button and WorkflowsView.
 * Subscribes to the shared workflowsStatusService cache, triggers the initial
 * fetch when a signed-in session exists, and resets + refetches on sign-in/out
 * so the button appears/disappears with the session. Gated on
 * `sessions.isSignedIn()` (like the assistant usage chip) so passcode-only /
 * offline accounts never issue an unauthenticated request.
 */
export function useWorkflowsStatus(application: WebApplication): UseWorkflowsStatusResult {
  const [state, setState] = useState<WorkflowsStatusState>(() => workflowsStatusService.get())
  const [signedIn, setSignedIn] = useState(() => application.sessions.isSignedIn())

  useEffect(() => {
    setState(workflowsStatusService.get())
    return workflowsStatusService.subscribe(setState)
  }, [])

  // Initial fetch: only when signed in and nothing cached yet.
  useEffect(() => {
    if (signedIn && workflowsStatusService.get().kind === 'unknown') {
      void workflowsStatusService.refresh(application)
    }
  }, [application, signedIn])

  // Refetch on sign-in and hide on sign-out; Launched covers sessions restored
  // after the hook first mounted (app boot ordering).
  useEffect(() => {
    return application.addEventObserver(async (event) => {
      switch (event) {
        case ApplicationEvent.Launched:
        case ApplicationEvent.SignedIn:
        case ApplicationEvent.SignedOut: {
          const nowSignedIn = application.sessions.isSignedIn()
          setSignedIn(nowSignedIn)
          workflowsStatusService.reset()
          if (nowSignedIn) {
            void workflowsStatusService.refresh(application)
          }
          break
        }
        default:
          break
      }
    })
  }, [application])

  const refresh = useCallback(() => workflowsStatusService.refresh(application), [application])

  return { state, signedIn, refresh }
}
