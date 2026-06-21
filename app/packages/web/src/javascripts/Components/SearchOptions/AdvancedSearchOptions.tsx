import { observer } from 'mobx-react-lite'
import { useCallback, useMemo, useRef, useState } from 'react'
import { ItemListController } from '@/Controllers/ItemList/ItemListController'
import {
  AdvancedSearchOptions as AdvancedSearchOptionsValue,
  buildQueryFromOptions,
  NoteFlag,
  parseAdvancedSearchOptions,
} from '@/Utils/Items/Search/SearchQueryParser'
import Icon from '../Icon/Icon'
import Popover from '../Popover/Popover'
import Switch from '../Switch/Switch'
import StyledTooltip from '../StyledTooltip/StyledTooltip'

type Props = {
  itemListController: ItemListController
}

const NOTE_TYPES: { label: string; value: string }[] = [
  { label: 'Any type', value: '' },
  { label: 'Plain text', value: 'plain-text' },
  { label: 'Rich text', value: 'rich-text' },
  { label: 'Super', value: 'super' },
  { label: 'Markdown', value: 'markdown' },
  { label: 'Code', value: 'code' },
  { label: 'Task', value: 'task' },
  { label: 'Spreadsheet', value: 'spreadsheet' },
]

const FLAG_LABELS: { flag: NoteFlag; label: string }[] = [
  { flag: 'protected', label: 'Protected' },
  { flag: 'pinned', label: 'Pinned' },
  { flag: 'archived', label: 'Archived' },
  { flag: 'starred', label: 'Starred' },
  { flag: 'trashed', label: 'Trashed' },
]

const fieldLabel = 'mb-1 block text-xs font-semibold text-passive-0'
const fieldInput =
  'w-full rounded border border-border bg-default px-2 py-1.5 text-sm text-text focus:border-info focus:outline-none'

const AdvancedSearchOptions = ({ itemListController }: Props) => {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)

  // Derive the panel controls from the current query so the panel and the
  // power-user operators in the search box always stay in lock-step.
  const options = useMemo(
    () => parseAdvancedSearchOptions(itemListController.noteFilterText),
    [itemListController.noteFilterText],
  )

  const applyOptions = useCallback(
    (next: AdvancedSearchOptionsValue) => {
      const query = buildQueryFromOptions(next)
      itemListController.setNoteFilterText(query)
      itemListController.onFilterEnter()
    },
    [itemListController],
  )

  const update = useCallback(
    (patch: Partial<AdvancedSearchOptionsValue>) => {
      applyOptions({ ...options, ...patch })
    },
    [applyOptions, options],
  )

  const togglePopover = useCallback(() => setOpen((value) => !value), [])

  const tagsValue = options.tags.join(', ')

  return (
    <>
      <StyledTooltip label="Advanced search filters" showOnHover>
        <button
          ref={buttonRef}
          role="button"
          aria-label="Advanced search filters"
          aria-pressed={open}
          className="flex items-center gap-1 rounded-full border border-border px-2 py-1 text-sm text-neutral transition hover:bg-contrast"
          onClick={togglePopover}
        >
          <Icon type="tune" size="small" />
          <span>Filters</span>
        </button>
      </StyledTooltip>

      <Popover
        title="Advanced search filters"
        open={open}
        anchorElement={buttonRef}
        togglePopover={togglePopover}
        side="bottom"
        align="start"
        className="py-2"
      >
        <div className="flex w-80 max-w-full flex-col gap-3 p-3">
          <div>
            <label className={fieldLabel} htmlFor="adv-search-tags">
              Topics (comma separated)
            </label>
            <input
              id="adv-search-tags"
              className={fieldInput}
              type="text"
              placeholder="work, personal"
              value={tagsValue}
              onChange={(event) =>
                update({
                  tags: event.target.value
                    .split(',')
                    .map((tag) => tag.trim())
                    .filter((tag) => tag.length > 0),
                })
              }
            />
          </div>

          <div>
            <label className={fieldLabel} htmlFor="adv-search-type">
              Note type
            </label>
            <select
              id="adv-search-type"
              className={fieldInput}
              value={NOTE_TYPES.some((t) => t.value === options.type) ? options.type : ''}
              onChange={(event) => update({ type: event.target.value })}
            >
              {NOTE_TYPES.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <span className={fieldLabel}>Search in</span>
            <div className="flex gap-1">
              {(['all', 'title', 'content'] as const).map((scope) => (
                <button
                  key={scope}
                  className={
                    'flex-grow rounded border px-2 py-1 text-sm capitalize transition ' +
                    (options.scope === scope
                      ? 'border-info bg-info text-info-contrast'
                      : 'border-border bg-default text-neutral hover:bg-contrast')
                  }
                  onClick={() => update({ scope })}
                >
                  {scope === 'all' ? 'Title & content' : scope}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={fieldLabel} htmlFor="adv-created-after">
                Created after
              </label>
              <input
                id="adv-created-after"
                className={fieldInput}
                type="date"
                value={options.createdAfter}
                onChange={(event) => update({ createdAfter: event.target.value })}
              />
            </div>
            <div>
              <label className={fieldLabel} htmlFor="adv-created-before">
                Created before
              </label>
              <input
                id="adv-created-before"
                className={fieldInput}
                type="date"
                value={options.createdBefore}
                onChange={(event) => update({ createdBefore: event.target.value })}
              />
            </div>
            <div>
              <label className={fieldLabel} htmlFor="adv-updated-after">
                Updated after
              </label>
              <input
                id="adv-updated-after"
                className={fieldInput}
                type="date"
                value={options.updatedAfter}
                onChange={(event) => update({ updatedAfter: event.target.value })}
              />
            </div>
            <div>
              <label className={fieldLabel} htmlFor="adv-updated-before">
                Updated before
              </label>
              <input
                id="adv-updated-before"
                className={fieldInput}
                type="date"
                value={options.updatedBefore}
                onChange={(event) => update({ updatedBefore: event.target.value })}
              />
            </div>
          </div>

          <div>
            <span className={fieldLabel}>Status</span>
            <div className="flex flex-col gap-2">
              {FLAG_LABELS.map(({ flag, label }) => (
                <Switch
                  key={flag}
                  checked={options.flags[flag]}
                  onChange={(checked) => update({ flags: { ...options.flags, [flag]: checked } })}
                  className="flex cursor-pointer items-center"
                >
                  <span className="ml-2 text-sm text-text">{label}</span>
                </Switch>
              ))}
            </div>
          </div>

          <Switch
            checked={itemListController.searchCaseSensitive}
            onChange={(checked) => itemListController.setSearchCaseSensitive(checked)}
            className="flex cursor-pointer items-center"
          >
            <span className="ml-2 text-sm text-text">Case sensitive</span>
          </Switch>

          <button
            className="mt-1 rounded border border-border px-2 py-1.5 text-sm text-neutral transition hover:bg-contrast"
            onClick={() => {
              itemListController.clearFilterText()
              itemListController.setSearchCaseSensitive(false)
            }}
          >
            Clear all filters
          </button>
        </div>
      </Popover>
    </>
  )
}

export default observer(AdvancedSearchOptions)
