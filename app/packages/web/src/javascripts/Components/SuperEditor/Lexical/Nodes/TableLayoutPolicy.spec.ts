import { $getRoot, createEditor, LexicalEditor, SerializedEditorState, SerializedLexicalNode } from 'lexical'
import {
  $createTableNodeWithDimensions,
  $deleteTableColumn,
  $insertTableColumnAtNode,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  $moveTableColumn,
  TableCellNode,
  TableNode,
  TableRowNode,
} from '@lexical/table'
import {
  $getTableColumnCount,
  $getTableColumnWidthPolicies,
  $getTableColumnWidthPolicy,
  $getTableHeaderSetting,
  $getTableWidthSetting,
  $resolveTableLayout,
  $setTableColumnWidthPolicy,
  $setTableHeadersDifferentiated,
  $setTableWidthMethod,
  applyResolvedTableLayoutToDom,
  DEFAULT_COLUMN_WIDTH_POLICY,
  DEFAULT_TABLE_WIDTH_METHOD,
  makeColumnWidthPolicy,
  MAX_COLUMN_WIDTH_PERCENT,
  MAX_COLUMN_WIDTH_PX,
  MIN_COLUMN_WIDTH_PX,
  parseTableColumnWidthPolicy,
  parseTableHeaderSetting,
  parseTableWidthSetting,
  resolveTableLayout,
  TABLE_HEADERS_ATTRIBUTE,
  TABLE_WIDTH_ATTRIBUTE,
  TABLE_WIDTH_METHODS,
} from './TableLayoutPolicy'

/* ------------------------------------------------------------------- parsing */

describe('parseTableWidthSetting', () => {
  it('defaults to fit-content when nothing is stored', () => {
    for (const absent of [undefined, null]) {
      expect(parseTableWidthSetting(absent)).toEqual({ method: 'content', unrecognised: false })
    }
    expect(DEFAULT_TABLE_WIDTH_METHOD).toBe('content')
  })

  it('accepts every known method', () => {
    for (const method of TABLE_WIDTH_METHODS) {
      expect(parseTableWidthSetting(method)).toEqual({ method, unrecognised: false })
    }
  })

  it('reports an unrecognised stored value as unrecognised rather than as a setting', () => {
    for (const malformed of ['percentage', '', 42, true, {}, [], { method: 'fixed' }]) {
      const parsed = parseTableWidthSetting(malformed)
      expect(parsed.unrecognised).toBe(true)
      expect(parsed.method).toBe('content')
      expect(parsed.raw).toEqual(malformed)
    }
  })
})

describe('parseTableHeaderSetting', () => {
  it('differentiates headers by default', () => {
    expect(parseTableHeaderSetting(undefined)).toEqual({ differentiated: true, unrecognised: false })
  })

  it('accepts both booleans', () => {
    expect(parseTableHeaderSetting(true).differentiated).toBe(true)
    expect(parseTableHeaderSetting(false).differentiated).toBe(false)
  })

  it('treats a non-boolean as unrecognised and keeps differentiating', () => {
    const parsed = parseTableHeaderSetting('off')
    expect(parsed).toEqual({ differentiated: true, unrecognised: true, raw: 'off' })
  })
})

