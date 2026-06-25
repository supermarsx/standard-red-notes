import { useState } from 'react'
import { MultiKeySortOptions, SortKey, SortKeyType } from './LineSortMultiKey'

type Separator = MultiKeySortOptions['separator']

type KeyRow = {
  enabled: boolean
  field: number // 1-based in the UI
  type: SortKeyType
  direction: SortKey['direction']
}

const SEPARATORS: { value: Separator; label: string }[] = [
  { value: 'whitespace', label: 'Whitespace' },
  { value: 'tab', label: 'Tab' },
  { value: 'comma', label: 'Comma' },
  { value: 'space', label: 'Single space' },
]

const DEFAULT_ROWS: KeyRow[] = [
  { enabled: true, field: 1, type: 'text', direction: 'asc' },
  { enabled: false, field: 2, type: 'text', direction: 'asc' },
  { enabled: false, field: 3, type: 'text', direction: 'asc' },
]

const ROW_LABELS = ['Sort by', 'Then by', 'Then by']

/**
 * Word-style "Sort" dialog body (rendered inside the Super editor modal): choose a
 * field separator and up to three ordered sort keys.
 */
const MultiKeySortDialog = ({
  onApply,
  onClose,
}: {
  onApply: (options: MultiKeySortOptions) => void
  onClose: () => void
}) => {
  const [separator, setSeparator] = useState<Separator>('whitespace')
  const [rows, setRows] = useState<KeyRow[]>(DEFAULT_ROWS)

  const updateRow = (index: number, patch: Partial<KeyRow>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)))

  const apply = () => {
    const keys: SortKey[] = rows
      .filter((row) => row.enabled)
      .map((row) => ({ field: Math.max(0, row.field - 1), type: row.type, direction: row.direction }))
    if (keys.length === 0) {
      onClose()
      return
    }
    onApply({ separator, keys })
  }

  return (
    <div className="flex w-[min(90vw,30rem)] flex-col gap-3 text-sm">
      <p className="text-passive-0">
        Sort the selected lines by one or more fields. Fields are split by the chosen separator.
      </p>

      <label className="flex items-center justify-between gap-2">
        <span className="font-semibold">Separate fields by</span>
        <select
          className="rounded border border-border bg-default px-2 py-1"
          value={separator}
          onChange={(event) => setSeparator(event.target.value as Separator)}
        >
          {SEPARATORS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <div className="flex flex-col gap-2">
        {rows.map((row, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2 rounded border border-border p-2">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={row.enabled}
                onChange={(event) => updateRow(index, { enabled: event.target.checked })}
              />
              <span className="w-16 font-semibold">{ROW_LABELS[index]}</span>
            </label>
            <label className="flex items-center gap-1">
              Field
              <input
                type="number"
                min={1}
                className="w-16 rounded border border-border bg-default px-1.5 py-1 disabled:opacity-50"
                value={row.field}
                disabled={!row.enabled}
                onChange={(event) => updateRow(index, { field: Math.max(1, Number(event.target.value) || 1) })}
              />
            </label>
            <select
              className="rounded border border-border bg-default px-1.5 py-1 disabled:opacity-50"
              value={row.type}
              disabled={!row.enabled}
              onChange={(event) => updateRow(index, { type: event.target.value as SortKeyType })}
            >
              <option value="text">Text</option>
              <option value="number">Number</option>
            </select>
            <select
              className="rounded border border-border bg-default px-1.5 py-1 disabled:opacity-50"
              value={row.direction}
              disabled={!row.enabled}
              onChange={(event) => updateRow(index, { direction: event.target.value as SortKey['direction'] })}
            >
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
          </div>
        ))}
      </div>

      <div className="mt-1 flex justify-end gap-2">
        <button type="button" className="rounded border border-border px-3 py-1.5 hover:bg-contrast" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="rounded bg-info px-3 py-1.5 font-semibold text-info-contrast hover:brightness-110"
          onClick={apply}
        >
          Sort
        </button>
      </div>
    </div>
  )
}

export default MultiKeySortDialog
