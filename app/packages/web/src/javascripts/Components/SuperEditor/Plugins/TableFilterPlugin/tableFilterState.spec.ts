/**
 * Column identity, persistence and the no-mutation guarantee.
 *
 * THE DEFECT THIS FILE EXISTS TO PREVENT: an index-keyed filter silently
 * attaching to the wrong column after a column is inserted, deleted or moved.
 * The proofs below insert, delete and move real columns through the real
 * `@lexical/table` APIs and assert the filter still names the column whose cells
 * it was set on, that the filtered row set is unchanged, and that no row text
 * changed anywhere along the way.
 */

import { createHeadlessEditor } from '@lexical/headless'
import {
  $createTableNodeWithDimensions,
  $deleteTableColumn,
  $insertTableColumnAtNode,
  $isTableCellNode,
  $isTableRowNode,
  $moveTableColumn,
  TableCellNode,
  TableNode,
  TableRowNode,
} from '@lexical/table'
import { $getRoot, $createTextNode, $getState, LexicalEditor, SerializedEditorState } from 'lexical'

import { ColumnFilter, FilterCondition } from './tableFilterModel'
import {
  $clearTableFilters,
  $ensureColumnId,
  $getTableFilterState,
  $projectTableFilters,
  $readColumnId,
  $readTableGrid,
  $setTableColumnFilter,
  TABLE_FILTER_COLUMN_ID_STATE_KEY,
  TABLE_FILTERS_STATE_KEY,
  tableFilterColumnIdState,
} from './tableFilterState'

const makeEditor = (): LexicalEditor =>
  createHeadlessEditor({
    namespace: 'TableFilterStateSpec',
    nodes: [TableNode, TableRowNode, TableCellNode],
    onError: (error) => {
      throw error
    },
  })

const condition = (operator: FilterCondition['operator'], value = '', value2 = ''): FilterCondition => ({
  operator,
  value,
  value2,
})

/** header row + three body rows, four columns. */
const GRID: string[][] = [
  ['Name', 'Price', 'Due', 'Open'],
  ['Apple', '10', '2026-01-05', 'yes'],
  ['Banana', '40', '2026-06-05', 'no'],
  ['Cherry', '5', '2026-03-05', 'yes'],
]

const $seed = (): TableNode => {
  const root = $getRoot()
  root.clear()
  const table = $createTableNodeWithDimensions(GRID.length, GRID[0].length, true)
  root.append(table)
  table.getChildren().forEach((row, rowIndex) => {
    if (!$isTableRowNode(row)) {
      return
    }
    row.getChildren().forEach((cell, columnIndex) => {
      if (!$isTableCellNode(cell)) {
        return
      }
      const paragraph = cell.getFirstChild()
      if (paragraph !== null && 'append' in paragraph) {
        ;(paragraph as unknown as { append: (node: ReturnType<typeof $createTextNode>) => void }).append(
          $createTextNode(GRID[rowIndex][columnIndex]),
        )
      }
    })
  })
  return table
}

const readTexts = (editor: LexicalEditor): string[][] =>
  editor.getEditorState().read(() => {
    const table = $getRoot().getFirstChild() as TableNode
    return table
      .getChildren()
      .filter($isTableRowNode)
      .map((row) =>
        row
          .getChildren()
          .filter($isTableCellNode)
          .map((cell) => cell.getTextContent()),
      )
  })

/**
 * The visible body values of the column with this HEADER LABEL. Resolving the
 * column by label rather than by position is deliberate: a fixture that read
 * `values[0]` would keep passing after a column insert or move while silently
 * comparing a different column, which is the very confusion under test.
 */
const visibleRowValues = (editor: LexicalEditor, headerLabel: string): string[] =>
  editor.getEditorState().read(() => {
    const table = $getRoot().getFirstChild() as TableNode
    const projection = $projectTableFilters(table)
    const columnIndex = projection.columns.findIndex((column) => column.label === headerLabel)
    if (columnIndex < 0) {
      throw new Error(`This table has no column labelled "${headerLabel}"`)
    }
    return projection.bodyRows.filter((_, index) => projection.visibility[index]).map((row) => row.values[columnIndex])
  })

