import { classNames } from '@standardnotes/snjs'
import { ReactNode } from 'react'

const MenuSection = ({
  title,
  className,
  children,
}: {
  title?: ReactNode
  className?: string
  children: ReactNode
}) => {
  return (
    <div
      className={classNames(
        'md:border-border md:translucent-ui:border-[--popover-border-color] my-4 md:my-2 md:border-b md:pb-2 md:last:mb-0 md:last:border-b-0 md:last:pb-0 md:first:last:mt-0',
        className,
      )}
    >
      {title && <div className="text-text px-3 py-1 text-sm font-semibold uppercase lg:text-xs">{title}</div>}
      <div className="divide-passive-3 bg-default divide-y overflow-hidden rounded-md md:divide-none md:rounded-none md:bg-transparent">
        {children}
      </div>
    </div>
  )
}

export default MenuSection
