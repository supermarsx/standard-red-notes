import { classNames } from '@standardnotes/utils'
import { ComponentPropsWithoutRef } from 'react'
import { useTabStateContext } from './useTabState'

type Props = { id: string } & ComponentPropsWithoutRef<'button'>

const Tab = ({ id, className, children, ...props }: Props) => {
  const { state } = useTabStateContext()
  const { activeTab, setActiveTab } = state

  const isActive = activeTab === id

  return (
    <button
      role="tab"
      id={`tab-control-${id}`}
      onClick={() => {
        setActiveTab(id)
      }}
      aria-selected={isActive}
      aria-controls={`tab-panel-${id}`}
      className={classNames(
        'bg-default md:translucent-ui:bg-transparent relative cursor-pointer border-0 px-3 py-2.5 text-sm focus:shadow-inner',
        isActive ? 'text-info font-medium' : 'text-text',
        isActive && 'after:bg-info after:absolute after:bottom-0 after:left-0 after:h-[2px] after:w-full',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}

export default Tab
