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
      <Icon type="copy" className={classNames('flex-shrink-0', isOpen ? 'text-info' : 'text-neutral')} />
      <span className={classNames('flex-grow truncate font-semibold', isOpen && 'text-info')}>Templates</span>
    </button>
  )
}

export default observer(TemplatesSectionButton)