/** Set a filter on the column that currently sits at `columnIndex`. */
const setFilterAtColumn = (editor: LexicalEditor, columnIndex: number, filter: Omit<ColumnFilter, 'columnId'>) => {
  let columnId: string | null = null
  editor.update(
    () => {
      const table = $getRoot().getFirstChild() as TableNode
      columnId = $ensureColumnId($readTableGrid(table), columnIndex)
      if (columnId !== null) {
        $setTableColumnFilter(table, columnId, filter)
      }
    },
    { discrete: true },
  )
  return columnId
}

describe('column identity', () => {
  it('mints an id once and writes it to every cell that starts the column', () => {
    const editor = makeEditor()
    editor.update($seed, { discrete: true })

    const columnId = setFilterAtColumn(editor, 1, { combinator: 'all', conditions: [condition('lt', '30')] })
    expect(columnId).toMatch(/^tf-/)

    editor.getEditorState().read(() => {
      const table = $getRoot().getFirstChild() as TableNode
      const rows = table.getChildren().filter($isTableRowNode)
      for (const row of rows) {
        const cell = row.getChildren().filter($isTableCellNode)[1]
        expect($getState(cell, tableFilterColumnIdState)).toBe(columnId)
      }
      // Only that column was marked.
      for (const row of rows) {
        const cell = row.getChildren().filter($isTableCellNode)[0]
        expect($getState(cell, tableFilterColumnIdState)).toBeNull()
      }
    })
  })

  it('is stable: a second read mints nothing new', () => {
    const editor = makeEditor()
    editor.update($seed, { discrete: true })
    const first = setFilterAtColumn(editor, 1, { combinator: 'all', conditions: [condition('lt', '30')] })
    const second = editor.getEditorState().read(() => {
      const table = $getRoot().getFirstChild() as TableNode
      return $readColumnId($readTableGrid(table), 1)
    })
    expect(second).toBe(first)
  })

  it('survives deleting the header row, because every cell declares it', () => {
    const editor = makeEditor()
    editor.update($seed, { discrete: true })
    const columnId = setFilterAtColumn(editor, 1, { combinator: 'all', conditions: [condition('lt', '30')] })

    editor.update(
      () => {
        const table = $getRoot().getFirstChild() as TableNode
        table.getChildren().filter($isTableRowNode)[0].remove()
      },
      { discrete: true },
    )

    editor.getEditorState().read(() => {
      const table = $getRoot().getFirstChild() as TableNode
      expect($readColumnId($readTableGrid(table), 1)).toBe(columnId)
    })
  })
})

