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

const LABEL = 'Templates'

/**
 * Standard Red Notes: sidebar entry that opens the Templates pane as a tab in the
 * editor tab bar. Mirrors {@link BookmarksSectionButton}: selecting it opens (or
 * re-focuses) the Templates view tab.
 */
const TemplatesSectionButton: FunctionComponent<Props> = ({ application }) => {
  const activeViewTab = application.paneController.activeViewTab
  const isOpen = activeViewTab?.kind === 'pane' && activeViewTab.paneId === AppPaneId.Templates

  const handleClick = useCallback(() => {
    application.paneController.openPaneTab(AppPaneId.Templates)
  }, [application])

  const isMini = useNavigationMini()
  const entry = navigationEntryProjection({ mini: isMini, isActive: isOpen, label: LABEL })

  return (
    <button className={entry.className} {...entry.labelProps} onClick={handleClick} aria-pressed={isOpen}>
      <Icon type="copy" className={classNames('flex-shrink-0', isOpen ? 'text-info' : 'text-neutral')} />
      {entry.showLabel && <span className={entry.labelClassName}>{LABEL}</span>}
    </button>
  )
}

export default observer(TemplatesSectionButton)
