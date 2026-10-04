/**
 * The operator semantics, the normalize-on-read parser and the row-matching
 * arithmetic for table filtering.
 *
 * jsdom has no layout engine, so nothing here pretends to verify geometry. What
 * it does pin is the behaviour a filter can get wrong silently: an unrecognised
 * operator being applied as a different one, a half-typed value blanking the
 * table, and the "showing X of Y rows" copy going missing while rows are hidden.
 */

import {
  ColumnDescriptor,
  ColumnFilter,
  computeRowVisibility,
  conditionIsActive,
  createCondition,
  defaultOperatorForColumnType,
  describeConditionsForLabel,
  FILTER_OPERATORS,
  filterIndicatorText,
  filterIsDisclosable,
  filterPrintNoticeText,
  isFilterOperator,
  matchesColumnFilter,
  matchesCondition,
  MAX_CONDITIONS_PER_COLUMN,
  operatorArity,
  operatorLabel,
  operatorsForColumnType,
  parseTableFilterState,
  resolveActiveFilters,
  summarizeFilters,
  tableFilterStatesEqual,
  unparseTableFilterState,
} from './tableFilterModel'

const condition = (operator: Parameters<typeof operatorArity>[0], value = '', value2 = '') => ({
  operator,
  value,
  value2,
})

describe('operator sets per column type', () => {
  it('offers text matching, presence and no arithmetic for a text column', () => {
    expect(operatorsForColumnType('text')).toEqual([
      'contains',
      'notContains',
      'equals',
      'notEquals',
      'startsWith',
      'endsWith',
      'isEmpty',
      'isNotEmpty',
    ])
  })

  it('offers the ordered comparisons and between for number and currency', () => {
    expect(operatorsForColumnType('number')).toEqual([
      'eq',
      'neq',
      'lt',
      'lte',
      'gt',
      'gte',
      'between',
      'isEmpty',
      'isNotEmpty',
    ])
    expect(operatorsForColumnType('currency')).toEqual(operatorsForColumnType('number'))
  })

  it('labels the shared ordered operators as dates for a date column', () => {
    expect(operatorsForColumnType('date')).toEqual(operatorsForColumnType('number'))
    expect(operatorLabel('lt', 'date')).toBe('is before')
    expect(operatorLabel('gte', 'date')).toBe('is on or after')
    expect(operatorLabel('lt', 'number')).toBe('is less than')
  })

  it('offers only truth and presence for a boolean column', () => {
    expect(operatorsForColumnType('boolean')).toEqual(['isTrue', 'isFalse', 'isEmpty', 'isNotEmpty'])
  })

  it('gives every declared operator a label and an arity', () => {
    for (const operator of FILTER_OPERATORS) {
      expect(operatorLabel(operator, 'text').length).toBeGreaterThan(0)
      expect([0, 1, 2]).toContain(operatorArity(operator))
    }
    expect(operatorArity('between')).toBe(2)
    expect(operatorArity('isEmpty')).toBe(0)
    expect(operatorArity('contains')).toBe(1)
  })

  it('defaults a column to the first operator its type offers', () => {
    expect(defaultOperatorForColumnType('text')).toBe('contains')
    expect(defaultOperatorForColumnType('number')).toBe('eq')
    expect(defaultOperatorForColumnType('boolean')).toBe('isTrue')
    expect(createCondition('contains')).toEqual({ operator: 'contains', value: '', value2: '' })
  })
})

describe('text operators', () => {
  it('matches case-insensitively on substring, prefix and suffix', () => {
    expect(matchesCondition('Hello World', condition('contains', 'o w'), 'text')).toBe(true)
    expect(matchesCondition('Hello World', condition('notContains', 'o w'), 'text')).toBe(false)
    expect(matchesCondition('Hello World', condition('startsWith', 'hel'), 'text')).toBe(true)
    expect(matchesCondition('Hello World', condition('endsWith', 'RLD'), 'text')).toBe(true)
    expect(matchesCondition('Hello World', condition('startsWith', 'world'), 'text')).toBe(false)
  })

  it('trims both sides for equality so trailing whitespace does not defeat it', () => {
    expect(matchesCondition('  Done  ', condition('equals', 'done'), 'text')).toBe(true)
    expect(matchesCondition('  Done  ', condition('notEquals', 'done'), 'text')).toBe(false)
    expect(matchesCondition('Done later', condition('equals', 'done'), 'text')).toBe(false)
  })

  it('reads emptiness from the trimmed value', () => {
    expect(matchesCondition('   ', condition('isEmpty'), 'text')).toBe(true)
    expect(matchesCondition('   ', condition('isNotEmpty'), 'text')).toBe(false)
    expect(matchesCondition(' x ', condition('isNotEmpty'), 'text')).toBe(true)
  })
})

