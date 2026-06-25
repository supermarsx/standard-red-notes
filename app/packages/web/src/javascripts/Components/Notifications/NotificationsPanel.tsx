import { FunctionComponent, RefObject, useEffect } from 'react'
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

/**
 * Compact popover row: just the level icon + title (the "basics") plus a dismiss
 * affordance. The full message + actions live in the Notifications tab, reached
 * via "View all" — keeping the popup lightweight.
 */
const CompactRow: FunctionComponent<{
  notification: AppNotification
  isRead: boolean
  onDismiss: (id: string) => void
}> = ({ notification, isRead, onDismiss }) => (
  <div className="flex items-center gap-2.5 border-b border-border px-3.5 py-2.5 last:border-b-0">
    <Icon type={LEVEL_ICON[notification.level]} className={classNames('flex-shrink-0', LEVEL_ACCENT[notification.level])} />
    <span className="min-w-0 flex-grow truncate text-sm font-semibold text-text" title={notification.title}>
      {notification.title}
    </span>
    {!isRead && <span className="h-2 w-2 flex-shrink-0 rounded-full bg-info" aria-label="Unread" />}
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

/**
 * Standard Red Notes: lightweight popover listing notification titles only. The
 * full detail + per-feature configuration live in the Notifications editor tab,
 * opened via "View all". Opening the popover applies the user's read trigger.
 */
const NotificationsPanel: FunctionComponent<Props> = ({ controller, open, anchorElement, togglePopover }) => {
  const notifications = controller.notifications

  useEffect(() => {
    if (open) {
      controller.notifyViewOpened('popup')
    } else {
      controller.notifyViewClosed()
    }
  }, [open, controller])

  const openTab = () => {
    controller.openTab()
    togglePopover()
  }

  return (
    <Popover
      title="Notifications"
      open={open}
      anchorElement={anchorElement}
      togglePopover={togglePopover}
      side="right"
      align="start"
      className="w-[18rem] max-w-[90vw]"
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
      <div className="max-h-[50vh] overflow-y-auto">
        {notifications.length === 0 ? (
          <div className="px-3.5 py-8 text-center text-sm text-passive-1">You're all caught up — no notifications.</div>
        ) : (
          notifications.map((notification) => (
            <CompactRow
              key={notification.id}
              notification={notification}
              isRead={controller.isRead(notification.id)}
              onDismiss={controller.dismiss}
            />
          ))
        )}
      </div>
      <button
        className="flex w-full items-center justify-center gap-1.5 border-t border-border px-3.5 py-2.5 text-sm font-semibold text-info hover:bg-contrast"
        onClick={openTab}
      >
        View all notifications
        <Icon type="chevron-right" size="small" />
      </button>
    </Popover>
  )
}

export default observer(NotificationsPanel)