describe('parseTableColumnWidthPolicy', () => {
  it('defaults to automatic', () => {
    expect(parseTableColumnWidthPolicy(undefined)).toEqual(DEFAULT_COLUMN_WIDTH_POLICY)
    expect(parseTableColumnWidthPolicy({ mode: 'auto' })).toEqual(DEFAULT_COLUMN_WIDTH_POLICY)
  })

  it('accepts a fixed px width and a percentage', () => {
    expect(parseTableColumnWidthPolicy({ mode: 'fixed', value: 160 })).toEqual({
      mode: 'fixed',
      value: 160,
      unrecognised: false,
      clamped: false,
    })
    expect(parseTableColumnWidthPolicy({ mode: 'percent', value: 25 })).toEqual({
      mode: 'percent',
      value: 25,
      unrecognised: false,
      clamped: false,
    })
  })

  it('clamps an out-of-range number and says it clamped', () => {
    expect(parseTableColumnWidthPolicy({ mode: 'fixed', value: 1e9 })).toEqual({
      mode: 'fixed',
      value: MAX_COLUMN_WIDTH_PX,
      unrecognised: false,
      clamped: true,
    })
    expect(parseTableColumnWidthPolicy({ mode: 'fixed', value: -5 })).toEqual({
      mode: 'fixed',
      value: MIN_COLUMN_WIDTH_PX,
      unrecognised: false,
      clamped: true,
    })
    expect(parseTableColumnWidthPolicy({ mode: 'percent', value: 500 })).toEqual({
      mode: 'percent',
      value: MAX_COLUMN_WIDTH_PERCENT,
      unrecognised: false,
      clamped: true,
    })
  })

  it('rounds a fractional width', () => {
    expect(parseTableColumnWidthPolicy({ mode: 'fixed', value: 160.4 }).value).toBe(160)
  })

  it('never throws and never renders a malformed value back out', () => {
    const malformed: unknown[] = [
      42,
      'fixed',
      true,
      [],
      [{ mode: 'fixed', value: 10 }],
      { mode: 'fixed' },
      { mode: 'fixed', value: 'wide' },
      { mode: 'fixed', value: NaN },
      { mode: 'nonsense', value: 10 },
      { value: 10 },
      {},
    ]
    for (const value of malformed) {
      const parsed = parseTableColumnWidthPolicy(value)
      expect(parsed.unrecognised).toBe(true)
      expect(parsed.mode).toBe('auto')
      expect(parsed.value).toBeUndefined()
    }
  })

  it('emits no CSS for an unrecognised policy, so nothing claims it was applied', () => {
    const layout = resolveTableLayout({
      width: parseTableWidthSetting('fixed'),
      headers: parseTableHeaderSetting(undefined),
      columns: [parseTableColumnWidthPolicy({ mode: 'nonsense', value: 10 })],
    })
    expect(layout.columnWidths).toEqual([null])
  })
})

describe('makeColumnWidthPolicy', () => {
  it('normalizes through the same parser the stored value goes through', () => {
    expect(makeColumnWidthPolicy('auto')).toEqual(DEFAULT_COLUMN_WIDTH_POLICY)
    expect(makeColumnWidthPolicy('fixed', 5)).toEqual({
      mode: 'fixed',
      value: MIN_COLUMN_WIDTH_PX,
      unrecognised: false,
      clamped: true,
    })
    expect(makeColumnWidthPolicy('percent', 33).value).toBe(33)
  })
})

/* ---------------------------------------------------------------- precedence */

describe('resolveTableLayout precedence', () => {
  const columns = [
    makeColumnWidthPolicy('fixed', 120),
    makeColumnWidthPolicy('percent', 40),
    makeColumnWidthPolicy('auto'),
  ]
  const headers = parseTableHeaderSetting(undefined)

  it('treats a column width as a hint under the auto-layout methods', () => {
    for (const method of ['content', 'full'] as const) {
      const layout = resolveTableLayout({ width: parseTableWidthSetting(method), headers, columns })
      expect(layout.columnHonouring).toBe('hint')
      expect(layout.columnWidths).toEqual(['120px', '40%', null])
      expect(layout.suspendedColumnPolicies).toBe(false)
    }
  })

  it('honours a column width exactly under the fixed method', () => {
    const layout = resolveTableLayout({ width: parseTableWidthSetting('fixed'), headers, columns })
    expect(layout.columnHonouring).toBe('exact')
    expect(layout.columnWidths).toEqual(['120px', '40%', null])
  })

  it('suspends every column policy under the equal method without erasing it', () => {
    const layout = resolveTableLayout({ width: parseTableWidthSetting('equal'), headers, columns })
    expect(layout.columnHonouring).toBe('suspended')
    expect(layout.columnWidths).toEqual([null, null, null])
    expect(layout.suspendedColumnPolicies).toBe(true)
    // The policies themselves are untouched, so switching method restores them.
    expect(columns[0]).toEqual({ mode: 'fixed', value: 120, unrecognised: false, clamped: false })
  })

  it('does not report suspension when there is nothing to suspend', () => {
    const layout = resolveTableLayout({
      width: parseTableWidthSetting('equal'),
      headers,
      columns: [makeColumnWidthPolicy('auto')],
    })
    expect(layout.suspendedColumnPolicies).toBe(false)
  })

  it('maps header differentiation onto the attribute, absent when differentiated', () => {
    expect(
      resolveTableLayout({ width: parseTableWidthSetting(undefined), headers, columns }).headerAttribute,
    ).toBeNull()
    expect(
      resolveTableLayout({ width: parseTableWidthSetting(undefined), headers: parseTableHeaderSetting(false), columns })
        .headerAttribute,
    ).toBe('plain')
  })
})

