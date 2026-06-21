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
 * Sidebar entry that opens the Home pane. Placed at the very top of the nav so it
 * reads as the landing page. Follows the Dashboard pane pattern exactly: selecting
 * it presents the Home pane as the main content column; selecting it again closes
 * it. Any open Editor pane is popped first so panes don't accumulate.
 */
const HomeSectionButton: FunctionComponent<Props> = ({ application }) => {
  const isOpen = application.paneController.activeViewTab?.paneId === AppPaneId.Home

  const handleClick = useCallback(() => {
    application.paneController.openPaneTab(AppPaneId.Home)
  }, [application])

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
      <Icon type="window" className={classNames('flex-shrink-0', isOpen ? 'text-info' : 'text-neutral')} />
      <span className={classNames('flex-grow truncate font-semibold', isOpen && 'text-info')}>Home</span>
    </button>
  )
}

export default observer(HomeSectionButton)
