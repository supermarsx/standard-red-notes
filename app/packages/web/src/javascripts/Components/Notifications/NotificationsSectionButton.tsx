import { FunctionComponent, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { classNames } from '@standardnotes/utils'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import NotificationsPanel from './NotificationsPanel'
import { navigationEntryProjection, useNavigationMini } from '../Tags/navigationMini'

type Props = {
  application: WebApplication
}

const LABEL = 'Notifications'

const describeCount = (count: number): string => `${count} notification${count === 1 ? '' : 's'}`

/**
 * Standard Red Notes: sidebar entry placed directly below "Home" that opens the
 * centralized notifications panel as a popover anchored to the button. Shows a
 * count bubble when there are active notifications (hidden at 0). A popover is
 * used instead of a full pane because the notification list is lightweight.
 */
const NotificationsSectionButton: FunctionComponent<Props> = ({ application }) => {
  const controller = application.notificationsController
  const count = controller.unreadCount
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)

  const toggle = () => setOpen((value) => !value)

  const isMini = useNavigationMini()
  /**
   * In mini mode the button's own `aria-label` replaces its contents as the
   * accessible name, which would swallow the count bubble's label. So the count
   * is folded into the name instead of being dropped: the rail must not report
   * fewer notifications than the full column does.
   */
  const entry = navigationEntryProjection({
    mini: isMini,
    isActive: open,
    label: LABEL,
    accessibleLabel: count > 0 ? `${LABEL}, ${describeCount(count)}` : undefined,
  })

  return (
    <>
      <button
        ref={buttonRef}
        className={classNames(entry.className, isMini && 'relative')}
        {...entry.labelProps}
        onClick={toggle}
        aria-pressed={open}
      >
        <Icon type="info" className={classNames('flex-shrink-0', open ? 'text-info' : 'text-neutral')} />
        {entry.showLabel && <span className={entry.labelClassName}>{LABEL}</span>}
        {count > 0 && (
          <span
            className={classNames(
              'bg-info text-info-contrast flex items-center justify-center rounded-full font-bold',
              // At rail width there is no room beside the glyph, so the bubble
              // becomes a corner badge over it rather than a sibling of it.
              isMini
                ? 'absolute top-0.5 right-0.5 h-3.5 min-w-[0.875rem] px-1 text-[0.5rem]'
                : 'h-5 min-w-[1.25rem] px-1.5 text-xs',
            )}
            aria-hidden={isMini || undefined}
            aria-label={isMini ? undefined : describeCount(count)}
          >
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>
      <NotificationsPanel controller={controller} open={open} anchorElement={buttonRef} togglePopover={toggle} />
    </>
  )
}

export default observer(NotificationsSectionButton)
