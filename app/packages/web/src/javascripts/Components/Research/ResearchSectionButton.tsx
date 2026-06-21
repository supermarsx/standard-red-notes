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
 * Standard Red Notes: sidebar entry that opens the Research (reference library)
 * pane. Mirrors {@link DashboardSectionButton}: selecting it presents the Research
 * pane as the main content column; selecting it again closes it. Any open Editor
 * pane is popped first so panes don't accumulate.
 */
const ResearchSectionButton: FunctionComponent<Props> = ({ application }) => {
  const activeViewTab = application.paneController.activeViewTab
  const isOpen = activeViewTab?.kind === 'pane' && activeViewTab.paneId === AppPaneId.Research

  const handleClick = useCallback(() => {
    application.paneController.openPaneTab(AppPaneId.Research)
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
      <Icon type="toc" className={classNames('flex-shrink-0', isOpen ? 'text-info' : 'text-neutral')} />
      <span className={classNames('flex-grow truncate font-semibold', isOpen && 'text-info')}>Research</span>
    </button>
  )
}

export default observer(ResearchSectionButton)