describe('numeric, currency and date operators', () => {
  it('compares numbers including grouped thousands', () => {
    expect(matchesCondition('1,500', condition('gt', '1000'), 'number')).toBe(true)
    expect(matchesCondition('1,500', condition('lte', '1500'), 'number')).toBe(true)
    expect(matchesCondition('1,500', condition('lt', '1500'), 'number')).toBe(false)
    expect(matchesCondition('-3', condition('gte', '-3'), 'number')).toBe(true)
    expect(matchesCondition('7', condition('eq', '7'), 'number')).toBe(true)
    expect(matchesCondition('7', condition('neq', '7'), 'number')).toBe(false)
  })

  it('reads a currency cell against a bare numeric operand', () => {
    expect(matchesCondition('$1,250.50', condition('gt', '1000'), 'currency')).toBe(true)
    expect(matchesCondition('$1,250.50', condition('lt', '1000'), 'currency')).toBe(false)
    expect(matchesCondition('R$9', condition('lte', '10'), 'currency')).toBe(true)
  })

  it('treats between as inclusive and tolerates reversed bounds', () => {
    expect(matchesCondition('5', condition('between', '1', '10'), 'number')).toBe(true)
    expect(matchesCondition('5', condition('between', '10', '1'), 'number')).toBe(true)
    expect(matchesCondition('1', condition('between', '1', '10'), 'number')).toBe(true)
    expect(matchesCondition('10', condition('between', '1', '10'), 'number')).toBe(true)
    expect(matchesCondition('11', condition('between', '1', '10'), 'number')).toBe(false)
  })

  it('compares dates by instant, taking the operand as a date too', () => {
    expect(matchesCondition('2026-03-05', condition('lt', '2026-04-01'), 'date')).toBe(true)
    expect(matchesCondition('2026-03-05', condition('gt', '2026-04-01'), 'date')).toBe(false)
    expect(matchesCondition('2026-03-05', condition('between', '2026-01-01', '2026-12-31'), 'date')).toBe(true)
    expect(matchesCondition('5 Mar 2026', condition('gte', '2026-03-05'), 'date')).toBe(true)
  })

  it('reads yes/no cells for a boolean column', () => {
    expect(matchesCondition('Yes', condition('isTrue'), 'boolean')).toBe(true)
    expect(matchesCondition('no', condition('isFalse'), 'boolean')).toBe(true)
    expect(matchesCondition('maybe', condition('isTrue'), 'boolean')).toBe(false)
    expect(matchesCondition('maybe', condition('isFalse'), 'boolean')).toBe(false)
  })

  it('never satisfies an ordering comparison for an unparseable cell, and always satisfies neq', () => {
    expect(matchesCondition('n/a', condition('gt', '0'), 'number')).toBe(false)
    expect(matchesCondition('n/a', condition('lt', '0'), 'number')).toBe(false)
    expect(matchesCondition('n/a', condition('eq', '0'), 'number')).toBe(false)
    expect(matchesCondition('n/a', condition('between', '0', '9'), 'number')).toBe(false)
    expect(matchesCondition('n/a', condition('neq', '0'), 'number')).toBe(true)
  })
})

describe('a half-specified condition is inert, never a blank table', () => {
  it('reports a blank or unreadable operand as not active', () => {
    expect(conditionIsActive(condition('contains', ''), 'text')).toBe(false)
    expect(conditionIsActive(condition('contains', 'a'), 'text')).toBe(true)
    expect(conditionIsActive(condition('gt', ''), 'number')).toBe(false)
    expect(conditionIsActive(condition('gt', 'abc'), 'number')).toBe(false)
    expect(conditionIsActive(condition('gt', '3'), 'number')).toBe(true)
    expect(conditionIsActive(condition('between', '3', ''), 'number')).toBe(false)
    expect(conditionIsActive(condition('between', '3', '9'), 'number')).toBe(true)
    expect(conditionIsActive(condition('isEmpty'), 'text')).toBe(true)
  })

  it('shows every row while a value is still being typed', () => {
    const columns: ColumnDescriptor[] = [{ columnId: 'c1', type: 'text' }]
    const filter: ColumnFilter = { columnId: 'c1', combinator: 'all', conditions: [condition('contains', '')] }
    expect(computeRowVisibility([['a'], ['b']], [filter], columns)).toEqual([true, true])
  })
})