/* --------------------------------------------------------- DOM application */

describe('applyResolvedTableLayoutToDom', () => {
  const buildTable = (columnCount: number) => {
    const wrapper = document.createElement('div')
    const table = document.createElement('table')
    const colgroup = document.createElement('colgroup')
    for (let i = 0; i < columnCount; i++) {
      colgroup.appendChild(document.createElement('col'))
    }
    table.appendChild(colgroup)
    wrapper.appendChild(table)
    return { wrapper, table, colgroup }
  }

  it('writes the width attribute onto both the scroll wrapper and the table', () => {
    const { wrapper, table } = buildTable(2)
    applyResolvedTableLayoutToDom(wrapper, {
      method: 'full',
      widthAttribute: 'full',
      headerAttribute: null,
      columnWidths: [null, null],
      columnHonouring: 'hint',
      suspendedColumnPolicies: false,
      differentiatedHeaders: true,
    })
    expect(wrapper.getAttribute(TABLE_WIDTH_ATTRIBUTE)).toBe('full')
    expect(table.getAttribute(TABLE_WIDTH_ATTRIBUTE)).toBe('full')
    expect(wrapper.hasAttribute(TABLE_HEADERS_ATTRIBUTE)).toBe(false)
  })

  it('marks plain headers and clears the mark again when re-differentiated', () => {
    const { wrapper, table } = buildTable(1)
    const base = {
      method: 'content',
      widthAttribute: 'content',
      columnWidths: [null],
      columnHonouring: 'hint',
      suspendedColumnPolicies: false,
    } as const
    applyResolvedTableLayoutToDom(wrapper, { ...base, headerAttribute: 'plain', differentiatedHeaders: false })
    expect(table.getAttribute(TABLE_HEADERS_ATTRIBUTE)).toBe('plain')
    applyResolvedTableLayoutToDom(wrapper, { ...base, headerAttribute: null, differentiatedHeaders: true })
    expect(table.hasAttribute(TABLE_HEADERS_ATTRIBUTE)).toBe(false)
  })

  it('writes per-column widths onto the colgroup and leaves automatic columns alone', () => {
    const { wrapper, colgroup } = buildTable(3)
    const cols = Array.from(colgroup.querySelectorAll('col'))
    cols[2].style.width = '90px'
    applyResolvedTableLayoutToDom(wrapper, {
      method: 'fixed',
      widthAttribute: 'fixed',
      headerAttribute: null,
      columnWidths: ['120px', '40%', null],
      columnHonouring: 'exact',
      suspendedColumnPolicies: false,
      differentiatedHeaders: true,
    })
    expect(cols[0].style.width).toBe('120px')
    expect(cols[1].style.width).toBe('40%')
    // Column 2 is automatic, so a width the column resizer wrote survives.
    expect(cols[2].style.width).toBe('90px')
  })

  it('tolerates a bare table with no wrapper, and a null element', () => {
    const table = document.createElement('table')
    expect(() =>
      applyResolvedTableLayoutToDom(table, {
        method: 'equal',
        widthAttribute: 'equal',
        headerAttribute: null,
        columnWidths: [],
        columnHonouring: 'suspended',
        suspendedColumnPolicies: false,
        differentiatedHeaders: true,
      }),
    ).not.toThrow()
    expect(table.getAttribute(TABLE_WIDTH_ATTRIBUTE)).toBe('equal')
    expect(() =>
      applyResolvedTableLayoutToDom(null, {
        method: 'equal',
        widthAttribute: 'equal',
        headerAttribute: null,
        columnWidths: [],
        columnHonouring: 'suspended',
        suspendedColumnPolicies: false,
        differentiatedHeaders: true,
      }),
    ).not.toThrow()
  })
})