describe('a filter keeps naming its own column through structural edits', () => {
  it('after a column is INSERTED to its left', () => {
    const editor = makeEditor()
    editor.update($seed, { discrete: true })
    // Price < 30 keeps Apple and Cherry.
    const columnId = setFilterAtColumn(editor, 1, { combinator: 'all', conditions: [condition('lt', '30')] })
    expect(visibleRowValues(editor, 'Name')).toEqual(['Apple', 'Cherry'])

    editor.update(
      () => {
        const table = $getRoot().getFirstChild() as TableNode
        const firstRow = table.getChildren().filter($isTableRowNode)[0]
        const firstCell = firstRow.getChildren().filter($isTableCellNode)[0]
        $insertTableColumnAtNode(firstCell, false, false)
      },
      { discrete: true },
    )

    editor.getEditorState().read(() => {
      const table = $getRoot().getFirstChild() as TableNode
      const grid = $readTableGrid(table)
      // The inserted column is brand new and carries no id at all.
      expect($readColumnId(grid, 0)).toBeNull()
      // Price moved from index 1 to index 2 and kept its id.
      expect($readColumnId(grid, 2)).toBe(columnId)
      expect($getTableFilterState(table).filters.map((filter) => filter.columnId)).toEqual([columnId])
    })

    // The SAME rows are still hidden. An index-keyed filter would now be
    // filtering Name, which would show every row (no name is < 30).
    expect(visibleRowValues(editor, 'Name')).toEqual(['Apple', 'Cherry'])
  })

  it('after a DIFFERENT column is deleted', () => {
    const editor = makeEditor()
    editor.update($seed, { discrete: true })
    const columnId = setFilterAtColumn(editor, 1, { combinator: 'all', conditions: [condition('lt', '30')] })
    expect(visibleRowValues(editor, 'Name')).toEqual(['Apple', 'Cherry'])

    editor.update(
      () => {
        $deleteTableColumn($getRoot().getFirstChild() as TableNode, 0)
      },
      { discrete: true },
    )

    editor.getEditorState().read(() => {
      const table = $getRoot().getFirstChild() as TableNode
      expect($readColumnId($readTableGrid(table), 0)).toBe(columnId)
    })
    expect(visibleRowValues(editor, 'Price')).toEqual(['10', '5'])
  })

  it('after its OWN column is deleted: the filter stops applying and is reported stale', () => {
    const editor = makeEditor()
    editor.update($seed, { discrete: true })
    setFilterAtColumn(editor, 1, { combinator: 'all', conditions: [condition('lt', '30')] })

    editor.update(
      () => {
        $deleteTableColumn($getRoot().getFirstChild() as TableNode, 1)
      },
      { discrete: true },
    )

    editor.getEditorState().read(() => {
      const table = $getRoot().getFirstChild() as TableNode
      const projection = $projectTableFilters(table)
      expect(projection.visibility).toEqual([true, true, true])
      expect(projection.summary.staleColumnCount).toBe(1)
      expect(projection.summary.activeColumnCount).toBe(0)
    })
  })

  it('after its column is MOVED', () => {
    const editor = makeEditor()
    editor.update($seed, { discrete: true })
    const columnId = setFilterAtColumn(editor, 1, { combinator: 'all', conditions: [condition('lt', '30')] })
    expect(visibleRowValues(editor, 'Name')).toEqual(['Apple', 'Cherry'])

    editor.update(
      () => {
        $moveTableColumn($getRoot().getFirstChild() as TableNode, 1, 3)
      },
      { discrete: true },
    )

    const texts = readTexts(editor)
    expect(texts[0]).toEqual(['Name', 'Due', 'Open', 'Price'])

    editor.getEditorState().read(() => {
      const table = $getRoot().getFirstChild() as TableNode
      const grid = $readTableGrid(table)
      expect($readColumnId(grid, 3)).toBe(columnId)
      expect($readColumnId(grid, 1)).toBeNull()
    })
    expect(visibleRowValues(editor, 'Name')).toEqual(['Apple', 'Cherry'])
  })

  it('does not disturb a second column filter when the first column moves', () => {
    const editor = makeEditor()
    editor.update($seed, { discrete: true })
    const priceId = setFilterAtColumn(editor, 1, { combinator: 'all', conditions: [condition('lt', '30')] })
    const openId = setFilterAtColumn(editor, 3, { combinator: 'all', conditions: [condition('isTrue')] })
    expect(visibleRowValues(editor, 'Name')).toEqual(['Apple', 'Cherry'])

    editor.update(
      () => {
        $moveTableColumn($getRoot().getFirstChild() as TableNode, 3, 0)
      },
      { discrete: true },
    )

    editor.getEditorState().read(() => {
      const grid = $readTableGrid($getRoot().getFirstChild() as TableNode)
      expect($readColumnId(grid, 0)).toBe(openId)
      expect($readColumnId(grid, 2)).toBe(priceId)
    })
    expect(visibleRowValues(editor, 'Name')).toEqual(['Apple', 'Cherry'])
  })
})