describe('combination across and within columns', () => {
  const columns: ColumnDescriptor[] = [
    { columnId: 'name', type: 'text' },
    { columnId: 'price', type: 'number' },
  ]
  const rows = [
    ['Apple', '10'],
    ['Apricot', '40'],
    ['Banana', '20'],
    ['Cherry', '5'],
  ]

  it('ANDs across columns', () => {
    const filters: ColumnFilter[] = [
      { columnId: 'name', combinator: 'all', conditions: [condition('startsWith', 'a')] },
      { columnId: 'price', combinator: 'all', conditions: [condition('lt', '30')] },
    ]
    expect(computeRowVisibility(rows, filters, columns)).toEqual([true, false, false, false])
  })

  it('ANDs multiple conditions within one column by default', () => {
    const filter: ColumnFilter = {
      columnId: 'price',
      combinator: 'all',
      conditions: [condition('gt', '8'), condition('lt', '30')],
    }
    expect(computeRowVisibility(rows, [filter], columns)).toEqual([true, false, true, false])
  })

  it('ORs within one column when its combinator says any', () => {
    const filter: ColumnFilter = {
      columnId: 'name',
      combinator: 'any',
      conditions: [condition('equals', 'apple'), condition('equals', 'cherry')],
    }
    expect(computeRowVisibility(rows, [filter], columns)).toEqual([true, false, false, true])
  })

  it('ignores inactive conditions when combining', () => {
    expect(
      matchesColumnFilter(
        '15',
        { columnId: 'price', combinator: 'all', conditions: [condition('gt', '10'), condition('lt', '')] },
        'number',
      ),
    ).toBe(true)
  })

  it('shows every row when no filter is active', () => {
    expect(computeRowVisibility(rows, [], columns)).toEqual([true, true, true, true])
  })
})

describe('a filter naming a column that no longer exists', () => {
  it('is not applied and is reported stale', () => {
    const columns: ColumnDescriptor[] = [{ columnId: 'name', type: 'text' }]
    const filters: ColumnFilter[] = [
      { columnId: 'deleted-column', combinator: 'all', conditions: [condition('equals', 'nothing')] },
    ]
    expect(computeRowVisibility([['a'], ['b']], filters, columns)).toEqual([true, true])
    expect(resolveActiveFilters(filters, columns).staleColumnIds).toEqual(['deleted-column'])
  })

  it('cannot be addressed by a column that has not been given an id', () => {
    const columns: ColumnDescriptor[] = [{ columnId: null, type: 'text' }]
    const filters: ColumnFilter[] = [
      { columnId: 'anything', combinator: 'all', conditions: [condition('equals', 'a')] },
    ]
    expect(computeRowVisibility([['a']], filters, columns)).toEqual([true])
  })
})

