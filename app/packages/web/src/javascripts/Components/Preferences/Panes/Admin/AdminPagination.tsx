import { FunctionComponent, ReactNode } from 'react'
import { classNames } from '@standardnotes/utils'

import Button from '@/Components/Button/Button'
import Icon from '@/Components/Icon/Icon'
import StyledTooltip from '@/Components/StyledTooltip/StyledTooltip'

type Props = {
  onPrevious: () => void
  onNext: () => void
  previousDisabled: boolean
  nextDisabled: boolean
  // Optional label rendered between the two chevrons (e.g. "Page 1 of 3").
  children?: ReactNode
  // Accessible/tooltip labels; overridable for lists that page over time
  // (e.g. the audit log's newer/older direction).
  previousLabel?: string
  nextLabel?: string
  className?: string
}

/**
 * Shared admin pagination control: themed chevron icon buttons with tooltips,
 * disabled appropriately at the ends. An optional label (the "Page X of Y"
 * text) sits between the chevrons. Used by the Users list and the Audit log so
 * both page identically.
 */
const AdminPagination: FunctionComponent<Props> = ({
  onPrevious,
  onNext,
  previousDisabled,
  nextDisabled,
  children,
  previousLabel = 'Previous page',
  nextLabel = 'Next page',
  className,
}) => (
  <div className={classNames('flex items-center gap-2', className)}>
    <StyledTooltip label={previousLabel}>
      <Button
        small
        className="!px-2"
        disabled={previousDisabled}
        onClick={onPrevious}
        aria-label={previousLabel}
      >
        <Icon type="chevron-left" size="medium" />
      </Button>
    </StyledTooltip>
    {children}
    <StyledTooltip label={nextLabel}>
      <Button small className="!px-2" disabled={nextDisabled} onClick={onNext} aria-label={nextLabel}>
        <Icon type="chevron-right" size="medium" />
      </Button>
    </StyledTooltip>
  </div>
)

export default AdminPagination
