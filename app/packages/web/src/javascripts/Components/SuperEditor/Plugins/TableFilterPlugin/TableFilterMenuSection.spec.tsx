/**
 * @jest-environment jsdom
 *
 * VANISH GUARD for the table Filtering group.
 *
 * A control in this editor has silently rendered nowhere more than once
 * (`ToolbarPlugin.checklistGroup.spec.tsx` records three occasions), and neither
 * tsc nor the predicate tests can see it happen. So this mounts the REAL Menu
 * primitive around the REAL section against a REAL Lexical editor holding a REAL
 * table, asserts the controls are in the DOM, and asserts that clicking them
 * changes persisted node state.
 *
 * It then pins the three wiring facts that no type checker can see: the section
 * is rendered inside the table actions menu, the plugin is mounted in
 * BlocksEditor, and the stylesheet is actually imported.
 */

import fs from 'node:fs'
import path from 'node:path'
import { act, useEffect, useState } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  $createTableNodeWithDimensions,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  TableCellNode,
  TableNode,
  TableRowNode,
} from '@lexical/table'
import { $createTextNode, $getRoot, LexicalEditor } from 'lexical'

import Menu from '@/Components/Menu/Menu'

import TableFilterMenuSection from './TableFilterMenuSection'
import { $getTableFilterState } from './tableFilterState'

