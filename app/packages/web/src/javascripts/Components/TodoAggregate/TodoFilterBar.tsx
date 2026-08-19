import Icon from '@/Components/Icon/Icon'
import {
  activeTodoFilterCount,
  DEFAULT_TODO_FILTERS,
  type TodoFilters,
  type TodoSortKey,
  type TodoTag,
} from './todoFilters'

type Props = {
  filters: TodoFilters
  /** Every tag present on at least one todo's source note. */
  tagOptions: TodoTag[]
  /** Rows the filters currently admit, and rows in total. */
  visibleCount: number
  totalCount: number
  onChange: (next: TodoFilters) => void
}

const SELECT_CLASS =
  'border-border bg-default text-text rounded border px-2 py-1 text-sm focus:border-info focus:outline-none'

const SORT_LABEL: Record<TodoSortKey, string> = {
  due: 'Due date',
  todo: 'Todo',
  note: 'Note',
  status: 'Status',
}

/**
 * Standard Red Notes: the Todos general view's filter bar.
 *
 * Every control writes the whole filter object back through `onChange`, so the
 * owner has exactly one place to persist from. Controls COMPOSE — search, tag,
 * source, due and hide-completed all apply together.
 *
 * The "N filters active" line is deliberately always shown while any filter is
 * on. Filters persist across reloads, so without it a user can return to an
 * empty-looking list with no idea why.
 */
export default function TodoFilterBar({ filters, tagOptions, visibleCount, totalCount, onChange }: Props) {
  const activeCount = activeTodoFilterCount(filters)
  const patch = (changes: Partial<TodoFilters>) => onChange({ ...filters, ...changes })
  const clearAll = () => onChange({ ...DEFAULT_TODO_FILTERS, sortBy: filters.sortBy, sortReverse: filters.sortReverse })

  return (
    <div className="border-border flex flex-col gap-2 border-b px-4 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex min-w-[160px] flex-1 items-center">
          <Icon type="search" size="small" className="text-neutral pointer-events-none absolute left-2" />
          <input
            className="border-border bg-default text-text focus:border-info w-full rounded border px-2 py-1 pl-7 text-sm focus:outline-none"
            value={filters.query}
            onChange={(event) => {
              const query = event.currentTarget.value
              patch({ query })
            }}
            placeholder="Search todos"
            aria-label="Search todos"
          />
        </div>

        <select
          className={SELECT_CLASS}
          aria-label="Filter by folder or tag"
          value={filters.tagUuids[0] ?? ''}
          onChange={(event) => {
            const value = event.currentTarget.value
            patch({ tagUuids: value ? [value] : [] })
          }}
        >
          <option value="">All folders &amp; tags</option>
          {tagOptions.map((tag) => (
            <option key={tag.uuid} value={tag.uuid}>
              {tag.title}
            </option>
          ))}
        </select>

        <select
          className={SELECT_CLASS}
          aria-label="Filter by source"
          value={filters.source}
          onChange={(event) => {
            const source = event.currentTarget.value as TodoFilters['source']
            patch({ source })
          }}
        >
          <option value="all">All sources</option>
          <option value="super">Super checklists</option>
          <option value="advanced-checklist">Advanced Checklist</option>
        </select>

        <select
          className={SELECT_CLASS}
          aria-label="Filter by due date"
          value={filters.due}
          onChange={(event) => {
            const due = event.currentTarget.value as TodoFilters['due']
            patch({ due })
          }}
        >
          <option value="all">Any due date</option>
          <option value="overdue">Overdue</option>
          <option value="due-soon">Due within 24h</option>
          <option value="scheduled">Scheduled</option>
          <option value="unscheduled">No due date</option>
        </select>

        <label className="text-passive-1 flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={filters.hideCompleted}
            onChange={(event) => {
              const hideCompleted = event.currentTarget.checked
              patch({ hideCompleted })
            }}
          />
          Hide completed
        </label>

        <select
          className={SELECT_CLASS}
          aria-label="Sort by"
          value={filters.sortBy}
          onChange={(event) => {
            const sortBy = event.currentTarget.value as TodoSortKey
            patch({ sortBy })
          }}
        >
          {(Object.keys(SORT_LABEL) as TodoSortKey[]).map((key) => (
            <option key={key} value={key}>
              Sort: {SORT_LABEL[key]}
            </option>
          ))}
        </select>

        <button
          type="button"
          className="border-border hover:bg-contrast rounded border px-2 py-1 text-sm"
          aria-label={filters.sortReverse ? 'Sort ascending' : 'Sort descending'}
          title={filters.sortReverse ? 'Descending — click for ascending' : 'Ascending — click for descending'}
          onClick={() => patch({ sortReverse: !filters.sortReverse })}
        >
          <Icon type={filters.sortReverse ? 'arrows-sort-down' : 'arrows-sort-up'} size="small" />
        </button>
      </div>

      {activeCount > 0 && (
        <div className="text-passive-1 flex flex-wrap items-center gap-2 text-xs" role="status">
          <Icon type="tune" size="small" className="text-info flex-shrink-0" />
          <span>
            {activeCount} {activeCount === 1 ? 'filter' : 'filters'} active · showing {visibleCount} of {totalCount}{' '}
            {totalCount === 1 ? 'todo' : 'todos'}
          </span>
          <button type="button" className="text-info rounded px-1 hover:underline" onClick={clearAll}>
            Clear filters
          </button>
        </div>
      )}
    </div>
  )
}
