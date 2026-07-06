import { FunctionComponent, ReactNode } from 'react'
import { VectorIconNameOrEmoji } from '@standardnotes/snjs'

import TabList from '@/Components/Tabs/TabList'
import Tab from '@/Components/Tabs/Tab'
import { TabState } from '@/Components/Tabs/useTabState'
import Icon from '@/Components/Icon/Icon'

export type PreferencesSubtab = {
  id: string
  title: string
  icon: VectorIconNameOrEmoji
  content: ReactNode
  /** When true the subtab is omitted entirely (e.g. account-only sections while signed out). */
  hidden?: boolean
}

/**
 * Pure: resolve which subtab should actually be shown, given the currently selected
 * id and the (possibly conditional) tab set. Returns the selected id when it maps to
 * a visible tab, otherwise falls back to the first visible tab so a pane never renders
 * blank — e.g. a user whose active subtab disappeared after signing out. Returns
 * undefined only when there are no visible tabs at all.
 */
export const resolveActiveSubtabId = (tabs: PreferencesSubtab[], activeTab: string): string | undefined => {
  const visible = tabs.filter((tab) => !tab.hidden)
  if (visible.some((tab) => tab.id === activeTab)) {
    return activeTab
  }
  return visible[0]?.id
}

/**
 * A 2nd-level sub-tab bar for user Preferences panes, styled to match the Admin pane's
 * subtabs. The sticky bar is built from the raw TabList/Tab primitives (not
 * TabsContainer, whose overflow-hidden wrapper would trap `position: sticky`) so it
 * pins to the top of the PreferencesPane scroll column as the tab content scrolls
 * under it. Only the active subtab's content is mounted, so each pane's sections keep
 * their existing behavior while the long stacked list becomes a tidy set of tabs.
 */
const PreferencesSubtabs: FunctionComponent<{ state: TabState; tabs: PreferencesSubtab[] }> = ({ state, tabs }) => {
  const visibleTabs = tabs.filter((tab) => !tab.hidden)
  const activeId = resolveActiveSubtabId(tabs, state.activeTab)
  const active = visibleTabs.find((tab) => tab.id === activeId)

  return (
    <>
      <div className="sticky top-0 z-20 mb-4 overflow-x-auto rounded-md border border-border bg-default shadow-sm">
        <TabList state={state} className="flex min-w-max">
          {visibleTabs.map(({ id, title, icon }) => (
            <Tab key={id} id={id} className="inline-flex items-center gap-1.5 whitespace-nowrap first:rounded-tl-md">
              <Icon type={icon} size="medium" />
              {title}
            </Tab>
          ))}
        </TabList>
      </div>

      {active && (
        <div role="tabpanel" id={`tab-panel-${active.id}`} aria-labelledby={`tab-control-${active.id}`}>
          {active.content}
        </div>
      )}
    </>
  )
}

export default PreferencesSubtabs
