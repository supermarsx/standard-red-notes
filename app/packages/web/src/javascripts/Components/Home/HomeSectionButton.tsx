import { FunctionComponent, useCallback } from 'react'
import { observer } from 'mobx-react-lite'
import { classNames } from '@standardnotes/utils'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import { AppPaneId } from '../Panes/AppPaneMetadata'
import { navigationEntryProjection, useNavigationMini } from '../Tags/navigationMini'

type Props = {
  application: WebApplication
}

const LABEL = 'Home'

/**
 * Sidebar entry that opens the Home pane. Placed at the very top of the nav so it
 * reads as the landing page. Follows the Dashboard pane pattern exactly: selecting
 * it presents the Home pane as the main content column; selecting it again closes
 * it. Any open Editor pane is popped first so panes don't accumulate.
 */
const HomeSectionButton: FunctionComponent<Props> = ({ application }) => {
  const activeViewTab = application.paneController.activeViewTab
  const isOpen = activeViewTab?.kind === 'pane' && activeViewTab.paneId === AppPaneId.Home

  const handleClick = useCallback(() => {
    application.paneController.openPaneTab(AppPaneId.Home)
  }, [application])

  const isMini = useNavigationMini()
  const entry = navigationEntryProjection({ mini: isMini, isActive: isOpen, label: LABEL })

  return (
    <button className={entry.className} {...entry.labelProps} onClick={handleClick} aria-pressed={isOpen}>
      <Icon type="window" className={classNames('flex-shrink-0', isOpen ? 'text-info' : 'text-neutral')} />
      {entry.showLabel && <span className={entry.labelClassName}>{LABEL}</span>}
    </button>
  )
}

export default observer(HomeSectionButton)
