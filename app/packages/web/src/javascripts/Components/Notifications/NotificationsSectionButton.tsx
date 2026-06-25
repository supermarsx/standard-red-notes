import { FunctionComponent, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { classNames } from '@standardnotes/utils'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import NotificationsPanel from './NotificationsPanel'

type Props = {
  application: WebApplication
}

/**
 * Standard Red Notes: sidebar entry placed directly below "Home" that opens the
 * centralized notifications panel as a popover anchored to the button. Shows a
 * count bubble when there are active notifications (hidden at 0). A popover is
 * used instead of a full pane because the notification list is lightweight.
 */
const NotificationsSectionButton: FunctionComponent<Props> = ({ application }) => {
  const controller = application.notificationsController
  const count = controller.count
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)

  const toggle = () => setOpen((value) => !value)

  return (
    <>
      <button
        ref={buttonRef}
        className={classNames(
          'flex w-full items-center gap-3 px-3.5 py-2 text-left text-base lg:text-sm',
          'hover:bg-contrast focus:bg-contrast focus:shadow-none focus:outline-none',
          open && 'bg-contrast',
        )}
        onClick={toggle}
        aria-pressed={open}
      >
        <Icon type="info" className={classNames('flex-shrink-0', open ? 'text-info' : 'text-neutral')} />
        <span className={classNames('flex-grow truncate font-semibold', open && 'text-info')}>Notifications</span>
        {count > 0 && (
          <span
            className="flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-info px-1.5 text-xs font-bold text-info-contrast"
            aria-label={`${count} notification${count === 1 ? '' : 's'}`}
          >
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>
      <NotificationsPanel
        controller={controller}
        open={open}
        anchorElement={buttonRef}
        togglePopover={toggle}
      />
    </>
  )
}

export default observer(NotificationsSectionButton)
