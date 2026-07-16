import { classNames, VectorIconNameOrEmoji } from '@standardnotes/snjs'
import Tab from './Tab'
import TabList from './TabList'
import { TabState } from './useTabState'
import Icon from '@/Components/Icon/Icon'

type Props = {
  tabs: {
    id: string
    title: string
    // Optional leading icon rendered before the label. Inherits the tab's text
    // colour so it turns "info" when the tab is active, matching the label.
    icon?: VectorIconNameOrEmoji
  }[]
  state: TabState
  children: React.ReactNode
  className?: string
}

const TabsContainer = ({ tabs, state, className, children }: Props) => {
  return (
    <div className={classNames('border-border overflow-hidden rounded-md border', className)}>
      <TabList state={state} className="border-border border-b">
        {tabs.map(({ id, title, icon }) => (
          <Tab key={id} id={id} className="inline-flex items-center gap-1.5 first:rounded-tl-md">
            {icon && <Icon type={icon} size="medium" />}
            {title}
          </Tab>
        ))}
      </TabList>
      {children}
    </div>
  )
}

export default TabsContainer
