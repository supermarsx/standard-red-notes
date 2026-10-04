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

const LABEL = 'Bookmarks'

/**
 * Standard Red Notes: sidebar entry that opens the Bookmarks (note markers) pane.
 * Mirrors {@link ResearchSectionButton}/DashboardSectionButton: selecting it
 * presents the Bookmarks pane as the main content column; selecting it again
 * closes it. Any open Editor pane is popped first so panes don't accumulate.
 */
const BookmarksSectionButton: FunctionComponent<Props> = ({ application }) => {
  const activeViewTab = application.paneController.activeViewTab
  const isOpen = activeViewTab?.kind === 'pane' && activeViewTab.paneId === AppPaneId.Bookmarks

  const handleClick = useCallback(() => {
    application.paneController.openPaneTab(AppPaneId.Bookmarks)
  }, [application])

  const isMini = useNavigationMini()
  const entry = navigationEntryProjection({ mini: isMini, isActive: isOpen, label: LABEL })

  return (
    <button className={entry.className} {...entry.labelProps} onClick={handleClick} aria-pressed={isOpen}>
      <Icon type="pin" className={classNames('flex-shrink-0', isOpen ? 'text-info' : 'text-neutral')} />
      {entry.showLabel && <span className={entry.labelClassName}>{LABEL}</span>}
    </button>
  )
}

export default observer(BookmarksSectionButton)