describe('normalize on read', () => {
  it('reads a well-formed payload', () => {
    const state = parseTableFilterState({
      filters: [{ columnId: 'c1', combinator: 'any', conditions: [{ operator: 'contains', value: 'x' }] }],
    })
    expect(state.filters).toEqual([
      { columnId: 'c1', combinator: 'any', conditions: [{ operator: 'contains', value: 'x', value2: '' }] },
    ])
    expect(state.unreadable).toEqual([])
    expect(state.preserved).toEqual([])
  })

  it('returns an empty state for undefined, which is the stored default', () => {
    expect(parseTableFilterState(undefined)).toEqual({ filters: [], unreadable: [], preserved: [] })
    expect(parseTableFilterState(null)).toEqual({ filters: [], unreadable: [], preserved: [] })
    expect(parseTableFilterState({})).toEqual({ filters: [], unreadable: [], preserved: [] })
  })

  it('DEGRADES AN UNRECOGNISED OPERATOR TO NO FILTER and names it', () => {
    const state = parseTableFilterState({
      filters: [{ columnId: 'c1', combinator: 'all', conditions: [{ operator: 'matchesRegex', value: '^a' }] }],
    })
    expect(state.filters).toEqual([])
    expect(state.unreadable).toHaveLength(1)
    expect(state.unreadable[0]).toContain('matchesRegex')
    expect(state.unreadable[0]).toContain('dropped')
  })

  it('drops the WHOLE column filter when only one of its conditions is unreadable', () => {
    const state = parseTableFilterState({
      filters: [
        {
          columnId: 'c1',
          combinator: 'all',
          conditions: [
            { operator: 'contains', value: 'keep' },
            { operator: 'soundsLike', value: 'drop' },
          ],
        },
      ],
    })
    expect(state.filters).toEqual([])
  })

  it('keeps an unreadable entry verbatim so a round trip cannot erase it', () => {
    const stored = {
      filters: [
        { columnId: 'c1', combinator: 'all', conditions: [{ operator: 'matchesRegex', value: '^a' }] },
        { columnId: 'c2', combinator: 'all', conditions: [{ operator: 'contains', value: 'b' }] },
      ],
    }
    const state = parseTableFilterState(stored)
    expect(state.filters.map((filter) => filter.columnId)).toEqual(['c2'])
    expect(state.preserved).toEqual([stored.filters[0]])
    expect(unparseTableFilterState(state)).toEqual({
      filters: [
        { columnId: 'c2', combinator: 'all', conditions: [{ operator: 'contains', value: 'b', value2: '' }] },
        stored.filters[0],
      ],
    })
  })

  it('drops a preserved entry once this build writes a filter for that same column', () => {
    const state = parseTableFilterState({
      filters: [{ columnId: 'c1', combinator: 'all', conditions: [{ operator: 'matchesRegex', value: '^a' }] }],
    })
    const rewritten = {
      ...state,
      filters: [{ columnId: 'c1', combinator: 'all' as const, conditions: [condition('contains', 'z')] }],
    }
    expect(unparseTableFilterState(rewritten)).toEqual({
      filters: [{ columnId: 'c1', combinator: 'all', conditions: [condition('contains', 'z')] }],
    })
  })

  it('rejects a non-object, a non-array list and malformed entries', () => {
    expect(parseTableFilterState('nope').filters).toEqual([])
    expect(parseTableFilterState('nope').unreadable).toHaveLength(1)
    expect(parseTableFilterState({ filters: 'nope' }).unreadable).toHaveLength(1)
    expect(parseTableFilterState({ filters: [42] }).unreadable).toHaveLength(1)
    expect(parseTableFilterState({ filters: [{ conditions: [] }] }).unreadable).toHaveLength(1)
    expect(parseTableFilterState({ filters: [{ columnId: 'c1' }] }).unreadable).toHaveLength(1)
    expect(parseTableFilterState({ filters: [{ columnId: 'c1', conditions: [] }] }).unreadable).toHaveLength(1)
  })

  it('keeps only the first of two filters naming the same column', () => {
    const state = parseTableFilterState({
      filters: [
        { columnId: 'c1', conditions: [{ operator: 'contains', value: 'first' }] },
        { columnId: 'c1', conditions: [{ operator: 'contains', value: 'second' }] },
      ],
    })
    expect(state.filters).toHaveLength(1)
    expect(state.filters[0].conditions[0].value).toBe('first')
    expect(state.unreadable).toHaveLength(1)
  })

  it('coerces operand types and defaults an unknown combinator to all', () => {
    const state = parseTableFilterState({
      filters: [{ columnId: 'c1', combinator: 'sometimes', conditions: [{ operator: 'eq', value: 42, value2: true }] }],
    })
    expect(state.filters[0].combinator).toBe('all')
    expect(state.filters[0].conditions[0]).toEqual({ operator: 'eq', value: '42', value2: 'true' })
  })

  it('caps the conditions it will read for one column', () => {
    const conditions = Array.from({ length: MAX_CONDITIONS_PER_COLUMN + 3 }, () => ({
      operator: 'isNotEmpty',
    }))
    const state = parseTableFilterState({ filters: [{ columnId: 'c1', conditions }] })
    expect(state.filters[0].conditions).toHaveLength(MAX_CONDITIONS_PER_COLUMN)
    expect(state.unreadable.join(' ')).toContain(String(MAX_CONDITIONS_PER_COLUMN))
  })

  it('agrees with isFilterOperator about what it will accept', () => {
    for (const operator of FILTER_OPERATORS) {
      expect(isFilterOperator(operator)).toBe(true)
    }
    expect(isFilterOperator('matchesRegex')).toBe(false)
    expect(isFilterOperator(7)).toBe(false)
  })

  it('compares states by their serialized projection, ignoring diagnostics', () => {
    const a = parseTableFilterState({ filters: [{ columnId: 'c1', conditions: [{ operator: 'isEmpty' }] }] })
    const b = parseTableFilterState({ filters: [{ columnId: 'c1', conditions: [{ operator: 'isEmpty' }] }] })
    expect(tableFilterStatesEqual(a, b)).toBe(true)
    expect(tableFilterStatesEqual(a, { ...a, filters: [] })).toBe(false)
  })
})

