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
  /**
   * The pane cannot be shown or hidden right now, whatever its remembered state
   * says — focus mode forces both sidebar columns to zero width, so acting on
   * one there rewrites a persisted layout with no observable effect.
   *
   * Expressed as `aria-disabled` and an inert click rather than the `disabled`
   * attribute: a disabled button leaves the tab order and stops firing the
   * pointer and focus events its tooltip listens for, which would make the
   * REASON for the unavailability the one thing the user cannot reach.
   */
  unavailable?: boolean
  className?: string
}

/**
 * A small desktop-only (md+) icon button used to collapse or expand one of the
 * three layout panes (navigation sidebar or notes list). Rendered as a real
 * <button> with an aria-label and aria-expanded for keyboard accessibility.
 */
const PaneCollapseButton = ({ onClick, label, icon, expanded, unavailable, className }: Props) => {
  return (
    <StyledTooltip label={label}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={expanded}
        aria-disabled={unavailable || undefined}
        onClick={(event) => {
          event.preventDefault()
          if (unavailable) {
            return
          }
          onClick()
        }}
        className={classNames(
          'hidden h-7 w-7 flex-shrink-0 items-center justify-center rounded border border-transparent',
          'text-neutral hover:bg-contrast hover:text-text focus:bg-contrast focus:text-text focus:outline-none md:flex',
          unavailable && 'opacity-50',
          className,
        )}
      >
        <Icon type={icon} size="medium" />
      </button>
    </StyledTooltip>
  )
}

export default observer(PaneCollapseButton)