jest.mock('@/Hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
  MutuallyExclusiveMediaQueryBreakpoints: { sm: 'sm', md: 'md' },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const GRID: string[][] = [
  ['Name', 'Price'],
  ['Apple', '10'],
  ['Banana', '40'],
  ['Cherry', '5'],
]

let container: HTMLElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

/**
 * Seeds the table, resolves the cell at `columnIndex` of the header row and then
 * renders the real Menu around the real section. One render, so the section's
 * `useLexicalComposerContext()` editor is provably the editor holding the table.
 */
const MenuHost = ({ columnIndex, onReady }: { columnIndex: number; onReady: (editor: LexicalEditor) => void }) => {
  const [editor] = useLexicalComposerContext()
  const [cell, setCell] = useState<TableCellNode | null>(null)

  useEffect(() => {
    editor.update(
      () => {
        const lexicalRoot = $getRoot()
        lexicalRoot.clear()
        const table = $createTableNodeWithDimensions(GRID.length, GRID[0].length, true)
        lexicalRoot.append(table)
        table.getChildren().forEach((row, rowIndex) => {
          if (!$isTableRowNode(row)) {
            return
          }
          row.getChildren().forEach((tableCell, index) => {
            if (!$isTableCellNode(tableCell)) {
              return
            }
            const paragraph = tableCell.getFirstChild()
            if (paragraph !== null && 'append' in paragraph) {
              ;(paragraph as unknown as { append: (child: ReturnType<typeof $createTextNode>) => void }).append(
                $createTextNode(GRID[rowIndex][index]),
              )
            }
          })
        })
      },
      { discrete: true },
    )
    editor.getEditorState().read(() => {
      const table = $getRoot().getChildren().find($isTableNode)
      const firstRow = table?.getChildren()[0]
      if (!firstRow || !$isTableRowNode(firstRow)) {
        return
      }
      const found = firstRow.getChildren()[columnIndex]
      if ($isTableCellNode(found)) {
        setCell(found)
      }
    })
    onReady(editor)
  }, [columnIndex, editor, onReady])

  if (cell === null) {
    return null
  }

  return (
    <Menu a11yLabel="Table actions menu" shouldAutoFocus={false}>
      <TableFilterMenuSection tableCellNode={cell} />
    </Menu>
  )
}

const mountSection = async (columnIndex = 1): Promise<LexicalEditor> => {
  let captured: LexicalEditor | null = null
  await act(async () => {
    root.render(
      <LexicalComposer
        initialConfig={{
          namespace: 'TableFilterMenuSectionSpec',
          nodes: [TableNode, TableRowNode, TableCellNode],
          onError: (error: Error) => {
            throw error
          },
        }}
      >
        <MenuHost
          columnIndex={columnIndex}
          onReady={(editor) => {
            captured = editor
          }}
        />
      </LexicalComposer>,
    )
    await Promise.resolve()
  })
  if (captured === null) {
    throw new Error('the editor never became ready')
  }
  return captured
}

const sectionText = () => container.textContent ?? ''

const buttonNamed = (label: string): HTMLButtonElement => {
  const match = Array.from(container.querySelectorAll('button')).find((button) =>
    (button.textContent ?? '').includes(label),
  )
  if (match === undefined) {
    throw new Error(`no control labelled "${label}" — found: ${sectionText()}`)
  }
  return match
}

const filtersOf = (editor: LexicalEditor) =>
  editor.getEditorState().read(() => {
    const table = $getRoot().getChildren().find($isTableNode)
    if (table === undefined) {
      throw new Error('expected a table')
    }
    return $getTableFilterState(table).filters
  })

describe('the Filtering group renders in the table actions menu', () => {
  it('is in the DOM, inside the menu, naming the selected column', async () => {
    await mountSection(1)
    const section = container.querySelector('[data-srn-table-filter-section="true"]')
    expect(section).not.toBeNull()
    expect(section?.closest('menu')).not.toBeNull()
    expect(sectionText()).toContain('Filtering')
    expect(sectionText()).toContain('Filter Price')
  })

  it('says all rows are shown while nothing is filtered', async () => {
    await mountSection(1)
    expect(container.querySelector('[data-srn-table-filter-menu-status]')?.textContent).toBe(
      'No filter. All 3 rows shown.',
    )
    expect(container.querySelector('[data-srn-table-filter-show-all]')).toBeNull()
  })

  it('expands the filter panel IN PLACE, offering the operators for the column’s type', async () => {
    await mountSection(1)
    expect(container.querySelector('[data-srn-table-filter-panel="true"]')).toBeNull()

    await act(async () => {
      container.querySelector<HTMLElement>('[data-srn-table-filter-disclosure]')?.click()
    })

    const panel = container.querySelector('[data-srn-table-filter-panel="true"]')
    expect(panel).not.toBeNull()
    // In place: still inside the same <menu>, not in a portal of its own.
    expect(panel?.closest('menu')).toBe(container.querySelector('menu'))
    // Every control is a real button or input, which is what keeps the menu's
    // arrow-key navigation working over the expansion.
    expect(panel?.querySelectorAll('button').length).toBeGreaterThan(0)
    expect(panel?.querySelector('[data-srn-table-filter-operator="between"]')).not.toBeNull()
    expect(panel?.querySelector('[data-srn-table-filter-operator="contains"]')).toBeNull()
  })

  it('offers text operators for a text column instead', async () => {
    await mountSection(0)
    expect(sectionText()).toContain('Filter Name')
    await act(async () => {
      container.querySelector<HTMLElement>('[data-srn-table-filter-disclosure]')?.click()
    })
    const panel = container.querySelector('[data-srn-table-filter-panel="true"]')
    expect(panel?.querySelector('[data-srn-table-filter-operator="contains"]')).not.toBeNull()
    expect(panel?.querySelector('[data-srn-table-filter-operator="between"]')).toBeNull()
    expect(panel?.querySelector('[data-srn-table-filter-column-type="text"]')).not.toBeNull()
    expect(sectionText()).toContain('Hide Name')
  })

  it('persists the chosen filter onto the table node, keyed by a minted column id', async () => {
    const editor = await mountSection(1)
    await act(async () => {
      container.querySelector<HTMLElement>('[data-srn-table-filter-disclosure]')?.click()
    })
    await act(async () => {
      container.querySelector<HTMLElement>('[data-srn-table-filter-operator="lt"]')?.click()
    })
    const input = container.querySelector<HTMLInputElement>('[data-srn-table-filter-value="0"]')
    expect(input).not.toBeNull()
    await act(async () => {
      const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
      descriptor?.set?.call(input, '30')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const filters = filtersOf(editor)
    expect(filters).toHaveLength(1)
    expect(filters[0].columnId).toMatch(/^tf-/)
    expect(filters[0].conditions).toEqual([{ operator: 'lt', value: '30', value2: '' }])

    expect(container.querySelector('[data-srn-table-filter-menu-status]')?.textContent).toBe(
      'Filtered: showing 2 of 3 rows — 1 hidden by 1 column filter',
    )
    expect(sectionText()).toContain('Clear filter on Price')
  })

  it('clears this column, and clears every column, from the menu', async () => {
    const editor = await mountSection(1)
    await act(async () => {
      container.querySelector<HTMLElement>('[data-srn-table-filter-disclosure]')?.click()
    })
    await act(async () => {
      container.querySelector<HTMLElement>('[data-srn-table-filter-operator="gte"]')?.click()
    })
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('[data-srn-table-filter-value="0"]')
      const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
      descriptor?.set?.call(input, '10')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(filtersOf(editor)).toHaveLength(1)

    await act(async () => {
      buttonNamed('Show all rows').click()
    })
    expect(filtersOf(editor)).toHaveLength(0)
    expect(container.querySelector('[data-srn-table-filter-menu-status]')?.textContent).toBe(
      'No filter. All 3 rows shown.',
    )
  })
})

/* ---------------------------------------------------------------- wiring ---- */

const webRoot = path.resolve(__dirname, '../../../../../..')
const read = (relativePath: string) => fs.readFileSync(path.join(webRoot, relativePath), 'utf8')

describe('the feature is actually wired up', () => {
  it('renders the Filtering section inside the table actions Menu', () => {
    const menu = read('src/javascripts/Components/SuperEditor/Plugins/TableCellActionMenuPlugin/index.tsx')
    expect(menu).toContain("import TableFilterMenuSection from '../TableFilterPlugin/TableFilterMenuSection'")
    expect(menu).toMatch(/<TableFilterMenuSection tableCellNode=\{tableCellNode\} \/>[\s\S]*<\/Menu>/)
  })

  it('mounts the plugin in BlocksEditor', () => {
    const blocksEditor = read('src/javascripts/Components/SuperEditor/BlocksEditor.tsx')
    expect(blocksEditor).toContain("import TableFilterPlugin from './Plugins/TableFilterPlugin/TableFilterPlugin'")
    expect(blocksEditor).toContain('<TableFilterPlugin />')
  })

  it('imports the stylesheet, without which hiding and the print override do nothing', () => {
    const custom = read('src/javascripts/Components/SuperEditor/Lexical/Theme/custom.scss')
    expect(custom).toContain("@import '../../Plugins/TableFilterPlugin/TableFilter.scss';")
  })
})
