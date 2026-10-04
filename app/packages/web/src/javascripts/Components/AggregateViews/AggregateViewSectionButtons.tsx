import { FunctionComponent, useCallback } from 'react'
import { observer } from 'mobx-react-lite'
import { classNames } from '@standardnotes/utils'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import { VectorIconNameOrEmoji } from '@standardnotes/snjs'
import { AppPaneId } from '../Panes/AppPaneMetadata'
import { navigationEntryProjection, useNavigationMini } from '../Tags/navigationMini'

/**
 * Standard Red Notes: first-class sidebar entries for the three aggregate apps
 * (Reminders, Calendar, Todos). All three open in the normal editor tab strip,
 * preserving the same responsive/mobile routing as note tabs.
 */

type SingleButtonProps = {
  application: WebApplication
  paneId: AppPaneId
  icon: VectorIconNameOrEmoji
  label: string
}

const AggregateViewSectionButton: FunctionComponent<SingleButtonProps> = observer(
  ({ application, paneId, icon, label }) => {
    const activeViewTab = application.paneController.activeViewTab
    const isOpen = activeViewTab?.kind === 'pane' && activeViewTab.paneId === paneId

    const handleClick = useCallback(() => {
      application.paneController.openPaneTab(paneId)
    }, [application, paneId])

    const isMini = useNavigationMini()
    const entry = navigationEntryProjection({ mini: isMini, isActive: isOpen, label })

    return (
      <button className={entry.className} {...entry.labelProps} onClick={handleClick} aria-pressed={isOpen}>
        <Icon type={icon} className={classNames('flex-shrink-0', isOpen ? 'text-info' : 'text-neutral')} />
        {entry.showLabel && <span className={entry.labelClassName}>{label}</span>}
      </button>
    )
  },
)

type Props = {
  application: WebApplication
  remindersLabel: string
  calendarLabel: string
  todosLabel: string
}

const AggregateViewSectionButtons: FunctionComponent<Props> = ({
  application,
  remindersLabel,
  calendarLabel,
  todosLabel,
}) => {
  return (
    <>
      <AggregateViewSectionButton
        application={application}
        paneId={AppPaneId.Reminders}
        icon="clock"
        label={remindersLabel}
      />
      <AggregateViewSectionButton
        application={application}
        paneId={AppPaneId.Calendar}
        icon="history"
        label={calendarLabel}
      />
      <AggregateViewSectionButton
        application={application}
        paneId={AppPaneId.Todos}
        icon="list-check"
        label={todosLabel}
      />
    </>
  )
}

export default observer(AggregateViewSectionButtons)
