/**
 * Pure, presentational grid for the Insert -> Symbol picker. No Lexical, no
 * hooks, no i18n — every string arrives via `labels` and every action via a
 * callback, so the DOM is testable provider-free (the mandatory render-path
 * guard for this repo's "renders green but silently vanished" failure mode).
 *
 * The parent (SymbolPickerDialog) owns query + recents state and passes down the
 * ALREADY-filtered `categories`; this component only renders and reports intent.
 */
import { ChangeEvent } from 'react'
import type { SymbolCategory } from './symbolCatalog'

export type SymbolPickerLabels = {
  /** aria-label / placeholder for the search box. */
  search: string
  /** Caption for the "recently used" row. */
  recents: string
  /** Shown when a query matches nothing. */
  noResults: string
}

export type SymbolPickerGridProps = {
  query: string
  onQueryChange: (query: string) => void
  /** Already-filtered categories to render (empty => show the no-results message). */
  categories: SymbolCategory[]
  /** Recently-used chars; shown as a leading row only when there is no active query. */
  recents: string[]
  /** Called with the char when a symbol button is activated. */
  onInsert: (char: string) => void
  labels: SymbolPickerLabels
}

const SymbolButton = ({ char, name, onInsert }: { char: string; name: string; onInsert: (char: string) => void }) => (
  <button
    type="button"
    aria-label={name}
    title={name}
    data-symbol={char}
    onClick={() => onInsert(char)}
    className="hover:bg-contrast focus-visible:bg-contrast flex h-9 w-9 items-center justify-center rounded text-lg leading-none"
  >
    {char}
  </button>
)

const CategoryCaption = ({ children }: { children: string }) => (
  <div className="text-passive-1 mt-3 mb-1 text-[10px] tracking-wide uppercase first:mt-0">{children}</div>
)

export default function SymbolPickerGrid({
  query,
  onQueryChange,
  categories,
  recents,
  onInsert,
  labels,
}: SymbolPickerGridProps) {
  const focusOnMount = (element: HTMLInputElement | null) => {
    if (element) {
      setTimeout(() => element.focus())
    }
  }

  const showRecents = recents.length > 0 && query.trim().length === 0
  const hasResults = categories.some((category) => category.symbols.length > 0)

  return (
    <div className="w-[min(90vw,32rem)]">
      <input
        type="search"
        value={query}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onQueryChange(event.target.value)}
        aria-label={labels.search}
        placeholder={labels.search}
        ref={focusOnMount}
        className="border-border bg-default focus-visible:border-info mb-2 w-full rounded border px-3 py-1.5 text-base"
      />

      <div className="max-h-[50vh] overflow-y-auto">
        {showRecents && (
          <div data-testid="symbol-recents">
            <CategoryCaption>{labels.recents}</CategoryCaption>
            <div className="flex flex-wrap gap-1">
              {recents.map((char) => (
                <SymbolButton key={`recent-${char}`} char={char} name={char} onInsert={onInsert} />
              ))}
            </div>
          </div>
        )}

        {hasResults ? (
          categories.map((category) => (
            <div key={category.name} data-testid={`symbol-category-${category.name}`}>
              <CategoryCaption>{category.name}</CategoryCaption>
              <div className="grid grid-cols-8 gap-1">
                {category.symbols.map((symbol) => (
                  <SymbolButton
                    key={`${category.name}-${symbol.char}`}
                    char={symbol.char}
                    name={symbol.name}
                    onInsert={onInsert}
                  />
                ))}
              </div>
            </div>
          ))
        ) : (
          <div className="text-passive-1 py-6 text-center">{labels.noResults}</div>
        )}
      </div>
    </div>
  )
}