describe('the disclosure copy', () => {
  const columns: ColumnDescriptor[] = [
    { columnId: 'name', type: 'text' },
    { columnId: 'price', type: 'number' },
  ]
  const rows = Array.from({ length: 40 }, (_, index) => [`row ${index}`, String(index)])
  const filters: ColumnFilter[] = [{ columnId: 'price', combinator: 'all', conditions: [condition('lt', '3')] }]

  it('names the shown count, the total and the hidden count', () => {
    const state = { filters, unreadable: [], preserved: [] }
    const visibility = computeRowVisibility(rows, filters, columns)
    const summary = summarizeFilters(visibility, state, columns)

    expect(summary).toMatchObject({ shown: 3, total: 40, hidden: 37, activeColumnCount: 1 })
    expect(filterIndicatorText(summary)).toBe('Filtered: showing 3 of 40 rows — 37 hidden by 1 column filter')
    expect(filterIsDisclosable(summary)).toBe(true)
  })

  it('says every row is shown, and that the filter was not applied, for print', () => {
    const state = { filters, unreadable: [], preserved: [] }
    const summary = summarizeFilters(computeRowVisibility(rows, filters, columns), state, columns)
    expect(filterPrintNoticeText(summary)).toBe(
      'All 40 rows shown. 1 column filter active on screen was not applied here.',
    )
  })

  it('is not disclosable when nothing is filtered', () => {
    const state = { filters: [], unreadable: [], preserved: [] }
    const summary = summarizeFilters(computeRowVisibility(rows, [], columns), state, columns)
    expect(summary).toMatchObject({ shown: 40, total: 40, hidden: 0, activeColumnCount: 0 })
    expect(filterIsDisclosable(summary)).toBe(false)
  })

  it('is disclosable, and says so, when a stored filter could not be read', () => {
    const state = parseTableFilterState({
      filters: [{ columnId: 'price', conditions: [{ operator: 'matchesRegex', value: 'x' }] }],
    })
    const summary = summarizeFilters(computeRowVisibility(rows, state.filters, columns), state, columns)
    expect(filterIsDisclosable(summary)).toBe(true)
    expect(filterIndicatorText(summary)).toContain('could not be read by this build and is not applied')
  })

  it('is disclosable, and says so, when a filter names a deleted column', () => {
    const state = {
      filters: [{ columnId: 'gone', combinator: 'all' as const, conditions: [condition('isEmpty')] }],
      unreadable: [],
      preserved: [],
    }
    const summary = summarizeFilters(computeRowVisibility(rows, state.filters, columns), state, columns)
    expect(filterIsDisclosable(summary)).toBe(true)
    expect(filterIndicatorText(summary)).toContain('names a column that no longer exists')
  })

  it('describes a column filter in words for the chip and the menu', () => {
    expect(
      describeConditionsForLabel(
        { columnId: 'price', combinator: 'all', conditions: [condition('gt', '10'), condition('lte', '50')] },
        'number',
      ),
    ).toBe('is greater than 10 and is at most 50')
    expect(
      describeConditionsForLabel(
        { columnId: 'due', combinator: 'any', conditions: [condition('lt', '2026-01-01'), condition('isEmpty')] },
        'date',
      ),
    ).toBe('is before 2026-01-01 or is empty')
    expect(
      describeConditionsForLabel({ columnId: 'x', combinator: 'all', conditions: [condition('contains', '')] }, 'text'),
    ).toBe('No filter')
    expect(
      describeConditionsForLabel(
        { columnId: 'x', combinator: 'all', conditions: [condition('between', '1', '9')] },
        'number',
      ),
    ).toBe('is between 1 and 9')
  })
})
