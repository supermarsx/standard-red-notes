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

const LABEL = 'Dashboard'

/**
 * Sidebar entry that opens the Dashboard pane. Placed near the smart views so it
 * reads as another way to "view" the account. Selecting it presents the Dashboard
 * pane as the main content area; selecting it again closes it.
 */
const DashboardSectionButton: FunctionComponent<Props> = ({ application }) => {
  const activeViewTab = application.paneController.activeViewTab
  const isOpen = activeViewTab?.kind === 'pane' && activeViewTab.paneId === AppPaneId.Dashboard

  const handleClick = useCallback(() => {
    application.paneController.openPaneTab(AppPaneId.Dashboard)
  }, [application])

  const isMini = useNavigationMini()
  const entry = navigationEntryProjection({ mini: isMini, isActive: isOpen, label: LABEL })

  return (
    <button className={entry.className} {...entry.labelProps} onClick={handleClick} aria-pressed={isOpen}>
      <Icon type="dashboard" className={classNames('flex-shrink-0', isOpen ? 'text-info' : 'text-neutral')} />
      {entry.showLabel && <span className={entry.labelClassName}>{LABEL}</span>}
    </button>
  )
}

export default observer(DashboardSectionButton)
