import { observer } from 'mobx-react-lite'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
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

// `labelKey` references a key in the 'search' namespace, resolved at render time.
const NOTE_TYPES: { labelKey: string; value: string }[] = [
  { labelKey: 'noteTypeAny', value: '' },
  { labelKey: 'noteTypePlainText', value: 'plain-text' },
  { labelKey: 'noteTypeRichText', value: 'rich-text' },
  { labelKey: 'noteTypeSuper', value: 'super' },
  { labelKey: 'noteTypeMarkdown', value: 'markdown' },
  { labelKey: 'noteTypeCode', value: 'code' },
  { labelKey: 'noteTypeTask', value: 'task' },
  { labelKey: 'noteTypeSpreadsheet', value: 'spreadsheet' },
]

const FLAG_LABELS: { flag: NoteFlag; labelKey: string }[] = [
  { flag: 'protected', labelKey: 'flagProtected' },
  { flag: 'pinned', labelKey: 'flagPinned' },
  { flag: 'archived', labelKey: 'flagArchived' },
  { flag: 'starred', labelKey: 'flagStarred' },
  { flag: 'trashed', labelKey: 'flagTrashed' },
]

// Quick relative-date presets. Each maps to an "after" date computed from now,
// applied to either the created or updated field depending on the active toggle.
// `label` is a non-localized abbreviation token shown inside the "Last {label}" phrase.
const DATE_PRESETS: { label: string; days: number }[] = [
  { label: '24h', days: 1 },
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
]

/** ISO yyyy-mm-dd for `days` ago from now, matching the date <input> format. */
const isoDaysAgo = (days: number): string => {
  const date = new Date()
  date.setDate(date.getDate() - days)
  return date.toISOString().slice(0, 10)
}

const fieldLabel = 'mb-1 block text-xs font-semibold text-passive-0'
const fieldInput =
  'w-full rounded border border-border bg-default px-2 py-1.5 text-sm text-text focus:border-info focus:outline-none'

const AdvancedSearchOptions = ({ itemListController }: Props) => {
  const { t } = useTranslation('search')
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

  // Quick presets target "recently modified" by default (updatedAfter), the most
  // common case; the created/before fields below remain available for precision.
  const activePresetDays = DATE_PRESETS.find((preset) => options.updatedAfter === isoDaysAgo(preset.days))?.days

  const applyDatePreset = useCallback(
    (days: number) => {
      // Toggle off when the same preset is clicked again.
      update({ updatedAfter: options.updatedAfter === isoDaysAgo(days) ? '' : isoDaysAgo(days) })
    },
    [options.updatedAfter, update],
  )

  return (
    <>
      <StyledTooltip label={t('advancedFilters')} showOnHover>
        <button
          ref={buttonRef}
          role="button"
          aria-label={t('advancedFilters')}
          aria-pressed={open}
          className="flex items-center gap-1 rounded-full border border-border px-2 py-1 text-sm text-neutral transition hover:bg-contrast"
          onClick={togglePopover}
        >
          <Icon type="tune" size="small" />
          <span>{t('filters')}</span>
        </button>
      </StyledTooltip>

      <Popover
        title={t('advancedFilters')}
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
              {t('topicsLabel')}
            </label>
            <input
              id="adv-search-tags"
              className={fieldInput}
              type="text"
              placeholder={t('topicsPlaceholder')}
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
              {t('noteTypeLabel')}
            </label>
            <select
              id="adv-search-type"
              className={fieldInput}
              value={NOTE_TYPES.some((t) => t.value === options.type) ? options.type : ''}
              onChange={(event) => update({ type: event.target.value })}
            >
              {NOTE_TYPES.map((type) => (
                <option key={type.value} value={type.value}>
                  {t(type.labelKey)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <span className={fieldLabel}>{t('searchInLabel')}</span>
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
                  {scope === 'all' ? t('searchInTitleAndContent') : scope}
                </button>
              ))}
            </div>
          </div>

          <div>
            <span className={fieldLabel}>{t('modifiedWithinLabel')}</span>
            <div className="flex gap-1">
              {DATE_PRESETS.map((preset) => (
                <button
                  key={preset.days}
                  className={
                    'flex-grow rounded border px-2 py-1 text-sm transition ' +
                    (activePresetDays === preset.days
                      ? 'border-info bg-info text-info-contrast'
                      : 'border-border bg-default text-neutral hover:bg-contrast')
                  }
                  onClick={() => applyDatePreset(preset.days)}
                >
                  {t('datePreset', { label: preset.label })}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={fieldLabel} htmlFor="adv-created-after">
                {t('createdAfterLabel')}
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
                {t('createdBeforeLabel')}
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
                {t('updatedAfterLabel')}
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
                {t('updatedBeforeLabel')}
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
            <span className={fieldLabel}>{t('statusLabel')}</span>
            <div className="flex flex-col gap-2">
              {FLAG_LABELS.map(({ flag, labelKey }) => (
                <Switch
                  key={flag}
                  checked={options.flags[flag]}
                  onChange={(checked) => update({ flags: { ...options.flags, [flag]: checked } })}
                  className="flex cursor-pointer items-center"
                >
                  <span className="ml-2 text-sm text-text">{t(labelKey)}</span>
                </Switch>
              ))}
              <Switch
                checked={options.hasFiles}
                onChange={(checked) => update({ hasFiles: checked })}
                className="flex cursor-pointer items-center"
              >
                <span className="ml-2 text-sm text-text">{t('hasAttachments')}</span>
              </Switch>
            </div>
          </div>

          <Switch
            checked={itemListController.searchCaseSensitive}
            onChange={(checked) => itemListController.setSearchCaseSensitive(checked)}
            className="flex cursor-pointer items-center"
          >
            <span className="ml-2 text-sm text-text">{t('caseSensitive')}</span>
          </Switch>

          <button
            className="mt-1 rounded border border-border px-2 py-1.5 text-sm text-neutral transition hover:bg-contrast"
            onClick={() => {
              itemListController.clearFilterText()
              itemListController.setSearchCaseSensitive(false)
            }}
          >
            {t('clearAllFilters')}
          </button>
        </div>
      </Popover>
    </>
  )
}

export default observer(AdvancedSearchOptions)
