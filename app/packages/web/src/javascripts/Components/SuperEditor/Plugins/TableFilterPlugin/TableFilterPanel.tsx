/**
 * The in-place filter editor for ONE column.
 *
 * Used in two places with no variation: inside the table's injected caption
 * (opened from the per-header chip) and inside the Filtering section of the
 * selection-scoped table actions menu. Keeping it one component is what makes
 * "the headers should have those too" literally the same capability rather than
 * a reduced copy of it.
 *
 * EVERY CONTROL IS A REAL <button> OR <input>. `useListKeyboardNavigation`
 * collects `button, div[role="button"]` with a subtree MutationObserver, so an
 * in-place disclosure like this one stays arrow-key navigable inside the menu
 * automatically, which a portaled nested Popover would not. Its keydown handler
 * also bails out while focus is in an INPUT, so typing a filter value does not
 * move the menu's focus ring.
 *
 * Changes apply LIVE. There is no Apply button because there is no second
 * source of truth: the panel is a pure projection of the column's stored filter
 * and every edit writes straight through.
 */

import { ChangeEvent, useCallback, useMemo } from 'react'

import {
  ColumnCombinator,
  ColumnType,
  conditionIsActive,
  createCondition,
  defaultOperatorForColumnType,
  FilterCondition,
  FilterOperator,
  MAX_CONDITIONS_PER_COLUMN,
  operatorArity,
  operatorLabel,
  operatorsForColumnType,
} from './tableFilterModel'

export const TABLE_FILTER_PANEL_ATTR = 'data-srn-table-filter-panel'

const COLUMN_TYPE_LABELS: Record<ColumnType, string> = {
  text: 'text',
  number: 'number',
  currency: 'currency',
  date: 'date',
  boolean: 'yes / no',
}

type TableFilterPanelProps = {
  columnLabel: string
  columnType: ColumnType
  conditions: FilterCondition[]
  combinator: ColumnCombinator
  onChange: (conditions: FilterCondition[], combinator: ColumnCombinator) => void
  onClear: () => void
  onClose?: () => void
  /** The live "Filtered: showing X of Y rows" line, when a filter is active. */
  statusText?: string | null
  /** Stored filters this build could not read; reported, never guessed at. */
  unreadable?: string[]
}

const TableFilterPanel = ({
  columnLabel,
  columnType,
  conditions,
  combinator,
  onChange,
  onClear,
  onClose,
  statusText,
  unreadable = [],
}: TableFilterPanelProps) => {
  const operators = operatorsForColumnType(columnType)
  // A column with no stored filter still shows one blank condition row, so the
  // panel never opens empty. Memoised because every callback below depends on it.
  const effectiveConditions = useMemo(
    () => (conditions.length > 0 ? conditions : [createCondition(defaultOperatorForColumnType(columnType))]),
    [columnType, conditions],
  )

  const replaceCondition = useCallback(
    (index: number, next: FilterCondition) => {
      onChange(
        effectiveConditions.map((condition, position) => (position === index ? next : condition)),
        combinator,
      )
    },
    [combinator, effectiveConditions, onChange],
  )

  const setOperator = useCallback(
    (index: number, operator: FilterOperator) => {
      const previous = effectiveConditions[index]
      replaceCondition(index, {
        operator,
        // An operator that reads no operand must not keep a stale one around:
        // it would come back the moment the user switched operator again.
        value: operatorArity(operator) === 0 ? '' : previous.value,
        value2: operatorArity(operator) === 2 ? previous.value2 : '',
      })
    },
    [effectiveConditions, replaceCondition],
  )

  const onValueChange = useCallback(
    (index: number, field: 'value' | 'value2') => (event: ChangeEvent<HTMLInputElement>) => {
      replaceCondition(index, { ...effectiveConditions[index], [field]: event.target.value })
    },
    [effectiveConditions, replaceCondition],
  )

  const addCondition = useCallback(() => {
    onChange([...effectiveConditions, createCondition(defaultOperatorForColumnType(columnType))], combinator)
  }, [columnType, combinator, effectiveConditions, onChange])

  const removeCondition = useCallback(
    (index: number) => {
      const next = effectiveConditions.filter((_, position) => position !== index)
      onChange(next, combinator)
    },
    [combinator, effectiveConditions, onChange],
  )

  return (
    <div
      className="Lexical__tableFilterPanel"
      data-srn-print-exclude="true"
      role="group"
      aria-label={`Filter ${columnLabel}`}
      {...{ [TABLE_FILTER_PANEL_ATTR]: 'true' }}
    >
      <div className="Lexical__tableFilterPanelRow">
        <strong>{columnLabel}</strong>
        <span data-srn-table-filter-column-type={columnType}>({COLUMN_TYPE_LABELS[columnType]})</span>
      </div>

      {effectiveConditions.map((condition, index) => {
        const arity = operatorArity(condition.operator)
        return (
          <div
            className="Lexical__tableFilterPanelRow"
            key={`condition-${index}`}
            data-srn-table-filter-condition={index}
          >
            {operators.map((operator) => (
              <button
                key={operator}
                type="button"
                aria-pressed={condition.operator === operator}
                data-srn-table-filter-operator={operator}
                onClick={() => setOperator(index, operator)}
              >
                {operatorLabel(operator, columnType)}
              </button>
            ))}
            {arity >= 1 && (
              <input
                type="text"
                value={condition.value}
                data-srn-table-filter-value={index}
                aria-label={`${operatorLabel(condition.operator, columnType)} value for ${columnLabel}`}
                onChange={onValueChange(index, 'value')}
              />
            )}
            {arity === 2 && (
              <input
                type="text"
                value={condition.value2}
                data-srn-table-filter-value2={index}
                aria-label={`Upper bound for ${columnLabel}`}
                onChange={onValueChange(index, 'value2')}
              />
            )}
            {!conditionIsActive(condition, columnType) && (
              <span data-srn-table-filter-inert="true">not applied yet</span>
            )}
            {effectiveConditions.length > 1 && (
              <button type="button" data-srn-table-filter-remove={index} onClick={() => removeCondition(index)}>
                Remove
              </button>
            )}
          </div>
        )
      })}

      {effectiveConditions.length > 1 && (
        <div className="Lexical__tableFilterPanelRow" role="group" aria-label="Combine this column's conditions">
          <button
            type="button"
            aria-pressed={combinator === 'all'}
            data-srn-table-filter-combinator="all"
            onClick={() => onChange(effectiveConditions, 'all')}
          >
            Match all
          </button>
          <button
            type="button"
            aria-pressed={combinator === 'any'}
            data-srn-table-filter-combinator="any"
            onClick={() => onChange(effectiveConditions, 'any')}
          >
            Match any
          </button>
          <span>Columns always combine with AND.</span>
        </div>
      )}

      <div className="Lexical__tableFilterPanelRow">
        {effectiveConditions.length < MAX_CONDITIONS_PER_COLUMN && (
          <button type="button" data-srn-table-filter-add="true" onClick={addCondition}>
            Add condition
          </button>
        )}
        <button type="button" data-srn-table-filter-clear-column="true" onClick={onClear}>
          Clear this column
        </button>
        {onClose && (
          <button type="button" data-srn-table-filter-close="true" onClick={onClose}>
            Done
          </button>
        )}
      </div>

      {statusText && <div data-srn-table-filter-panel-status="true">{statusText}</div>}

      {unreadable.length > 0 && (
        <div className="Lexical__tableFilterUnreadable" data-srn-table-filter-unreadable="true">
          {unreadable.join(' ')}
        </div>
      )}
    </div>
  )
}

export default TableFilterPanel
