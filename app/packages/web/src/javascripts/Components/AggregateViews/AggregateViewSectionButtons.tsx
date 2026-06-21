import { FunctionComponent, useCallback } from 'react'
import { observer } from 'mobx-react-lite'
import { classNames } from '@standardnotes/utils'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import { VectorIconNameOrEmoji } from '@standardnotes/snjs'
import { AppPaneId } from '../Panes/AppPaneMetadata'

/**
 * Standard Red Notes: sidebar entries for the three aggregate VIEWS (Reminders,
 * Calendar, Todos). Each is a pane reachable from the sidebar, following the
 * Dashboard pane pattern: selecting it presents the view as the main content
 * column; selecting it again closes it. Any open Editor pane is popped first so
 * panes don't accumulate, exactly like {@link DashboardSectionButton}.
 */

type SingleButtonProps = {
  application: WebApplication
  paneId: AppPaneId
  icon: VectorIconNameOrEmoji
  label: string
  /**
   * Standard Red Notes: when true the view opens as a TAB in the editor tab bar
   * (Reminders, Todos) instead of taking over the window as a column (Calendar).
   */
  asTab?: boolean
}

const AggregateViewSectionButton: FunctionComponent<SingleButtonProps> = observer(
  ({ application, paneId, icon, label, asTab }) => {
    const isOpen = asTab
      ? application.paneController.activeViewTab?.paneId === paneId
      : application.paneController.panes.includes(paneId)

    const handleClick = useCallback(() => {
      const paneController = application.paneController
      if (asTab) {
        paneController.openPaneTab(paneId)
        return
      }
      if (isOpen) {
        paneController.removePane(paneId)
        return
      }
      if (paneController.panes.includes(AppPaneId.Editor)) {
        paneController.removePane(AppPaneId.Editor)
      }
      paneController.presentPane(paneId)
    }, [application, isOpen, paneId, asTab])

    return (
      <button
        className={classNames(
          'flex w-full items-center gap-3 px-3.5 py-2 text-left text-base lg:text-sm',
          'hover:bg-contrast focus:bg-contrast focus:shadow-none focus:outline-none',
          isOpen && 'bg-contrast',
        )}
        onClick={handleClick}
        aria-pressed={isOpen}
      >
        <Icon type={icon} className={classNames('flex-shrink-0', isOpen ? 'text-info' : 'text-neutral')} />
        <span className={classNames('flex-grow truncate font-semibold', isOpen && 'text-info')}>{label}</span>
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
        asTab
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
        asTab
      />
    </>
  )
}

export default observer(AggregateViewSectionButtons)
