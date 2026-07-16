import Icon from '@/Components/Icon/Icon'
import { classNames } from '@standardnotes/snjs'

export const CheckmarkCircle = ({ className }: { className?: string }) => {
  return (
    <div
      role="presentation"
      className={classNames(
        'peer bg-success text-success-contrast flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full',
        className,
      )}
    >
      <Icon type="check" size="small" />
    </div>
  )
}