/* ----------------------------------------------- node state on a live editor */

const makeEditor = (): LexicalEditor =>
  createEditor({
    namespace: 'table-layout-policy-test',
    nodes: [TableNode, TableRowNode, TableCellNode],
    onError: (error) => {
      throw error
    },
  })

const withTable = <T>(editor: LexicalEditor, run: (table: TableNode) => T): T => {
  let result!: T
  editor.update(
    () => {
      const table = $getRoot()
        .getChildren()
        .find((child): child is TableNode => $isTableNode(child))
      if (table === undefined) {
        throw new Error('expected a table')
      }
      result = run(table)
    },
    { discrete: true },
  )
  return result
}

/** The cell node at a (row, column) coordinate of a simple unmerged table. */
const cellAt = (table: TableNode, row: number, column: number): TableCellNode => {
  const rowNode = table.getChildren()[row]
  if (!$isTableRowNode(rowNode)) {
    throw new Error(`no row ${row}`)
  }
  const cell = rowNode.getChildren()[column]
  if (!$isTableCellNode(cell)) {
    throw new Error(`no cell ${row},${column}`)
  }
  return cell
}

const seedTable = (editor: LexicalEditor, rows: number, columns: number): void => {
  editor.update(
    () => {
      $getRoot()
        .clear()
        .append($createTableNodeWithDimensions(rows, columns, true))
    },
    { discrete: true },
  )
}

const findSerializedTable = (state: SerializedEditorState): SerializedLexicalNode & Record<string, unknown> => {
  const walk = (node: SerializedLexicalNode): (SerializedLexicalNode & Record<string, unknown>) | null => {
    if (node.type === 'table') {
      return node as SerializedLexicalNode & Record<string, unknown>
    }
    const children = (node as { children?: SerializedLexicalNode[] }).children
    for (const child of children ?? []) {
      const found = walk(child)
      if (found !== null) {
        return found
      }
    }
    return null
  }
  const found = walk(state.root as unknown as SerializedLexicalNode)
  if (found === null) {
    throw new Error('no serialized table found')
  }
  return found
}

