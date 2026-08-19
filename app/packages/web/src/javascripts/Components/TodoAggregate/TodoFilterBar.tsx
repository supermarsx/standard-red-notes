import { useRef, useState } from 'react'
import Icon from '@/Components/Icon/Icon'
import Popover from '../Popover/Popover'
import {
  activeTodoFilterCount,
  DEFAULT_TODO_FILTERS,
  todoTagLabel,
  type TodoFilters,
  type TodoSortKey,
  type TodoTag,
} from './todoFilters'

type Props = {
  filters: TodoFilters
  /** Every tag present on at least one todo's source note. */
  tagOptions: TodoTag[]
  /**
   * Every Advanced Checklist section name present in the current data. Usually
   * empty — see {@link TodoFilterBar} for what the bar does then.
   */
  groupOptions: string[]
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

type MultiSelectOption = { value: string; label: string }

type MultiSelectProps = {
  /** Accessible name of the trigger, and the key tests and users identify it by. */
  ariaLabel: string
  /** Heading of the panel; also what the trigger reads when nothing is selected. */
  title: string
  emptyLabel: string
  unit: { one: string; many: string }
  options: MultiSelectOption[]
  selected: string[]
  /** Marks the panel for targeting; two of these can be open in one bar. */
  kind: string
  onChange: (next: string[]) => void
}

/**
 * A checkbox list behind a trigger button — the control multi-value filters
 * need, and the reason this is not a `<select multiple>`: that element hides
 * the fact that more than one value is selectable behind a ctrl-click nobody
 * discovers, and grows a scrolling listbox in the middle of a one-line bar.
 *
 * Ticking boxes UNIONS them (see `todoFilters`), so the panel never closes on a
 * click: choosing a second folder is the normal case, not a restart.
 */
function MultiSelectFilter({ ariaLabel, title, emptyLabel, unit, options, selected, kind, onChange }: MultiSelectProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const selectedSet = new Set(selected)

  const triggerLabel = () => {
    if (selected.length === 0) {
      return emptyLabel
    }
    if (selected.length === 1) {
      // The single selection may name something no longer in the data (a folder
      // deleted elsewhere). Say how many rather than rendering a raw uuid.
      return options.find((option) => option.value === selected[0])?.label ?? `1 ${unit.one} selected`
    }
    return `${selected.length} ${unit.many} selected`
  }

  const toggle = (value: string, checked: boolean) => {
    onChange(checked ? [...selected.filter((each) => each !== value), value] : selected.filter((each) => each !== value))
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`${SELECT_CLASS} flex max-w-[14rem] items-center gap-1`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <span className="truncate">{triggerLabel()}</span>
        <Icon type="chevron-down" size="small" className="text-neutral flex-shrink-0" />
      </button>
      <Popover
        open={open}
        anchorElement={triggerRef}
        title={title}
        side="bottom"
        align="start"
        togglePopover={() => setOpen(false)}
        className="p-2"
      >
        <div className="flex max-h-72 min-w-[14rem] flex-col gap-1 overflow-y-auto" data-todo-filter={kind}>
          <div className="flex items-center justify-between gap-2 px-1 pb-1">
            <span className="text-passive-1 text-xs font-semibold">{title}</span>
            {selected.length > 0 && (
              <button type="button" className="text-info rounded px-1 text-xs hover:underline" onClick={() => onChange([])}>
                Clear
              </button>
            )}
          </div>
          {options.length === 0 ? (
            <span className="text-passive-2 px-1 py-2 text-xs">Nothing to filter by yet.</span>
          ) : (
            options.map((option) => (
              <label
                key={option.value}
                className="hover:bg-contrast flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm"
              >
                <input
                  type="checkbox"
                  className="flex-shrink-0"
                  checked={selectedSet.has(option.value)}
                  aria-label={option.label}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked
                    toggle(option.value, checked)
                  }}
                />
                <span className="truncate" title={option.label}>
                  {option.label}
                </span>
              </label>
            ))
          )}
        </div>
      </Popover>
    </>
  )
}

/**
 * Standard Red Notes: the Todos general view's filter bar.
 *
 * Every control writes the whole filter object back through `onChange`, so the
 * owner has exactly one place to persist from. Controls COMPOSE — search, tags,
 * sections, source, due and hide-completed all apply together.
 *
 * The section control is rendered ONLY when Advanced Checklist sections exist in
 * the data (or one is already selected, so a stale selection is never left with
 * no way to undo it). A control that is permanently empty for the majority who
 * have no such notes would cost every user bar space to buy nothing.
 *
 * The "N filters active" line is deliberately always shown while any filter is
 * on. Filters persist across reloads, so without it a user can return to an
 * empty-looking list with no idea why.
 */
export default function TodoFilterBar({
  filters,
  tagOptions,
  groupOptions,
  visibleCount,
  totalCount,
  onChange,
}: Props) {
  const activeCount = activeTodoFilterCount(filters)
  const patch = (changes: Partial<TodoFilters>) => onChange({ ...filters, ...changes })
  const clearAll = () => onChange({ ...DEFAULT_TODO_FILTERS, sortBy: filters.sortBy, sortReverse: filters.sortReverse })
  const showGroupFilter = groupOptions.length > 0 || filters.groupNames.length > 0

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

        <MultiSelectFilter
          ariaLabel="Filter by folder or tag"
          title={'Folders & tags'}
          emptyLabel={'All folders & tags'}
          unit={{ one: 'folder', many: 'folders & tags' }}
          kind="tags"
          // Nested folders are shown by their FULL path: two folders can share a
          // leaf title, and telling them apart is the entire point of nesting.
          options={tagOptions.map((tag) => ({ value: tag.uuid, label: todoTagLabel(tag) }))}
          selected={filters.tagUuids}
          onChange={(tagUuids) => patch({ tagUuids })}
        />

        {showGroupFilter && (
          <MultiSelectFilter
            ariaLabel="Filter by checklist section"
            title="Checklist sections"
            emptyLabel="All sections"
            unit={{ one: 'section', many: 'sections' }}
            kind="groups"
            options={groupOptions.map((name) => ({ value: name, label: name }))}
            selected={filters.groupNames}
            onChange={(groupNames) => patch({ groupNames })}
          />
        )}

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
