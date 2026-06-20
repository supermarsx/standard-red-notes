import { observer } from 'mobx-react-lite'
import { FunctionComponent } from 'react'
import PreferencesMenuItem from './PreferencesComponents/MenuItem'
import { PreferencesSessionController } from './Controller/PreferencesSessionController'

type Props = {
  menu: PreferencesSessionController
  /**
   * Invoked after a menu item is selected. On phone widths the parent uses this
   * to slide from the single-column menu list to the selected pane's content.
   */
  onSelectPane?: () => void
}

const PreferencesMenuView: FunctionComponent<Props> = ({ menu, onSelectPane }) => {
  const { selectPane, menuItems } = menu

  return (
    <div className="border-border bg-default md:border-0 md:bg-[--preferences-background-color]">
      {/*
        Desktop (>= md): narrow fixed sidebar shown alongside the content column.
        Mobile (< md): full-width tappable menu list; selecting an item tells the
        parent to switch to the content view (single-column flow).
      */}
      <div className="flex min-w-55 flex-col overflow-y-auto px-3 py-3 md:py-6">
        {menuItems.map((pref) => (
          <PreferencesMenuItem
            key={pref.id}
            iconType={pref.icon}
            label={pref.label}
            selected={pref.selected}
            bubbleCount={pref.bubbleCount}
            hasErrorIndicator={pref.hasErrorIndicator}
            onClick={() => {
              selectPane(pref.id)
              onSelectPane?.()
            }}
          />
        ))}
      </div>
    </div>
  )
}

export default observer(PreferencesMenuView)
