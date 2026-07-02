import { forwardRef, ReactNode, useCallback, useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { classNames } from '@standardnotes/utils'
import { ToastType, addToast } from '@standardnotes/toast'
import { confirmDialog } from '@standardnotes/ui-services'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import Button from '@/Components/Button/Button'
import { ErrorBoundary } from '@/Utils/ErrorBoundary'
import { AppPaneId } from '../Panes/AppPaneMetadata'
import { useWorkflowsStatus } from './useWorkflowsStatus'
import { resolveWorkflowsEditorUrl, workflowsStatusService } from './workflowsStatus'

type Props = {
  application: WebApplication
  className?: string
  id?: string
  children?: ReactNode
}

/**
 * Iframe sandbox/allow flags for the embedded n8n editor — the vetted set from
 * WebEmbedNode.tsx (SANDBOX_DEFAULT / IFRAME_ALLOW there). Scripts, own-origin
 * storage/fetch, forms, popups (escaping to a normal tab), modals, downloads
 * and presentation are enabled — everything a rich SPA like the n8n editor
 * needs — while `allow-top-navigation` stays OFF so the frame can never
 * navigate the whole app away, and referrerPolicy="no-referrer" avoids leaking
 * the app URL. Camera/microphone/geolocation are intentionally never granted.
 */
const EDITOR_SANDBOX = [
  'allow-scripts',
  'allow-same-origin',
  'allow-forms',
  'allow-popups',
  'allow-popups-to-escape-sandbox',
  'allow-modals',
  'allow-downloads',
  'allow-presentation',
].join(' ')

const EDITOR_IFRAME_ALLOW = 'clipboard-write; fullscreen; encrypted-media; picture-in-picture; autoplay'

const EXPLAINER =
  'Workflows let you build visual automations for your notebook: react to events (a note created or updated), ' +
  'run AI-agent steps, send emails or messages, and share notes or files — all executed by an automation engine ' +
  'running beside your server. It only ever talks to your account through a revocable, scoped access token; your ' +
  'master key and note contents stay end-to-end encrypted.'

const NOT_ENABLED_EXPLAINER =
  'Workflows are not enabled for your account. An administrator must enable the feature for you ' +
  '(Preferences → Admin → Workflows) before you can connect.'

/** Header chip showing the pairing state. */
const StatusChip = ({ paired }: { paired: boolean }) => (
  <span
    className={classNames(
      'rounded-full border px-2 py-0.5 text-xs font-semibold',
      paired ? 'border-success text-success' : 'border-border text-passive-1',
    )}
  >
    {paired ? 'Connected' : 'Not connected'}
  </span>
)

/** Simple loading skeleton shown while GET /v1/workflows/status is in flight. */
const LoadingSkeleton = () => (
  <div className="flex flex-col gap-3 p-4" aria-label="Loading workflows status" role="status">
    <div className="h-5 w-48 animate-pulse rounded bg-contrast" />
    <div className="h-4 w-full animate-pulse rounded bg-contrast" />
    <div className="h-4 w-5/6 animate-pulse rounded bg-contrast" />
    <div className="h-24 w-full animate-pulse rounded bg-contrast" />
  </div>
)

/**
 * Standard Red Notes: the Workflows pane (Phase 1). Shows the pairing status
 * for the n8n-backed automation engine, lets the user connect ("pair") or
 * disconnect, and — once paired — embeds the workflow editor in a sandboxed,
 * click-to-load iframe (never auto-loaded). Degrades gracefully when the
 * server has not deployed /v1/workflows/* yet (endpoint 404s → explanatory
 * message), and hides functionality when the account is not entitled.
 */
const WorkflowsView = forwardRef<HTMLDivElement, Props>(({ application, className, id, children }, ref) => {
  const { state, signedIn, refresh } = useWorkflowsStatus(application)

  const [pairing, setPairing] = useState(false)
  const [unpairing, setUnpairing] = useState(false)
  // Click-to-load: the editor iframe is NEVER auto-loaded; the user must
  // explicitly press "Load workflow editor" each time the pane mounts.
  const [editorLoaded, setEditorLoaded] = useState(false)

  const status = state.kind === 'loaded' ? state.status : undefined
  const paired = status?.paired === true
  const host = application.getHost.execute().getValue()
  const editorSrc = resolveWorkflowsEditorUrl(host, status?.editorUrl ?? null)

  // If the pairing goes away (unpair, account change), drop the loaded editor.
  useEffect(() => {
    if (!paired) {
      setEditorLoaded(false)
    }
  }, [paired])

  const pair = useCallback(async () => {
    setPairing(true)
    try {
      const { status: httpStatus, ok, data } = await application.serverJsonRequest<{
        paired?: boolean
        editorUrl?: string
      }>('/v1/workflows/pair', {})
      if (ok && data?.paired === true) {
        workflowsStatusService.setStatus({
          enabled: true,
          paired: true,
          editorUrl: typeof data.editorUrl === 'string' ? data.editorUrl : null,
        })
        addToast({ type: ToastType.Success, message: 'Workflows connected.' })
      } else if (httpStatus === 403) {
        addToast({
          type: ToastType.Error,
          message: 'Workflows are not enabled for your account. Ask an administrator to enable them.',
        })
        void refresh()
      } else {
        addToast({ type: ToastType.Error, message: 'Failed to connect workflows. Please try again.' })
      }
    } catch (error) {
      console.error(error)
      addToast({ type: ToastType.Error, message: 'Failed to connect workflows. Please try again.' })
    } finally {
      setPairing(false)
    }
  }, [application, refresh])

  const unpair = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: 'Disconnect workflows',
      text:
        'Disconnect workflows? Your automation account is disabled and its access token is revoked. ' +
        'You can reconnect at any time.',
      confirmButtonText: 'Disconnect',
      confirmButtonStyle: 'danger',
    })
    if (!confirmed) {
      return
    }
    setUnpairing(true)
    try {
      const { ok, data } = await application.serverJsonRequest<{ paired?: boolean }>('/v1/workflows/unpair', {})
      if (ok && data?.paired === false) {
        workflowsStatusService.setStatus({ enabled: true, paired: false, editorUrl: null })
        addToast({ type: ToastType.Success, message: 'Workflows disconnected.' })
      } else {
        addToast({ type: ToastType.Error, message: 'Failed to disconnect workflows. Please try again.' })
      }
    } catch (error) {
      console.error(error)
      addToast({ type: ToastType.Error, message: 'Failed to disconnect workflows. Please try again.' })
    } finally {
      setUnpairing(false)
    }
  }, [application])

  const renderBody = () => {
    if (!signedIn) {
      return (
        <div className="px-4 py-10 text-center text-sm text-passive-1">
          Sign in to a server to use Workflows.
        </div>
      )
    }

    if (state.kind === 'unknown' || state.kind === 'loading') {
      return <LoadingSkeleton />
    }

    if (state.kind === 'unavailable') {
      return (
        <div className="flex flex-col gap-3 p-4">
          <p className="text-sm text-passive-0">{EXPLAINER}</p>
          <p className="text-sm text-passive-1">
            Workflows are not available on this server (the server may not have the workflows service deployed yet).
          </p>
          <div>
            <Button label="Check again" onClick={() => void refresh()} />
          </div>
        </div>
      )
    }

    if (!status?.enabled) {
      return (
        <div className="flex flex-col gap-3 p-4">
          <p className="text-sm text-passive-0">{EXPLAINER}</p>
          <p className="text-sm font-semibold text-warning">{NOT_ENABLED_EXPLAINER}</p>
          <div>
            <Button label="Check again" onClick={() => void refresh()} />
          </div>
        </div>
      )
    }

    if (!paired) {
      return (
        <div className="flex flex-col gap-3 p-4">
          <p className="text-sm text-passive-0">{EXPLAINER}</p>
          <p className="text-sm text-passive-1">
            Connecting provisions your personal automation workspace and a revocable, scoped access token. You can
            disconnect at any time.
          </p>
          <div>
            <Button primary label={pairing ? 'Connecting…' : 'Connect workflows'} onClick={() => void pair()} disabled={pairing} />
          </div>
        </div>
      )
    }

    return (
      <div className="flex min-h-0 flex-grow flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-grow text-sm text-passive-1">
            Your workflows account is connected. Build and manage automations in the editor below.
          </p>
          <Button label={unpairing ? 'Disconnecting…' : 'Disconnect'} onClick={() => void unpair()} disabled={unpairing} />
        </div>

        {!editorSrc ? (
          <p className="text-sm text-danger">
            The server did not provide a usable workflow editor address. Try disconnecting and reconnecting.
          </p>
        ) : !editorLoaded ? (
          /* Click-to-load card: the editor is NEVER auto-loaded. */
          <div className="rounded border border-border p-4">
            <div className="flex items-start gap-2">
              <Icon type="tune" className="mt-0.5 flex-shrink-0 text-info" />
              <div>
                <div className="font-semibold">Workflow editor</div>
                <p className="mt-1 text-sm text-passive-0">
                  The editor runs in an embedded, sandboxed frame served through your server. Load it when you are
                  ready to build or manage automations.
                </p>
                <p className="mt-1 break-all text-xs text-passive-1">{editorSrc}</p>
              </div>
            </div>
            <div className="mt-3">
              <Button primary label="Load workflow editor" onClick={() => setEditorLoaded(true)} />
            </div>
          </div>
        ) : (
          <div className="min-h-[480px] w-full flex-grow overflow-hidden rounded border border-border">
            <iframe
              title="Workflow editor"
              src={editorSrc}
              className="h-full w-full border-0"
              sandbox={EDITOR_SANDBOX}
              allow={EDITOR_IFRAME_ALLOW}
              referrerPolicy="no-referrer"
              loading="lazy"
            />
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      id={id}
      ref={ref}
      className={classNames(className, 'flex h-full flex-col overflow-hidden border-l border-border bg-default')}
    >
      <div className="flex items-center justify-between border-b border-border bg-contrast px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon type="tune" className="flex-shrink-0 text-info" />
          <span className="text-base font-bold">Workflows</span>
          {state.kind === 'loaded' && status?.enabled ? <StatusChip paired={paired} /> : null}
        </div>
        <button
          className="rounded p-1 hover:bg-default"
          onClick={() => application.paneController.closeViewTab(AppPaneId.Workflows)}
          aria-label="Close workflows"
          title="Close"
        >
          <Icon type="close" />
        </button>
      </div>

      <div className="flex min-h-0 flex-grow flex-col overflow-y-auto">
        <ErrorBoundary regionName="Workflows">{renderBody()}</ErrorBoundary>
      </div>
      {children}
    </div>
  )
})

WorkflowsView.displayName = 'WorkflowsView'

export default observer(WorkflowsView)