describe('filtering never mutates the document', () => {
  it('leaves every row, in order, with its text intact', () => {
    const editor = makeEditor()
    editor.update($seed, { discrete: true })
    const before = readTexts(editor)

    setFilterAtColumn(editor, 1, { combinator: 'all', conditions: [condition('lt', '30')] })
    expect(readTexts(editor)).toEqual(before)

    editor.update(
      () => {
        $clearTableFilters($getRoot().getFirstChild() as TableNode)
      },
      { discrete: true },
    )
    expect(readTexts(editor)).toEqual(before)
    expect(visibleRowValues(editor, 'Name')).toEqual(['Apple', 'Banana', 'Cherry'])
  })

  it('hides rows only in the projection, never in the node tree', () => {
    const editor = makeEditor()
    editor.update($seed, { discrete: true })
    setFilterAtColumn(editor, 1, { combinator: 'all', conditions: [condition('lt', '30')] })

    editor.getEditorState().read(() => {
      const projection = $projectTableFilters($getRoot().getFirstChild() as TableNode)
      expect(projection.bodyRows).toHaveLength(3)
      expect(projection.visibility).toEqual([true, false, true])
      expect(projection.summary).toMatchObject({ shown: 2, total: 3, hidden: 1, activeColumnCount: 1 })
    })
  })
})

describe('persistence', () => {
  const serialize = (editor: LexicalEditor): SerializedEditorState => editor.getEditorState().toJSON()

  const reload = (serialized: SerializedEditorState): LexicalEditor => {
    const next = makeEditor()
    next.setEditorState(next.parseEditorState(serialized))
    return next
  }

  it('round-trips through serialization on the STOCK node types, under the "$" key', () => {
    const editor = makeEditor()
    editor.update($seed, { discrete: true })
    const columnId = setFilterAtColumn(editor, 1, { combinator: 'any', conditions: [condition('lt', '30')] })

    const serialized = serialize(editor)
    const table = (serialized.root.children as Array<Record<string, unknown>>)[0]
    expect(table.type).toBe('table')
    const tableState = table.$ as Record<string, unknown>
    expect(tableState).toBeDefined()
    expect(tableState[TABLE_FILTERS_STATE_KEY]).toEqual({
      filters: [{ columnId, combinator: 'any', conditions: [{ operator: 'lt', value: '30', value2: '' }] }],
    })

    const firstRow = (table.children as Array<Record<string, unknown>>)[0]
    const secondCell = (firstRow.children as Array<Record<string, unknown>>)[1]
    expect(secondCell.type).toBe('tablecell')
    expect((secondCell.$ as Record<string, unknown>)[TABLE_FILTER_COLUMN_ID_STATE_KEY]).toBe(columnId)

    const reloaded = reload(serialized)
    expect(visibleRowValues(reloaded, 'Name')).toEqual(['Apple', 'Cherry'])
  })

  it('serializes nothing at all when no filter has ever been set', () => {
    const editor = makeEditor()
    editor.update($seed, { discrete: true })
    const table = (serialize(editor).root.children as Array<Record<string, unknown>>)[0]
    const tableState = (table.$ ?? {}) as Record<string, unknown>
    expect(tableState[TABLE_FILTERS_STATE_KEY]).toBeUndefined()
  })

  it('leaves another build’s unknown node-state keys untouched', () => {
    const editor = makeEditor()
    editor.update($seed, { discrete: true })
    setFilterAtColumn(editor, 1, { combinator: 'all', conditions: [condition('lt', '30')] })

    const serialized = serialize(editor) as unknown as {
      root: { children: Array<Record<string, unknown>> }
    }
    const table = serialized.root.children[0]
    ;(table.$ as Record<string, unknown>).someFutureSetting = { rows: 'striped' }

    const reloaded = reload(serialized as unknown as SerializedEditorState)
    reloaded.update(
      () => {
        const node = $getRoot().getFirstChild() as TableNode
        const grid = $readTableGrid(node)
        const columnId = $ensureColumnId(grid, 0)
        if (columnId !== null) {
          $setTableColumnFilter(node, columnId, { combinator: 'all', conditions: [condition('contains', 'a')] })
        }
      },
      { discrete: true },
    )

    const again = reloaded.getEditorState().toJSON() as unknown as {
      root: { children: Array<Record<string, unknown>> }
    }
    expect((again.root.children[0].$ as Record<string, unknown>).someFutureSetting).toEqual({ rows: 'striped' })
  })

  it('writes an unreadable foreign filter back verbatim instead of deleting it', () => {
    const editor = makeEditor()
    editor.update($seed, { discrete: true })
    const priceId = setFilterAtColumn(editor, 1, { combinator: 'all', conditions: [condition('lt', '30')] })

    const serialized = serialize(editor) as unknown as {
      root: { children: Array<Record<string, unknown>> }
    }
    const foreign = { columnId: 'written-by-a-newer-build', conditions: [{ operator: 'matchesRegex', value: '^A' }] }
    const stored = (serialized.root.children[0].$ as Record<string, { filters: unknown[] }>)[TABLE_FILTERS_STATE_KEY]
    stored.filters.push(foreign)

    const reloaded = reload(serialized as unknown as SerializedEditorState)

    reloaded.getEditorState().read(() => {
      const projection = $projectTableFilters($getRoot().getFirstChild() as TableNode)
      expect(projection.state.filters.map((filter) => filter.columnId)).toEqual([priceId])
      expect(projection.state.preserved).toEqual([foreign])
      expect(projection.summary.unreadableCount).toBe(1)
    })

    // Touch an unrelated column, then prove the foreign entry is still there.
    reloaded.update(
      () => {
        const node = $getRoot().getFirstChild() as TableNode
        const columnId = $ensureColumnId($readTableGrid(node), 0)
        if (columnId !== null) {
          $setTableColumnFilter(node, columnId, { combinator: 'all', conditions: [condition('contains', 'a')] })
        }
      },
      { discrete: true },
    )

    const again = reloaded.getEditorState().toJSON() as unknown as {
      root: { children: Array<Record<string, unknown>> }
    }
    const writtenBack = (again.root.children[0].$ as Record<string, { filters: unknown[] }>)[TABLE_FILTERS_STATE_KEY]
    expect(writtenBack.filters).toContainEqual(foreign)
  })

  it('prunes a filter whose column was deleted the next time the user writes one', () => {
    const editor = makeEditor()
    editor.update($seed, { discrete: true })
    setFilterAtColumn(editor, 1, { combinator: 'all', conditions: [condition('lt', '30')] })

    editor.update(
      () => {
        $deleteTableColumn($getRoot().getFirstChild() as TableNode, 1)
      },
      { discrete: true },
    )
    editor.getEditorState().read(() => {
      expect($getTableFilterState($getRoot().getFirstChild() as TableNode).filters).toHaveLength(1)
    })

    setFilterAtColumn(editor, 0, { combinator: 'all', conditions: [condition('contains', 'a')] })
    editor.getEditorState().read(() => {
      const filters = $getTableFilterState($getRoot().getFirstChild() as TableNode).filters
      expect(filters).toHaveLength(1)
      expect(filters[0].conditions[0].operator).toBe('contains')
    })
  })
})

