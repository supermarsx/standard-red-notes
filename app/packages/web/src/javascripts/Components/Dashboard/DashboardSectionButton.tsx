import { FunctionComponent, useCallback } from 'react'
import { observer } from 'mobx-react-lite'
import { classNames } from '@standardnotes/utils'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import { AppPaneId } from '../Panes/AppPaneMetadata'

type Props = {
  application: WebApplication
}

/**
 * Sidebar entry that opens the Dashboard pane. Placed near the smart views so it
 * reads as another way to "view" the account. Selecting it presents the Dashboard
 * pane as the main content area; selecting it again closes it.
 */
const DashboardSectionButton: FunctionComponent<Props> = ({ application }) => {
  const isOpen = application.paneController.panes.includes(AppPaneId.Dashboard)

  const handleClick = useCallback(() => {
    const paneController = application.paneController
    if (isOpen) {
      paneController.removePane(AppPaneId.Dashboard)
      return
    }
    // Present the dashboard as the rightmost (main) pane. If an editor is open we
    // pop it first so we don't accumulate panes; the dashboard then takes the
    // flexible main column in its place.
    if (paneController.panes.includes(AppPaneId.Editor)) {
      paneController.removePane(AppPaneId.Editor)
    }
    paneController.presentPane(AppPaneId.Dashboard)
  }, [application, isOpen])

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
      <Icon type="dashboard" className={classNames('flex-shrink-0', isOpen ? 'text-info' : 'text-neutral')} />
      <span className={classNames('flex-grow truncate font-semibold', isOpen && 'text-info')}>Dashboard</span>
    </button>
  )
}

export default observer(DashboardSectionButton)
