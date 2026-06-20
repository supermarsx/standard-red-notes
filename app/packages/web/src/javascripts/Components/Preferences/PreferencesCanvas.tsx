import { FunctionComponent } from 'react'
import { observer } from 'mobx-react-lite'
import { PreferencesSessionController } from './Controller/PreferencesSessionController'
import PreferencesMenuView from './PreferencesMenuView'
import PaneSelector from './PaneSelector'
import { PreferencesProps } from './PreferencesProps'
import { FOCUSABLE_BUT_NOT_TABBABLE } from '@/Constants/Constants'
import { classNames } from '@standardnotes/snjs'

type Props = PreferencesProps & {
  menu: PreferencesSessionController
  /**
   * Phone-only flag. When false the single-column menu list is shown; when true
   * the selected pane's content is shown (with a back affordance in the header).
   * Ignored from md up, where both columns are always visible side-by-side.
   */
  mobileShowContent: boolean
  onSelectPane: () => void
}

const PreferencesCanvas: FunctionComponent<Props> = (props) => (
  <div className="flex min-h-0 flex-grow flex-col md:flex-row md:justify-between">
    <div className={classNames('min-h-0 flex-grow md:flex md:flex-grow-0', props.mobileShowContent ? 'hidden' : 'flex')}>
      <PreferencesMenuView menu={props.menu} onSelectPane={props.onSelectPane} />
    </div>
    <div
      className={classNames(
        'min-h-0 flex-grow overflow-auto bg-[--preferences-background-color] md:block',
        props.mobileShowContent ? 'block' : 'hidden',
      )}
      tabIndex={FOCUSABLE_BUT_NOT_TABBABLE}
    >
      <PaneSelector {...props} />
    </div>
  </div>
)

export default observer(PreferencesCanvas)