describe('column type detection drives the operators offered', () => {
  it('reads each seeded column as its natural type', () => {
    const editor = makeEditor()
    editor.update($seed, { discrete: true })
    editor.getEditorState().read(() => {
      const projection = $projectTableFilters($getRoot().getFirstChild() as TableNode)
      expect(projection.columns.map((column) => [column.label, column.type])).toEqual([
        ['Name', 'text'],
        ['Price', 'number'],
        ['Due', 'date'],
        ['Open', 'boolean'],
      ])
      expect(projection.grid.headerRowCount).toBe(1)
      expect(projection.bodyRows).toHaveLength(3)
    })
  })

  it('treats a table with no header row as all body rows', () => {
    const editor = makeEditor()
    editor.update(
      () => {
        const table = $seed()
        table
          .getChildren()
          .filter($isTableRowNode)[0]
          .getChildren()
          .filter($isTableCellNode)
          .forEach((cell) => cell.setHeaderStyles(0))
      },
      { discrete: true },
    )
    editor.getEditorState().read(() => {
      const projection = $projectTableFilters($getRoot().getFirstChild() as TableNode)
      expect(projection.grid.headerRowCount).toBe(0)
      expect(projection.bodyRows).toHaveLength(4)
      expect(projection.columns[0].label).toBe('Name')
    })
  })
})
