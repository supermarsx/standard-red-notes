import { FunctionComponent } from 'react'
import { observer } from 'mobx-react-lite'
import { classNames } from '@standardnotes/utils'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import StyledTooltip from '../StyledTooltip/StyledTooltip'
import { AppPaneId } from '../Panes/AppPaneMetadata'
import { focusAssistantWindowIfOpen } from '@/Assistant/assistantWindow'

type Props = {
  application: WebApplication
}

const AssistantButton: FunctionComponent<Props> = ({ application }) => {
  const isOpen = application.paneController.panes.includes(AppPaneId.Assistant)

  const handleClick = () => {
    // If the assistant is popped out into another window, bring that to the
    // front instead of opening a second copy here.
    if (focusAssistantWindowIfOpen()) {
      return
    }
    application.paneController.presentPane(AppPaneId.Assistant)
  }

  return (
    <StyledTooltip label="Open AI assistant">
      <button
        onClick={handleClick}
        className="flex h-full w-8 cursor-pointer items-center justify-center"
        aria-label="Open AI assistant"
        aria-pressed={isOpen}
      >
        <div className="h-5">
          <Icon type="dashboard" className={classNames(isOpen && 'text-info', 'rounded hover:text-info')} />
        </div>
      </button>
    </StyledTooltip>
  )
}

export default observer(AssistantButton)
