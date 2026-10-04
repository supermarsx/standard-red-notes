/**
 * @jest-environment jsdom
 *
 * VANISH GUARD for the table Layout group.
 *
 * Green tsc and green policy tests are not evidence that a control exists: a
 * control in this editor has silently rendered nowhere more than once. So this
 * mounts the REAL controls against a REAL Lexical editor holding a REAL table,
 * asserts they are in the DOM and that clicking them changes persisted node state,
 * and separately mounts the REAL TableWidgetLayoutPlugin to prove the policy
 * actually reaches the rendered table element rather than only the model.
 *
 * jsdom has no layout engine — every width and rect reads 0 — so nothing here
 * claims a content-fit table "fits". What is asserted is the policy arithmetic, the
 * attributes and the `<col>` widths the browser is handed.
 */
import { act, useCallback, useEffect } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { TablePlugin as LexicalTablePlugin } from '@lexical/react/LexicalTablePlugin'
import { $getRoot, LexicalEditor } from 'lexical'
import {
  $createTableNodeWithDimensions,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  TableCellNode,
  TableNode,
} from '@lexical/table'
import { LocalPrefDefaults, PrefDefaults, PrefKey } from '@standardnotes/snjs'
import { BlocksEditorComposer } from '../../BlocksEditorComposer'
import ApplicationProvider from '@/Components/ApplicationProvider'
import AndroidBackHandlerProvider from '@/NativeMobileWeb/useAndroidBackHandler'
import Menu from '@/Components/Menu/Menu'
import { TableWidgetLayoutPlugin } from '../TablePlugin'
import {
  $getTableColumnWidthPolicy,
  $getTableHeaderSetting,
  $getTableWidthSetting,
  $setTableColumnWidthPolicy,
  $setTableHeadersDifferentiated,
  $setTableWidthMethod,
  makeColumnWidthPolicy,
  TABLE_HEADERS_ATTRIBUTE,
  TABLE_WIDTH_ATTRIBUTE,
} from '../../Lexical/Nodes/TableLayoutPolicy'
import { TableLayoutMenuSection } from './TableLayoutMenuSection'