describe('table-level layout state', () => {
  it('defaults to fit-content with differentiated headers and serializes nothing', () => {
    const editor = makeEditor()
    seedTable(editor, 2, 3)
    const read = withTable(editor, (table) => ({
      width: $getTableWidthSetting(table),
      headers: $getTableHeaderSetting(table),
    }))
    expect(read.width.method).toBe('content')
    expect(read.headers.differentiated).toBe(true)
    expect(findSerializedTable(editor.getEditorState().toJSON()).$).toBeUndefined()
  })

  it('round-trips a width method and a plain-header flag through serialization', () => {
    const editor = makeEditor()
    seedTable(editor, 2, 3)
    withTable(editor, (table) => {
      $setTableWidthMethod(table, 'fixed')
      $setTableHeadersDifferentiated(table, false)
    })

    const json = editor.getEditorState().toJSON()
    expect(findSerializedTable(json).$).toEqual({ superTableWidth: 'fixed', superTableHeaders: false })

    const reloaded = makeEditor()
    reloaded.setEditorState(reloaded.parseEditorState(JSON.stringify(json)))
    const read = withTable(reloaded, (table) => ({
      width: $getTableWidthSetting(table),
      headers: $getTableHeaderSetting(table),
    }))
    expect(read.width).toEqual({ method: 'fixed', unrecognised: false })
    expect(read.headers.differentiated).toBe(false)
  })

  it('reads a malformed stored method as unrecognised, applies the default, and keeps the raw value', () => {
    const editor = makeEditor()
    seedTable(editor, 2, 2)
    const json = editor.getEditorState().toJSON()
    const table = findSerializedTable(json)
    table.$ = { superTableWidth: 'percentage-of-page', superTableHeaders: 'yes' }

    const reloaded = makeEditor()
    reloaded.setEditorState(reloaded.parseEditorState(JSON.stringify(json)))
    const read = withTable(reloaded, (t) => ({
      width: $getTableWidthSetting(t),
      headers: $getTableHeaderSetting(t),
      layout: $resolveTableLayout(t),
    }))

    expect(read.width).toEqual({ method: 'content', unrecognised: true, raw: 'percentage-of-page' })
    expect(read.headers).toEqual({ differentiated: true, unrecognised: true, raw: 'yes' })
    // The default is what gets applied; the unrecognised value is never rendered.
    expect(read.layout.widthAttribute).toBe('content')
    expect(read.layout.headerAttribute).toBeNull()
    // And it is preserved verbatim, so a build that understands it still finds it.
    expect(findSerializedTable(reloaded.getEditorState().toJSON()).$).toEqual({
      superTableWidth: 'percentage-of-page',
      superTableHeaders: 'yes',
    })
  })
})

