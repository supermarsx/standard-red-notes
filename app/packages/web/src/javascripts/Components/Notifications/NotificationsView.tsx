import { FunctionComponent, ReactNode, useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { classNames } from '@standardnotes/utils'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import Switch from '@/Components/Switch/Switch'
import { AppNotification, NotificationLevel } from '@/Controllers/NotificationsController'
import {
  NotificationReadTrigger,
  READ_AFTER_SECONDS_MAX,
  READ_AFTER_SECONDS_MIN,
  REMINDER_INTERVAL_MAX,
  REMINDER_INTERVAL_MIN,
} from '@/Notifications/notificationsSettings'

type Props = {
  application: WebApplication
  className?: string
  id?: string
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

const READ_TRIGGER_OPTIONS: { value: NotificationReadTrigger; label: string; hint: string }[] = [
  { value: 'popup', label: 'Open popup', hint: 'Marked read when you open the notifications popup or tab.' },
  { value: 'tab', label: 'Open tab', hint: 'Marked read only when you open this full Notifications tab.' },
  { value: 'time', label: 'After a delay', hint: 'Marked read after staying visible for a few seconds.' },
]

const FullNotificationRow: FunctionComponent<{
  notification: AppNotification
  isRead: boolean
  onDismiss: (id: string) => void
}> = ({ notification, isRead, onDismiss }) => (
  <div className="flex gap-3 rounded-md border border-border bg-default p-3.5">
    <Icon type={LEVEL_ICON[notification.level]} className={classNames('mt-0.5 flex-shrink-0', LEVEL_ACCENT[notification.level])} />
    <div className="min-w-0 flex-grow">
      <div className="flex items-center gap-2">
        <span className="text-sm font-bold text-text">{notification.title}</span>
        {!isRead && <span className="h-2 w-2 flex-shrink-0 rounded-full bg-info" aria-label="Unread" />}
      </div>
      <div className="mt-0.5 text-sm text-neutral">{notification.message}</div>
      {notification.action && (
        <button
          className="mt-2 rounded bg-info px-2.5 py-1 text-xs font-semibold text-info-contrast hover:brightness-110"
          onClick={() => notification.action?.run()}
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

const SettingRow: FunctionComponent<{ title: string; description?: string; children: ReactNode }> = ({
  title,
  description,
  children,
}) => (
  <div className="flex items-center justify-between gap-4 py-2.5">
    <div className="min-w-0">
      <div className="text-sm font-semibold text-text">{title}</div>
      {description && <div className="mt-0.5 text-xs text-passive-0">{description}</div>}
    </div>
    <div className="flex-shrink-0">{children}</div>
  </div>
)

/**
 * Standard Red Notes: full-column "Notifications" view surfaced as an editor
 * tab. Lists every active alert with its full message + actions, and exposes the
 * complete (web-local) configuration for the notifications feature. Opening this
 * tab marks alerts read when the user's read trigger is 'tab' (or 'popup'); the
 * 'time' trigger starts a delay while the tab is visible.
 */
const NotificationsView: FunctionComponent<Props> = ({ application, className, id }) => {
  const controller = application.notificationsController
  const { notifications, settings } = controller
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    controller.notifyViewOpened('tab')
    return () => controller.notifyViewClosed()
  }, [controller])

  return (
    <div id={id} className={classNames('flex flex-col overflow-hidden bg-contrast', className)}>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Icon type="info" className="text-info" />
          <span className="text-base font-bold text-text">Notifications</span>
          {controller.unreadCount > 0 && (
            <span className="flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-info px-1.5 text-xs font-bold text-info-contrast">
              {controller.unreadCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {notifications.length > 0 && controller.unreadCount > 0 && (
            <button
              className="rounded px-2 py-1 text-xs font-semibold text-info hover:bg-default"
              onClick={() => controller.markAllRead()}
            >
              Mark all read
            </button>
          )}
          <button
            className={classNames(
              'flex items-center gap-1.5 rounded px-2 py-1 text-xs font-semibold hover:bg-default',
              showSettings ? 'text-info' : 'text-neutral',
            )}
            onClick={() => setShowSettings((value) => !value)}
            aria-pressed={showSettings}
          >
            <Icon type="settings" size="small" />
            Settings
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-grow overflow-y-auto p-4">
        {showSettings && (
          <div className="mb-4 rounded-lg border border-border bg-default p-4">
            <div className="mb-1 text-sm font-bold text-text">Notification settings</div>
            <div className="divide-y divide-border">
              <SettingRow title="Notifications" description="Master switch for the whole notifications feature.">
                <Switch checked={settings.enabled} onChange={(checked) => controller.updateSettings({ enabled: checked })} />
              </SettingRow>

              <div className="py-2.5">
                <div className="text-sm font-semibold text-text">Mark as read</div>
                <div className="mt-0.5 text-xs text-passive-0">
                  {READ_TRIGGER_OPTIONS.find((option) => option.value === settings.readTrigger)?.hint}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {READ_TRIGGER_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      onClick={() => controller.updateSettings({ readTrigger: option.value })}
                      className={classNames(
                        'rounded-full border border-solid px-3 py-1 text-xs font-semibold',
                        settings.readTrigger === option.value
                          ? 'border-info bg-info text-info-contrast'
                          : 'border-border bg-default text-passive-0 hover:text-text',
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                {settings.readTrigger === 'time' && (
                  <label className="mt-2 flex items-center gap-2 text-xs text-neutral">
                    Mark read after
                    <input
                      type="number"
                      min={READ_AFTER_SECONDS_MIN}
                      max={READ_AFTER_SECONDS_MAX}
                      value={settings.readAfterSeconds}
                      onChange={(event) =>
                        controller.updateSettings({ readAfterSeconds: Number(event.target.value) })
                      }
                      className="w-16 rounded border border-border bg-default px-2 py-1 text-center"
                    />
                    seconds visible
                  </label>
                )}
              </div>

              <SettingRow title="Reminder toast" description="Occasionally pop a toast when unread alerts are waiting.">
                <Switch
                  checked={settings.reminderEnabled}
                  onChange={(checked) => controller.updateSettings({ reminderEnabled: checked })}
                />
              </SettingRow>
              {settings.reminderEnabled && (
                <label className="flex items-center gap-2 py-2.5 text-xs text-neutral">
                  Remind every
                  <input
                    type="number"
                    min={REMINDER_INTERVAL_MIN}
                    max={REMINDER_INTERVAL_MAX}
                    value={settings.reminderIntervalMinutes}
                    onChange={(event) =>
                      controller.updateSettings({ reminderIntervalMinutes: Number(event.target.value) })
                    }
                    className="w-20 rounded border border-border bg-default px-2 py-1 text-center"
                  />
                  minutes
                </label>
              )}

              <div className="py-2.5">
                <div className="text-sm font-semibold text-text">Show alerts for</div>
                <div className="mt-1">
                  <SettingRow title="Backup reminders" description="“Data not backed up” when signed out.">
                    <Switch
                      checked={settings.sources.backup}
                      onChange={(checked) => controller.updateSettings({ sources: { backup: checked } })}
                    />
                  </SettingRow>
                  <SettingRow title="Connectivity" description="“You're offline” notices.">
                    <Switch
                      checked={settings.sources.connectivity}
                      onChange={(checked) => controller.updateSettings({ sources: { connectivity: checked } })}
                    />
                  </SettingRow>
                  <SettingRow title="Sync problems" description="Sync failures and rate limiting.">
                    <Switch
                      checked={settings.sources.sync}
                      onChange={(checked) => controller.updateSettings({ sources: { sync: checked } })}
                    />
                  </SettingRow>
                </div>
                <div className="mt-1 text-xs text-passive-1">The critical “Sign in needed” alert always shows.</div>
              </div>
            </div>
          </div>
        )}

        {notifications.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Icon type="check-circle-filled" size="large" className="text-success" />
            <div className="mt-2 text-sm text-passive-1">You're all caught up — no notifications.</div>
          </div>
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-2.5">
            {notifications.map((notification) => (
              <FullNotificationRow
                key={notification.id}
                notification={notification}
                isRead={controller.isRead(notification.id)}
                onDismiss={controller.dismiss}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default observer(NotificationsView)