jest.mock('@/Hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
  MutuallyExclusiveMediaQueryBreakpoints: { sm: 'sm', md: 'md' },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The radio items carry explanatory tooltips, which are Popovers, which require
// the Android back-handler context the real app always provides.
const fakeApp = {
  getPreference: (key: string, fallback: unknown) => PrefDefaults[key as PrefKey] ?? fallback,
  preferences: {
    getLocalValue: (key: string, fallback: unknown) => LocalPrefDefaults[key as never] ?? fallback,
    setLocalValue: () => undefined,
  },
  addEventObserver: () => () => undefined,
  addAndroidBackHandlerEventListener: () => () => undefined,
  setAndroidBackHandlerFallbackListener: () => undefined,
  addNativeMobileEventListener: () => () => undefined,
} as never

const Providers = ({ children }: { children: React.ReactNode }) => (
  <ApplicationProvider application={fakeApp}>
    <AndroidBackHandlerProvider application={fakeApp}>{children}</AndroidBackHandlerProvider>
  </ApplicationProvider>
)

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

/** Hands the composer a real root element and exposes the editor to the test. */
const EditorHandle = ({ onReady }: { onReady: (editor: LexicalEditor) => void }) => {
  const [editor] = useLexicalComposerContext()
  const setRoot = useCallback(
    (element: HTMLDivElement | null) => {
      editor.setRootElement(element)
    },
    [editor],
  )
  useEffect(() => {
    onReady(editor)
  }, [editor, onReady])
  return <div ref={setRoot} contentEditable suppressContentEditableWarning />
}

const seedTable = (editor: LexicalEditor, rows = 3, columns = 3): void => {
  editor.update(
    () => {
      $getRoot()
        .clear()
        .append($createTableNodeWithDimensions(rows, columns, true))
    },
    { discrete: true },
  )
}

/** Every cell of a table, row by row. Must run inside a Lexical read. */
const $allCells = (table: TableNode): TableCellNode[] =>
  table.getChildren().flatMap((row) => ($isTableRowNode(row) ? row.getChildren().filter($isTableCellNode) : []))

const withTableCell = <T,>(editor: LexicalEditor, columnIndex: number, run: (cell: TableCellNode) => T): T => {
  let result!: T
  editor.getEditorState().read(() => {
    const table = $getRoot().getChildren().find($isTableNode)
    if (table === undefined) {
      throw new Error('expected a table')
    }
    const firstRow = table.getChildren()[0]
    if (!$isTableRowNode(firstRow)) {
      throw new Error('expected a row')
    }
    const cell = firstRow.getChildren()[columnIndex]
    if (!$isTableCellNode(cell)) {
      throw new Error('expected a cell')
    }
    result = run(cell)
  })
  return result
}

const mutateTable = (editor: LexicalEditor, run: (table: Parameters<typeof $setTableWidthMethod>[0]) => void): void => {
  editor.update(
    () => {
      const table = $getRoot().getChildren().find($isTableNode)
      if (table === undefined) {
        throw new Error('expected a table')
      }
      run(table)
    },
    { discrete: true },
  )
}

const inspectTable = <T,>(editor: LexicalEditor, run: (table: Parameters<typeof $setTableWidthMethod>[0]) => T): T => {
  let result!: T
  editor.getEditorState().read(() => {
    const table = $getRoot().getChildren().find($isTableNode)
    if (table === undefined) {
      throw new Error('expected a table')
    }
    result = run(table)
  })
  return result
}

/* ------------------------------------------- the controls render and persist */

describe('the Layout group renders in the table controls', () => {
  let editor: LexicalEditor

  const mountSection = async (columnIndex = 0) => {
    let captured: LexicalEditor | null = null
    await act(async () => {
      root.render(
        <Providers>
          <BlocksEditorComposer initialValue={undefined}>
            <EditorHandle
              onReady={(instance) => {
                captured = instance
              }}
            />
          </BlocksEditorComposer>
        </Providers>,
      )
      await Promise.resolve()
    })
    editor = captured as unknown as LexicalEditor
    seedTable(editor)
    const cell = withTableCell(editor, columnIndex, (node) => node)
    await act(async () => {
      root.render(
        <Providers>
          <BlocksEditorComposer initialValue={undefined}>
            <EditorHandle
              onReady={(instance) => {
                captured = instance
              }}
            />
            <Menu a11yLabel="Table actions menu" shouldAutoFocus={false}>
              <TableLayoutMenuSection editor={editor} tableCellNode={cell} />
            </Menu>
          </BlocksEditorComposer>
        </Providers>,
      )
      await Promise.resolve()
    })
  }

  const itemNamed = (label: string): HTMLButtonElement => {
    const match = Array.from(container.querySelectorAll('button')).find((button) =>
      (button.textContent ?? '').includes(label),
    )
    if (match === undefined) {
      throw new Error(`no control labelled "${label}" — found: ${sectionText()}`)
    }
    return match
  }

  const sectionText = () => container.textContent ?? ''

  it('renders the table-width, column and header sections', async () => {
    await mountSection()
    expect(sectionText()).toContain('Table width')
    expect(sectionText()).toContain('Column 1 of 3')
    expect(sectionText()).toContain('Headers')
  })

  it('offers exactly the four width methods, with fit-content selected by default', async () => {
    await mountSection()
    for (const label of ['Fit content', 'Full width', 'Fixed columns', 'Equal columns']) {
      expect(sectionText()).toContain(label)
    }
    expect(itemNamed('Fit content').getAttribute('aria-checked')).toBe('true')
    expect(itemNamed('Full width').getAttribute('aria-checked')).toBe('false')
  })

  it('persists the chosen width method onto the table node', async () => {
    await mountSection()
    await act(async () => {
      itemNamed('Fixed columns').click()
    })
    expect(inspectTable(editor, (table) => $getTableWidthSetting(table).method)).toBe('fixed')
    expect(itemNamed('Fixed columns').getAttribute('aria-checked')).toBe('true')
  })

  it('persists a per-column width and shows its unit', async () => {
    await mountSection(1)
    expect(sectionText()).toContain('Column 2 of 3')
    await act(async () => {
      itemNamed('Fixed width').click()
    })
    expect(inspectTable(editor, (table) => $getTableColumnWidthPolicy(table, 1))).toMatchObject({
      mode: 'fixed',
      value: 120,
    })
    expect(sectionText()).toContain('Width (px)')
    // And only that column — the neighbours are untouched.
    expect(inspectTable(editor, (table) => $getTableColumnWidthPolicy(table, 0).mode)).toBe('auto')
  })

  it('switches a column to a percentage', async () => {
    await mountSection(2)
    await act(async () => {
      itemNamed('Percentage').click()
    })
    expect(inspectTable(editor, (table) => $getTableColumnWidthPolicy(table, 2))).toMatchObject({
      mode: 'percent',
      value: 25,
    })
    expect(sectionText()).toContain('Width (%)')
  })

  it('toggles differentiated headers without touching header semantics', async () => {
    await mountSection()
    const headerStatesBefore = inspectTable(editor, (table) => $allCells(table).map((cell) => cell.getHeaderStyles()))
    await act(async () => {
      itemNamed('Differentiated headers').click()
    })
    expect(inspectTable(editor, (table) => $getTableHeaderSetting(table).differentiated)).toBe(false)
    const headerStatesAfter = inspectTable(editor, (table) => $allCells(table).map((cell) => cell.getHeaderStyles()))
    expect(headerStatesAfter).toEqual(headerStatesBefore)
    expect(sectionText()).toContain('Header rows and columns stay headers')
  })

  it('says so when the equal-columns method suspends a per-column width', async () => {
    await mountSection(0)
    await act(async () => {
      itemNamed('Fixed width').click()
    })
    expect(sectionText()).not.toContain('per-column widths are kept but not applied')
    await act(async () => {
      itemNamed('Equal columns').click()
    })
    expect(sectionText()).toContain('per-column widths are kept but not applied')
    // Suspended, not erased.
    expect(inspectTable(editor, (table) => $getTableColumnWidthPolicy(table, 0).mode)).toBe('fixed')
  })

  it('reads a malformed stored setting as unrecognised instead of as a measured one', async () => {
    await mountSection()
    // Inject the value the way a sync from another build would: straight into the
    // serialized node state, not through a setter that would have validated it.
    const json = JSON.parse(JSON.stringify(editor.getEditorState().toJSON())) as {
      root: { children: Record<string, unknown>[] }
    }
    const tableJson = json.root.children.find((child) => child.type === 'table')
    expect(tableJson).toBeDefined()
    tableJson!.$ = { superTableWidth: 'as-wide-as-the-sky' }
    await act(async () => {
      editor.setEditorState(editor.parseEditorState(JSON.stringify(json)))
      await Promise.resolve()
    })
    const cell = withTableCell(editor, 0, (node) => node)
    await act(async () => {
      root.render(
        <Providers>
          <BlocksEditorComposer initialValue={undefined}>
            <Menu a11yLabel="Table actions menu" shouldAutoFocus={false}>
              <TableLayoutMenuSection editor={editor} tableCellNode={cell} />
            </Menu>
          </BlocksEditorComposer>
        </Providers>,
      )
      await Promise.resolve()
    })
    expect(sectionText()).toContain('does not recognise')
    // Nothing is shown as selected, because the stored value is not one of these.
    for (const label of ['Fit content', 'Full width', 'Fixed columns', 'Equal columns']) {
      expect(itemNamed(label).getAttribute('aria-checked')).toBe('false')
    }
  })
})

/* ---------------------------------- the policy reaches the rendered table */

describe('TableWidgetLayoutPlugin projects the policy onto the real table element', () => {
  let editor: LexicalEditor

  const mountEditor = async () => {
    let captured: LexicalEditor | null = null
    await act(async () => {
      root.render(
        <Providers>
          <BlocksEditorComposer initialValue={undefined}>
            <LexicalTablePlugin hasCellMerge hasHorizontalScroll />
            <TableWidgetLayoutPlugin />
            <EditorHandle
              onReady={(instance) => {
                captured = instance
              }}
            />
          </BlocksEditorComposer>
        </Providers>,
      )
      await Promise.resolve()
    })
    editor = captured as unknown as LexicalEditor
  }

  const tableElement = (): HTMLTableElement => {
    const table = container.querySelector('table')
    if (table === null) {
      throw new Error('no table rendered')
    }
    return table
  }

  it('marks a newly inserted table with the default width method', async () => {
    await mountEditor()
    await act(async () => {
      seedTable(editor)
      await Promise.resolve()
    })
    expect(tableElement().getAttribute(TABLE_WIDTH_ATTRIBUTE)).toBe('content')
    expect(tableElement().hasAttribute(TABLE_HEADERS_ATTRIBUTE)).toBe(false)
  })

  it('updates the attribute when the method changes', async () => {
    await mountEditor()
    await act(async () => {
      seedTable(editor)
      await Promise.resolve()
    })
    await act(async () => {
      mutateTable(editor, (table) => $setTableWidthMethod(table, 'equal'))
      await Promise.resolve()
    })
    expect(tableElement().getAttribute(TABLE_WIDTH_ATTRIBUTE)).toBe('equal')
  })

  it('marks plain headers and clears the mark again', async () => {
    await mountEditor()
    await act(async () => {
      seedTable(editor)
      await Promise.resolve()
    })
    await act(async () => {
      mutateTable(editor, (table) => $setTableHeadersDifferentiated(table, false))
      await Promise.resolve()
    })
    expect(tableElement().getAttribute(TABLE_HEADERS_ATTRIBUTE)).toBe('plain')
    await act(async () => {
      mutateTable(editor, (table) => $setTableHeadersDifferentiated(table, true))
      await Promise.resolve()
    })
    expect(tableElement().hasAttribute(TABLE_HEADERS_ATTRIBUTE)).toBe(false)
  })

  it('writes a per-column width onto the colgroup the browser actually sizes from', async () => {
    await mountEditor()
    await act(async () => {
      seedTable(editor)
      await Promise.resolve()
    })
    await act(async () => {
      mutateTable(editor, (table) => {
        $setTableWidthMethod(table, 'fixed')
        $setTableColumnWidthPolicy(table, 1, makeColumnWidthPolicy('percent', 40))
      })
      await Promise.resolve()
    })
    const cols = Array.from(tableElement().querySelectorAll(':scope > colgroup > col'))
    expect(cols).toHaveLength(3)
    expect((cols[1] as HTMLElement).style.width).toBe('40%')
    expect((cols[0] as HTMLElement).style.width).toBe('')
  })

  it('emits no column width at all while equal columns is active', async () => {
    await mountEditor()
    await act(async () => {
      seedTable(editor)
      await Promise.resolve()
    })
    await act(async () => {
      mutateTable(editor, (table) => {
        $setTableColumnWidthPolicy(table, 0, makeColumnWidthPolicy('fixed', 300))
        $setTableWidthMethod(table, 'equal')
      })
      await Promise.resolve()
    })
    const cols = Array.from(tableElement().querySelectorAll(':scope > colgroup > col'))
    expect((cols[0] as HTMLElement).style.width).toBe('')
  })
})
