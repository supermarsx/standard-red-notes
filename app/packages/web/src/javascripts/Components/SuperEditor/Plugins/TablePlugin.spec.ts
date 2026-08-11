import {
  $createTableNodeWithDimensions,
  setScrollableTablesActive,
  TableCellNode,
  TableNode,
  TableRowNode,
} from '@lexical/table'
import { $getRoot, createEditor } from 'lexical'
import {
  clampTableDimension,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  MIN_TABLE_COLUMNS,
  MIN_TABLE_ROWS,
  parseTableDimension,
  markTableWidgetLayout,
  SUPER_WIDGET_LAYOUT_ATTRIBUTE,
} from './TablePlugin'

describe('table widget layout marker', () => {
  it('marks only the supplied Lexical table wrapper as a data widget', () => {
    const wrapper = document.createElement('div')

    markTableWidgetLayout(wrapper)
    markTableWidgetLayout(null)

    expect(wrapper.getAttribute(SUPER_WIDGET_LAYOUT_ATTRIBUTE)).toBe('data')
  })

  it('marks the actual horizontal-scroll wrapper rendered for an ordinary two-column table', () => {
    const editor = createEditor({
      namespace: 'table-widget-layout-test',
      nodes: [TableNode, TableRowNode, TableCellNode],
      theme: {
        table: 'Lexical__table',
        tableScrollableWrapper: 'Lexical__tableScrollableWrapper',
      },
      onError: (error) => {
        throw error
      },
    })
    const root = document.createElement('div')
    document.body.append(root)
    editor.setRootElement(root)
    setScrollableTablesActive(editor, true)

    try {
      let tableKey = ''
      editor.update(
        () => {
          const table = $createTableNodeWithDimensions(2, 2, true)
          tableKey = table.getKey()
          $getRoot().append(table)
        },
        { discrete: true },
      )

      const wrapper = editor.getElementByKey(tableKey)
      expect(wrapper).toBeInstanceOf(HTMLDivElement)
      expect(wrapper?.classList.contains('Lexical__tableScrollableWrapper')).toBe(true)
      const table = wrapper?.querySelector(':scope > table.Lexical__table')
      expect(table).toBeInstanceOf(HTMLTableElement)
      expect(table?.querySelectorAll('tr')).toHaveLength(2)
      expect(table?.querySelectorAll('th, td')).toHaveLength(4)

      markTableWidgetLayout(wrapper)

      expect(wrapper?.getAttribute(SUPER_WIDGET_LAYOUT_ATTRIBUTE)).toBe('data')
    } finally {
      setScrollableTablesActive(editor, false)
      editor.setRootElement(null)
      root.remove()
    }
  })
})

describe('parseTableDimension', () => {
  it('accepts whole numbers within the inclusive range', () => {
    expect(parseTableDimension('1', MIN_TABLE_COLUMNS, MAX_TABLE_COLUMNS)).toEqual({ value: 1, isValid: true })
    expect(parseTableDimension('63', MIN_TABLE_COLUMNS, MAX_TABLE_COLUMNS)).toEqual({ value: 63, isValid: true })
    expect(parseTableDimension('1000', MIN_TABLE_ROWS, MAX_TABLE_ROWS)).toEqual({ value: 1000, isValid: true })
  })

  it('trims surrounding whitespace', () => {
    expect(parseTableDimension(' 5 ', MIN_TABLE_COLUMNS, MAX_TABLE_COLUMNS)).toEqual({ value: 5, isValid: true })
  })

  it('rejects values above the maximum', () => {
    expect(parseTableDimension('64', MIN_TABLE_COLUMNS, MAX_TABLE_COLUMNS).isValid).toBe(false)
    expect(parseTableDimension('1001', MIN_TABLE_ROWS, MAX_TABLE_ROWS).isValid).toBe(false)
  })

  it('rejects values below the minimum', () => {
    expect(parseTableDimension('0', MIN_TABLE_COLUMNS, MAX_TABLE_COLUMNS).isValid).toBe(false)
  })

  it('rejects empty, non-numeric, decimal, negative and scientific input', () => {
    expect(parseTableDimension('', MIN_TABLE_COLUMNS, MAX_TABLE_COLUMNS).isValid).toBe(false)
    expect(parseTableDimension('abc', MIN_TABLE_COLUMNS, MAX_TABLE_COLUMNS).isValid).toBe(false)
    expect(parseTableDimension('2.5', MIN_TABLE_COLUMNS, MAX_TABLE_COLUMNS).isValid).toBe(false)
    expect(parseTableDimension('-3', MIN_TABLE_COLUMNS, MAX_TABLE_COLUMNS).isValid).toBe(false)
    expect(parseTableDimension('1e3', MIN_TABLE_ROWS, MAX_TABLE_ROWS).isValid).toBe(false)
  })
})

describe('clampTableDimension', () => {
  it('clamps values into the inclusive range', () => {
    expect(clampTableDimension(100, MIN_TABLE_COLUMNS, MAX_TABLE_COLUMNS)).toBe(MAX_TABLE_COLUMNS)
    expect(clampTableDimension(0, MIN_TABLE_COLUMNS, MAX_TABLE_COLUMNS)).toBe(MIN_TABLE_COLUMNS)
    expect(clampTableDimension(10, MIN_TABLE_COLUMNS, MAX_TABLE_COLUMNS)).toBe(10)
  })

  it('rounds fractional values', () => {
    expect(clampTableDimension(3.6, MIN_TABLE_COLUMNS, MAX_TABLE_COLUMNS)).toBe(4)
  })

  it('falls back to the minimum for non-finite values', () => {
    expect(clampTableDimension(NaN, MIN_TABLE_ROWS, MAX_TABLE_ROWS)).toBe(MIN_TABLE_ROWS)
    expect(clampTableDimension(Infinity, MIN_TABLE_ROWS, MAX_TABLE_ROWS)).toBe(MIN_TABLE_ROWS)
  })
})
