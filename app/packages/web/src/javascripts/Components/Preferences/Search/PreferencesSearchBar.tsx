import { FunctionComponent, KeyboardEventHandler, useCallback, useRef } from 'react'
import Icon from '@/Components/Icon/Icon'
import DecoratedInput from '@/Components/Input/DecoratedInput'

type Props = {
  query: string
  onQueryChange: (query: string) => void
  /** Invoked when the user presses Enter; should open the current top match. */
  onSubmit: () => void
  /** Invoked when the user presses Escape; clears the query. */
  onClear: () => void
}

/**
 * Search input that sits at the top of the Preferences menu (left sidebar on
 * desktop, top of the single-column list on mobile). Keeps no state of its own —
 * the menu view owns the query so it can drive the filtered list.
 */
const PreferencesSearchBar: FunctionComponent<Props> = ({ query, onQueryChange, onSubmit, onClear }) => {
  const inputRef = useRef<HTMLInputElement>(null)

  const handleKeyDown: KeyboardEventHandler = useCallback(
    (event) => {
      if (event.key === 'Escape') {
        if (query.length > 0) {
          // Swallow the Escape so it clears the query rather than closing the
          // whole preferences modal on the first press.
          event.preventDefault()
          event.stopPropagation()
          onClear()
        }
      }
    },
    [query.length, onClear],
  )

  return (
    <div className="px-1 pb-3">
      <DecoratedInput
        ref={inputRef}
        value={query}
        placeholder="Search settings"
        type="text"
        autocomplete={false}
        spellcheck={false}
        onChange={onQueryChange}
        onEnter={onSubmit}
        onKeyDown={handleKeyDown}
        left={[<Icon key="search-icon" type="search" className="text-passive-1" />]}
        right={
          query.length > 0
            ? [
                <button
                  key="clear-search"
                  type="button"
                  aria-label="Clear search"
                  className="flex cursor-pointer items-center border-0 bg-transparent p-0 text-neutral hover:text-info"
                  onClick={() => {
                    onClear()
                    inputRef.current?.focus()
                  }}
                >
                  <Icon type="clear-circle-filled" />
                </button>,
              ]
            : undefined
        }
      />
    </div>
  )
}

export default PreferencesSearchBar
