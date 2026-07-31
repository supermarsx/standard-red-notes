import { forwardRef, ReactNode, useCallback } from 'react'
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
import { openExternalWorkflowsUrl, resolveWorkflowsPublicUrl } from './workflowsStatus'

type Props = {
  application: WebApplication
  className?: string
  id?: string
  children?: ReactNode
}

const EXPLAINER =
  'This server can publish a link to an operator-managed n8n automation service. n8n is a separate application with its own accounts, sessions, authorization, and credential store.'

const NOT_ENABLED_EXPLAINER =
  'Workflows discovery is not enabled for this server/account. An operator controls the server switch and an administrator controls the per-user flag.'

const LoadingSkeleton = () => (
  <div className="flex flex-col gap-3 p-4" aria-label="Loading workflows status" role="status">
    <div className="bg-contrast h-5 w-48 animate-pulse rounded" />
    <div className="bg-contrast h-4 w-full animate-pulse rounded" />
    <div className="bg-contrast h-4 w-5/6 animate-pulse rounded" />
    <div className="bg-contrast h-24 w-full animate-pulse rounded" />
  </div>
)

const AvailabilityChip = ({ available }: { available: boolean }) => (
  <span
    className={classNames(
      'rounded-full border px-2 py-0.5 text-xs font-semibold',
      available ? 'border-success text-success' : 'border-warning text-warning',
    )}
  >
    {available ? 'External service' : 'Needs configuration'}
  </span>
)

const WorkflowsView = forwardRef<HTMLDivElement, Props>(({ application, className, id, children }, ref) => {
  const { state, signedIn, refresh } = useWorkflowsStatus(application)
  const status = state.kind === 'loaded' ? state.status : undefined
  const apiHost = application.getHost.execute().getValue()
  const browserOrigin = typeof window === 'undefined' ? null : window.location.origin
  const publicUrl = resolveWorkflowsPublicUrl(status?.publicUrl ?? null, apiHost, browserOrigin)

  const openN8n = useCallback(async () => {
    if (!publicUrl) {
      addToast({
        type: ToastType.Error,
        message: 'The server did not provide a safe, separate n8n address.',
      })
      return
    }
    const confirmed = await confirmDialog({
      title: 'Open the external n8n service?',
      text: 'n8n is operated and authenticated separately from Standard Red Notes. Opening it does not create an n8n account or grant access. Any workflow can read or modify everything allowed by credentials you configure in n8n, including a Standard Red Notes MCP credential.',
      confirmButtonText: 'Open n8n',
    })
    if (!confirmed) {
      return
    }
    openExternalWorkflowsUrl(publicUrl)
  }, [publicUrl])

  const renderBody = () => {
    if (!signedIn) {
      return <div className="text-passive-1 px-4 py-10 text-center text-sm">Sign in to a server to use Workflows.</div>
    }
    if (state.kind === 'unknown' || state.kind === 'loading') {
      return <LoadingSkeleton />
    }
    if (state.kind === 'unavailable') {
      return (
        <div className="flex flex-col gap-3 p-4">
          <p className="text-passive-0 text-sm">{EXPLAINER}</p>
          <p className="text-passive-1 text-sm">
            The workflows status could not be loaded. The server may not expose the endpoint, the session may have
            expired, or the network may be unavailable.
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
          <p className="text-passive-0 text-sm">{EXPLAINER}</p>
          <p className="text-warning text-sm font-semibold">{NOT_ENABLED_EXPLAINER}</p>
          <div>
            <Button label="Check again" onClick={() => void refresh()} />
          </div>
        </div>
      )
    }

    return (
      <div className="flex flex-col gap-4 p-4">
        <p className="text-passive-0 text-sm">{EXPLAINER}</p>

        {!status.available || !publicUrl ? (
          <div className="border-warning rounded border p-4" role="alert">
            <div className="font-semibold">The external service link is not safely configured</div>
            <p className="text-passive-0 mt-1 text-sm">
              An administrator must set a distinct HTTPS hostname. The n8n hostname cannot match the app or API
              hostname, even on another port, and cannot fall inside a domain-scoped Standard Red Notes auth cookie.
            </p>
          </div>
        ) : (
          <div className="border-border rounded border p-4">
            <div className="flex items-start gap-2">
              <Icon type="tune" className="text-info mt-0.5 flex-shrink-0" />
              <div className="min-w-0">
                <div className="font-semibold">Operator-managed n8n</div>
                <p className="text-passive-0 mt-1 text-sm">
                  Opens in a new tab with no opener and no referrer. Standard Red Notes does not forward your session,
                  authenticate you to n8n, provision a workspace, or embed the editor.
                </p>
                <p className="text-passive-1 mt-2 text-xs break-all">{publicUrl}</p>
              </div>
            </div>
            <div className="mt-3">
              <Button primary label="Open n8n in a new tab" onClick={() => void openN8n()} />
            </div>
          </div>
        )}

        <div className="border-warning rounded border p-4">
          <div className="font-semibold">Credential boundary</div>
          <p className="text-passive-0 mt-1 text-sm">
            To let n8n call Standard Red Notes, manually create a revocable, least-privilege MCP credential and store it
            only in n8n&apos;s credential manager. Never put it in a URL, workflow source, expression, or log. Workflows
            can read or modify anything that credential permits, and the n8n operator can inspect workflow definitions
            and execution data.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div
      id={id}
      ref={ref}
      className={classNames(className, 'border-border bg-default flex h-full flex-col overflow-hidden border-l')}
    >
      <div className="border-border bg-contrast flex items-center justify-between border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon type="tune" className="text-info flex-shrink-0" />
          <span className="text-base font-bold">Workflows</span>
          {state.kind === 'loaded' && status?.enabled ? <AvailabilityChip available={Boolean(publicUrl)} /> : null}
        </div>
        <button
          className="hover:bg-default rounded p-1"
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
