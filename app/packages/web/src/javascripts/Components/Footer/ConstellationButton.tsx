import { FunctionComponent } from 'react'
import { observer } from 'mobx-react-lite'
import { classNames } from '@standardnotes/utils'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import StyledTooltip from '../StyledTooltip/StyledTooltip'
import { AppPaneId } from '../Panes/AppPaneMetadata'
import { focusConstellationWindowIfOpen } from '../Constellation/constellationWindow'

type Props = {
  application: WebApplication
}

const ConstellationButton: FunctionComponent<Props> = ({ application }) => {
  const isOpen = application.paneController.panes.includes(AppPaneId.Constellation)

  const handleClick = () => {
    // If the constellation is popped out into another window, refocus it.
    if (focusConstellationWindowIfOpen()) {
      return
    }
    if (isOpen) {
      application.paneController.removePane(AppPaneId.Constellation)
    } else {
      application.paneController.presentPane(AppPaneId.Constellation)
    }
  }

  return (
    <StyledTooltip label="Open constellation graph">
      <button
        onClick={handleClick}
        className="flex h-full w-8 cursor-pointer items-center justify-center"
        aria-label="Open constellation graph"
        aria-pressed={isOpen}
      >
        <div className="h-5">
          <Icon type="star-filled" className={classNames(isOpen && 'text-info', 'rounded hover:text-info')} />
        </div>
      </button>
    </StyledTooltip>
  )
}

export default observer(ConstellationButton)
