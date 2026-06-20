import { IconType } from '@standardnotes/snjs'
import { classNames } from '@standardnotes/utils'
import { observer } from 'mobx-react-lite'
import Icon from '../Icon/Icon'
import StyledTooltip from '../StyledTooltip/StyledTooltip'

type Props = {
  onClick: () => void
  label: string
  icon: IconType
  /**
   * Whether the pane this button controls is currently expanded (shown). Used for
   * the `aria-expanded` attribute so assistive technology announces the state.
   */
  expanded: boolean
  className?: string
}

/**
 * A small desktop-only (md+) icon button used to collapse or expand one of the
 * three layout panes (navigation sidebar or notes list). Rendered as a real
 * <button> with an aria-label and aria-expanded for keyboard accessibility.
 */
const PaneCollapseButton = ({ onClick, label, icon, expanded, className }: Props) => {
  return (
    <StyledTooltip label={label}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={expanded}
        onClick={(event) => {
          event.preventDefault()
          onClick()
        }}
        className={classNames(
          'hidden h-7 w-7 flex-shrink-0 items-center justify-center rounded border border-transparent',
          'text-neutral hover:bg-contrast hover:text-text focus:bg-contrast focus:text-text focus:outline-none md:flex',
          className,
        )}
      >
        <Icon type={icon} size="medium" />
      </button>
    </StyledTooltip>
  )
}

export default observer(PaneCollapseButton)
