import { FunctionComponent, useCallback } from 'react'
import { observer } from 'mobx-react-lite'
import { classNames } from '@standardnotes/utils'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import { AppPaneId } from '../Panes/AppPaneMetadata'
import { useWorkflowsStatus } from './useWorkflowsStatus'
import { shouldShowWorkflowsSection } from './workflowsStatus'

type Props = {
  application: WebApplication
}

/**
 * Standard Red Notes: sidebar entry that opens the Workflows pane as a tab in
 * the editor tab bar (mirrors FilesSectionButton). Rendered ONLY when the user
 * is signed into a server AND GET /v1/workflows/status reports the feature
 * enabled for this account — hidden entirely while loading, when signed out,
 * when the endpoint 404s (server without workflows), or when enabled=false.
 */
const WorkflowsSectionButton: FunctionComponent<Props> = ({ application }) => {
  const { state, signedIn } = useWorkflowsStatus(application)

  const activeViewTab = application.paneController.activeViewTab
  const isOpen = activeViewTab?.kind === 'pane' && activeViewTab.paneId === AppPaneId.Workflows

  const handleClick = useCallback(() => {
    application.paneController.openPaneTab(AppPaneId.Workflows)
  }, [application])

  if (!shouldShowWorkflowsSection(signedIn, state)) {
    return null
  }

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
      <Icon type="tune" className={classNames('flex-shrink-0', isOpen ? 'text-info' : 'text-neutral')} />
      <span className={classNames('flex-grow truncate font-semibold', isOpen && 'text-info')}>Workflows</span>
    </button>
  )
}

export default observer(WorkflowsSectionButton)
