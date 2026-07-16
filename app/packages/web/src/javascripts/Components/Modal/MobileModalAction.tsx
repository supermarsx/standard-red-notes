import { classNames } from '@standardnotes/snjs'
import { ComponentPropsWithoutRef, ForwardedRef, forwardRef, ReactNode } from 'react'

type Props = {
  children: ReactNode
  action: () => void
  slot: 'left' | 'right'
  type?: 'primary' | 'secondary' | 'destructive' | 'cancel'
} & Omit<ComponentPropsWithoutRef<'button'>, 'onClick' | 'type'>

const MobileModalAction = forwardRef(
  ({ children, action, type = 'primary', slot, className, ...props }: Props, ref: ForwardedRef<HTMLButtonElement>) => {
    return (
      <button
        ref={ref}
        className={classNames(
          'disabled:text-neutral flex px-1 py-1 font-semibold whitespace-nowrap select-none focus:shadow-none focus:outline-none active:shadow-none active:brightness-50 active:outline-none md:hidden',
          slot === 'left' ? 'justify-start text-left' : 'justify-end text-right',
          type === 'cancel' || type === 'destructive' ? 'text-danger' : 'text-info',
          className,
        )}
        onClick={action}
        {...props}
      >
        {children}
      </button>
    )
  },
)

export default MobileModalAction
