import { FunctionComponent, useCallback } from 'react'
import { observer } from 'mobx-react-lite'
import { classNames } from '@standardnotes/utils'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import { AppPaneId } from '../Panes/AppPaneMetadata'
import { useWorkflowsStatus } from './useWorkflowsStatus'
import { shouldShowWorkflowsSection } from './workflowsStatus'
import { navigationEntryProjection, useNavigationMini } from '../Tags/navigationMini'

type Props = {
  application: WebApplication
}

const LABEL = 'Workflows'

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

  // Read before the early return below: hooks must run unconditionally.
  const isMini = useNavigationMini()
  const entry = navigationEntryProjection({ mini: isMini, isActive: isOpen, label: LABEL })

  if (!shouldShowWorkflowsSection(signedIn, state)) {
    return null
  }

  return (
    <button className={entry.className} {...entry.labelProps} onClick={handleClick} aria-pressed={isOpen}>
      <Icon type="tune" className={classNames('flex-shrink-0', isOpen ? 'text-info' : 'text-neutral')} />
      {entry.showLabel && <span className={entry.labelClassName}>{LABEL}</span>}
    </button>
  )
}

export default observer(WorkflowsSectionButton)
