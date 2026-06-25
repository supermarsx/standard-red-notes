import { FunctionComponent, RefObject } from 'react'
import { observer } from 'mobx-react-lite'
import { classNames } from '@standardnotes/utils'
import Icon from '@/Components/Icon/Icon'
import Popover from '@/Components/Popover/Popover'
import { AppNotification, NotificationLevel, NotificationsController } from '@/Controllers/NotificationsController'

type Props = {
  controller: NotificationsController
  open: boolean
  anchorElement: RefObject<HTMLButtonElement | null>
  togglePopover: () => void
}

const LEVEL_ICON: Record<NotificationLevel, 'info' | 'warning'> = {
  info: 'info',
  warning: 'warning',
  error: 'warning',
}

const LEVEL_ACCENT: Record<NotificationLevel, string> = {
  info: 'text-info',
  warning: 'text-warning',
  error: 'text-danger',
}

const NotificationRow: FunctionComponent<{
  notification: AppNotification
  onDismiss: (id: string) => void
  onClose: () => void
}> = ({ notification, onDismiss, onClose }) => {
  return (
    <div className="flex gap-2.5 border-b border-border px-3.5 py-3 last:border-b-0">
      <Icon
        type={LEVEL_ICON[notification.level]}
        className={classNames('mt-0.5 flex-shrink-0', LEVEL_ACCENT[notification.level])}
      />
      <div className="min-w-0 flex-grow">
        <div className="text-sm font-bold text-text">{notification.title}</div>
        <div className="mt-0.5 text-sm text-neutral">{notification.message}</div>
        {notification.action && (
          <button
            className="mt-2 rounded bg-info px-2.5 py-1 text-xs font-semibold text-info-contrast hover:brightness-110"
            onClick={() => {
              notification.action?.run()
              onClose()
            }}
          >
            {notification.action.label}
          </button>
        )}
      </div>
      {notification.dismissable && (
        <button
          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-neutral hover:bg-contrast"
          onClick={() => onDismiss(notification.id)}
          aria-label="Dismiss notification"
          title="Dismiss"
        >
          <Icon type="close" size="small" />
        </button>
      )}
    </div>
  )
}

/**
 * Standard Red Notes: popover listing the app's centralized notifications, with
 * an empty "all caught up" state. Reuses the shared Popover/Icon primitives.
 */
const NotificationsPanel: FunctionComponent<Props> = ({ controller, open, anchorElement, togglePopover }) => {
  const notifications = controller.notifications

  return (
    <Popover
      title="Notifications"
      open={open}
      anchorElement={anchorElement}
      togglePopover={togglePopover}
      side="right"
      align="start"
      className="w-[20rem] max-w-[90vw]"
    >
      <div className="flex items-center justify-between border-b border-border px-3.5 py-2.5">
        <span className="text-sm font-bold text-text">Notifications</span>
        <button
          className="flex h-6 w-6 items-center justify-center rounded text-neutral hover:bg-contrast"
          onClick={togglePopover}
          aria-label="Close notifications"
          title="Close"
        >
          <Icon type="close" size="small" />
        </button>
      </div>
      <div className="max-h-[60vh] overflow-y-auto">
        {notifications.length === 0 ? (
          <div className="px-3.5 py-10 text-center text-sm text-passive-1">
            You're all caught up — no notifications.
          </div>
        ) : (
          notifications.map((notification) => (
            <NotificationRow
              key={notification.id}
              notification={notification}
              onDismiss={controller.dismiss}
              onClose={togglePopover}
            />
          ))
        )}
      </div>
    </Popover>
  )
}

export default observer(NotificationsPanel)