describe('per-column width policies are keyed by cell, not by index', () => {
  it('stores and reads one column without disturbing its neighbours', () => {
    const editor = makeEditor()
    seedTable(editor, 3, 3)
    withTable(editor, (table) => $setTableColumnWidthPolicy(table, 1, makeColumnWidthPolicy('fixed', 150)))
    const policies = withTable(editor, (table) => $getTableColumnWidthPolicies(table))
    expect(policies.map((p) => p.mode)).toEqual(['auto', 'fixed', 'auto'])
    expect(policies[1].value).toBe(150)
  })

  it('keeps the policy on its own column after a column is inserted to its LEFT', () => {
    const editor = makeEditor()
    seedTable(editor, 3, 3)
    withTable(editor, (table) => $setTableColumnWidthPolicy(table, 1, makeColumnWidthPolicy('fixed', 150)))

    withTable(editor, (table) => {
      $insertTableColumnAtNode(cellAt(table, 0, 0), false, false)
    })

    const policies = withTable(editor, (table) => $getTableColumnWidthPolicies(table))
    expect(withTable(editor, (table) => $getTableColumnCount(table))).toBe(4)
    // An index-keyed policy would still be reading column 1 here.
    expect(policies.map((p) => p.mode)).toEqual(['auto', 'auto', 'fixed', 'auto'])
    expect(policies[2].value).toBe(150)
  })

  it('drops only the deleted column, leaving the others where they are', () => {
    const editor = makeEditor()
    seedTable(editor, 3, 4)
    withTable(editor, (table) => {
      $setTableColumnWidthPolicy(table, 1, makeColumnWidthPolicy('fixed', 150))
      $setTableColumnWidthPolicy(table, 3, makeColumnWidthPolicy('percent', 20))
    })

    withTable(editor, (table) => {
      $deleteTableColumn(table, 1)
    })

    const policies = withTable(editor, (table) => $getTableColumnWidthPolicies(table))
    expect(policies.map((p) => p.mode)).toEqual(['auto', 'auto', 'percent'])
    expect(policies[2].value).toBe(20)
  })

  it('follows the column when the column is moved', () => {
    const editor = makeEditor()
    seedTable(editor, 3, 3)
    withTable(editor, (table) => $setTableColumnWidthPolicy(table, 0, makeColumnWidthPolicy('percent', 60)))

    withTable(editor, (table) => {
      $moveTableColumn(table, 0, 2)
    })

    const policies = withTable(editor, (table) => $getTableColumnWidthPolicies(table))
    expect(policies.map((p) => p.mode)).toEqual(['auto', 'auto', 'percent'])
    expect(policies[2].value).toBe(60)
  })

  it('survives deletion of the top row, because every row carries the policy', () => {
    const editor = makeEditor()
    seedTable(editor, 3, 2)
    withTable(editor, (table) => $setTableColumnWidthPolicy(table, 1, makeColumnWidthPolicy('fixed', 200)))

    withTable(editor, (table) => {
      table.getChildren()[0].remove()
    })

    expect(withTable(editor, (table) => $getTableColumnWidthPolicy(table, 1).value)).toBe(200)
  })

  it('round-trips per-column policies through serialization', () => {
    const editor = makeEditor()
    seedTable(editor, 2, 2)
    withTable(editor, (table) => $setTableColumnWidthPolicy(table, 0, makeColumnWidthPolicy('percent', 70)))

    const json = JSON.stringify(editor.getEditorState().toJSON())
    const reloaded = makeEditor()
    reloaded.setEditorState(reloaded.parseEditorState(json))

    const policies = withTable(reloaded, (table) => $getTableColumnWidthPolicies(table))
    expect(policies[0]).toEqual({ mode: 'percent', value: 70, unrecognised: false, clamped: false })
    expect(policies[1].mode).toBe('auto')
  })

  it('does not throw and applies nothing when a stored column policy is malformed', () => {
    const editor = makeEditor()
    seedTable(editor, 2, 2)
    const json = editor.getEditorState().toJSON()
    const table = findSerializedTable(json)
    const firstRow = (table.children as { children: Record<string, unknown>[] }[])[0]
    firstRow.children[0].$ = { superColumnWidth: { mode: 'ems', value: 12 } }

    const reloaded = makeEditor()
    expect(() => reloaded.setEditorState(reloaded.parseEditorState(JSON.stringify(json)))).not.toThrow()
    const resolved = withTable(reloaded, (t) => ({
      policy: $getTableColumnWidthPolicy(t, 0),
      layout: $resolveTableLayout(t),
    }))
    expect(resolved.policy.unrecognised).toBe(true)
    expect(resolved.policy.mode).toBe('auto')
    expect(resolved.layout.columnWidths[0]).toBeNull()
  })
})

describe('$resolveTableLayout', () => {
  it('combines table method, header flag and column policies', () => {
    const editor = makeEditor()
    seedTable(editor, 2, 3)
    const layout = withTable(editor, (table) => {
      $setTableWidthMethod(table, 'fixed')
      $setTableHeadersDifferentiated(table, false)
      $setTableColumnWidthPolicy(table, 0, makeColumnWidthPolicy('fixed', 90))
      $setTableColumnWidthPolicy(table, 2, makeColumnWidthPolicy('percent', 30))
      return $resolveTableLayout(table)
    })
    expect(layout.method).toBe('fixed')
    expect(layout.headerAttribute).toBe('plain')
    expect(layout.columnWidths).toEqual(['90px', null, '30%'])
    expect(layout.columnHonouring).toBe('exact')
  })

  it('reports suspension when the equal method is chosen over real column policies', () => {
    const editor = makeEditor()
    seedTable(editor, 2, 2)
    const layout = withTable(editor, (table) => {
      $setTableColumnWidthPolicy(table, 0, makeColumnWidthPolicy('fixed', 90))
      $setTableWidthMethod(table, 'equal')
      return $resolveTableLayout(table)
    })
    expect(layout.suspendedColumnPolicies).toBe(true)
    expect(layout.columnWidths).toEqual([null, null])
  })
})
