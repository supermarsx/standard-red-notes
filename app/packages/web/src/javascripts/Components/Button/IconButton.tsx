import { ComponentPropsWithoutRef, ForwardedRef, forwardRef, MouseEventHandler } from 'react'
import Icon from '@/Components/Icon/Icon'
import { IconType } from '@standardnotes/snjs'

interface Props extends ComponentPropsWithoutRef<'button'> {
  onClick: MouseEventHandler<HTMLButtonElement>
  className?: string
  icon: IconType
  iconClassName?: string
  title: string
  focusable: boolean
  disabled?: boolean
  disabledReason?: string
}

const IconButton = forwardRef(
  (
    {
      onClick,
      className = '',
      icon,
      title,
      focusable,
      iconClassName = '',
      disabled = false,
      disabledReason,
      ...rest
    }: Props,
    ref: ForwardedRef<HTMLButtonElement>,
  ) => {
    // A native `disabled` button swallows hover, so its `title` tooltip never
    // shows. When a reason is given, use `aria-disabled` + `title` instead so the
    // button stays hoverable, and no-op the click.
    const showReason = disabled && !!disabledReason
    const click: MouseEventHandler<HTMLButtonElement> = (e) => {
      e.preventDefault()
      if (showReason) {
        return
      }
      onClick(e)
    }
    const focusableClass = focusable ? '' : 'focus:shadow-none'
    return (
      <button
        {...rest}
        type="button"
        title={showReason ? disabledReason : title}
        className={`no-border flex cursor-pointer flex-row items-center bg-transparent ${focusableClass} ${className}`}
        onClick={click}
        disabled={disabled && !showReason}
        aria-disabled={showReason || undefined}
        aria-label={title}
        ref={ref}
      >
        <Icon type={icon} className={iconClassName} />
      </button>
    )
  },
)

export default IconButton
