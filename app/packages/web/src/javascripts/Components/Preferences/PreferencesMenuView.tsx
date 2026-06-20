import { observer } from 'mobx-react-lite'
import { FunctionComponent, useCallback, useMemo, useState } from 'react'
import PreferencesMenuItem from './PreferencesComponents/MenuItem'
import { PreferencesSessionController } from './Controller/PreferencesSessionController'
import PreferencesSearchBar from './Search/PreferencesSearchBar'
import { searchPreferences, SearchablePane } from './Search/searchPreferences'

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

  const [query, setQuery] = useState('')

  // Ranked search results for the current query (empty array when there is no
  // query, which means "show the full unfiltered menu").
  const searchResults = useMemo(() => {
    if (query.trim().length === 0) {
      return []
    }
    const panes: SearchablePane[] = menuItems.map((item) => ({ id: item.id, label: item.label }))
    return searchPreferences(query, panes)
  }, [query, menuItems])

  const isSearching = query.trim().length > 0

  // The visible items: either the search-ranked subset (keeping the rich
  // SelectableMenuItem so icons/bubbles render) or the full menu.
  const visibleItems = useMemo(() => {
    if (!isSearching) {
      return menuItems.map((item) => ({ item, matchedKeyword: undefined as string | undefined }))
    }
    return searchResults
      .map((result) => {
        const item = menuItems.find((menuItem) => menuItem.id === result.id)
        return item ? { item, matchedKeyword: result.matchedKeyword } : undefined
      })
      .filter((entry): entry is { item: (typeof menuItems)[number]; matchedKeyword: string | undefined } => !!entry)
  }, [isSearching, menuItems, searchResults])

  const openPane = useCallback(
    (id: (typeof menuItems)[number]['id']) => {
      selectPane(id)
      onSelectPane?.()
    },
    [selectPane, onSelectPane],
  )

  // Enter from the search box opens the top-ranked match.
  const openTopMatch = useCallback(() => {
    const top = visibleItems[0]
    if (top) {
      openPane(top.item.id)
    }
  }, [visibleItems, openPane])

  const clearSearch = useCallback(() => setQuery(''), [])

  return (
    <div className="border-border bg-default md:border-0 md:bg-[--preferences-background-color]">
      {/*
        Desktop (>= md): narrow fixed sidebar shown alongside the content column.
        Mobile (< md): full-width tappable menu list; selecting an item tells the
        parent to switch to the content view (single-column flow).
      */}
      <div className="flex min-w-55 flex-col overflow-y-auto px-3 py-3 md:py-6">
        <PreferencesSearchBar
          query={query}
          onQueryChange={setQuery}
          onSubmit={openTopMatch}
          onClear={clearSearch}
        />

        {visibleItems.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-passive-1" role="status">
            No settings found
          </div>
        ) : (
          visibleItems.map(({ item, matchedKeyword }) => (
            <PreferencesMenuItem
              key={item.id}
              iconType={item.icon}
              label={item.label}
              secondaryLabel={isSearching ? matchedKeyword : undefined}
              selected={item.selected}
              bubbleCount={item.bubbleCount}
              hasErrorIndicator={item.hasErrorIndicator}
              onClick={() => openPane(item.id)}
            />
          ))
        )}
      </div>
    </div>
  )
}

export default observer(PreferencesMenuView)
