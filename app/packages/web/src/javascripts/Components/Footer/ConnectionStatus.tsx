import { WebApplication } from '@/Application/WebApplication'
import { classNames } from '@standardnotes/snjs'
import { FunctionComponent } from 'react'
import { useConnectionStatus, ConnectionStatusKind } from '@/Hooks/useConnectionStatus'

type Props = {
  application: WebApplication
}

const DOT_CLASS: Record<ConnectionStatusKind, string> = {
  online: 'bg-success',
  reconnecting: 'bg-warning',
  offline: 'bg-neutral',
}

const LABEL: Record<ConnectionStatusKind, string> = {
  online: 'Connected',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
}

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
    default:
      tooltip = status.signedOut
        ? 'Connected — working offline with local data.'
        : lastSynced
          ? `Connected — last synced ${lastSynced}.`
          : 'Connected to the server.'
      break
  }

  return (
    <div
      title={tooltip}
      className="flex select-none items-center text-xs font-bold text-neutral"
      role="status"
      aria-label={`${LABEL[status.kind]} — ${tooltip}`}
    >
      <span
        className={classNames(
          'mr-1.5 inline-block h-2 w-2 flex-shrink-0 rounded-full',
          DOT_CLASS[status.kind],
          status.kind === 'reconnecting' && 'animate-pulse',
        )}
      />
      <span className="hidden lg:inline">{LABEL[status.kind]}</span>
    </div>
  )
}

export default ConnectionStatusIndicator
