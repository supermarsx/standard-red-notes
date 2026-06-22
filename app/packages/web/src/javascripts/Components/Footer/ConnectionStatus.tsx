import { WebApplication } from '@/Application/WebApplication'
import { classNames } from '@standardnotes/snjs'
import { FunctionComponent, memo } from 'react'
import { useConnectionStatus, ConnectionStatusKind } from '@/Hooks/useConnectionStatus'

type Props = {
  application: WebApplication
}

const DOT_CLASS: Record<ConnectionStatusKind, string> = {
  online: 'bg-success',
  reconnecting: 'bg-warning',
  offline: 'bg-neutral',
  'login-needed': 'bg-warning',
}

const LABEL: Record<ConnectionStatusKind, string> = {
  online: 'Connected',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
  'login-needed': 'Login needed',
}

const LOGIN_NEEDED_TOOLTIP = "You're signed out — click to sign in and resume syncing."

function formatRelative(date?: Date): string | undefined {
  if (!date) {
    return undefined
  }
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000))
  if (seconds < 60) {
    return `${seconds}s ago`
  }
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  const hours = Math.round(minutes / 60)
  return `${hours}h ago`
}

const ConnectionStatusIndicator: FunctionComponent<Props> = ({ application }) => {
  const status = useConnectionStatus(application)
  const lastSynced = formatRelative(status.lastSyncDate)

  let tooltip: string
  switch (status.kind) {
    case 'offline':
      tooltip = 'Offline — changes are saved locally and will sync when you reconnect.'
      break
    case 'reconnecting':
      tooltip = 'Reconnecting — attempting to sync with the server.'
      break
    case 'login-needed':
      tooltip = LOGIN_NEEDED_TOOLTIP
      break
    default:
      tooltip = status.signedOut
        ? 'Connected — working offline with local data.'
        : lastSynced
          ? `Connected — last synced ${lastSynced}.`
          : 'Connected to the server.'
      break
  }

  const dot = (
    <span
      className={classNames(
        'mr-1.5 inline-block h-2 w-2 flex-shrink-0 rounded-full',
        DOT_CLASS[status.kind],
        status.kind === 'reconnecting' && 'animate-pulse',
      )}
    />
  )

  // When the session needs re-authentication, the indicator becomes an
  // actionable button that reopens the sign-in window (instead of the app
  // force-reopening the re-login prompt). Other kinds stay non-interactive.
  if (status.kind === 'login-needed') {
    return (
      <button
        type="button"
        title={tooltip}
        onClick={() => application.accountMenuController.openSignIn()}
        className="flex cursor-pointer select-none items-center text-xs font-bold text-warning hover:underline"
        aria-label={`${LABEL[status.kind]} — ${tooltip}`}
      >
        {dot}
        <span className="hidden lg:inline">{LABEL[status.kind]}</span>
      </button>
    )
  }

  return (
    <div
      title={tooltip}
      className="flex select-none items-center text-xs font-bold text-neutral"
      role="status"
      aria-label={`${LABEL[status.kind]} — ${tooltip}`}
    >
      {dot}
      <span className="hidden lg:inline">{LABEL[status.kind]}</span>
    </div>
  )
}

/**
 * Memoized so the chip only re-renders when the resolved status object actually
 * changes (the hook already de-dupes by status kind / lastSyncDate), not on
 * every footer render triggered by unrelated state.
 */
export default memo(ConnectionStatusIndicator)
