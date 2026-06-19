import * as React from 'react'
import { useCallback } from 'react'
import {
  $getNodeByKey,
  DecoratorNode,
  EditorConfig,
  LexicalEditor,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
  Spread,
} from 'lexical'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'

export type DataTableData = { columns: string[]; rows: string[][] }

const DEFAULT_DATATABLE: DataTableData = {
  columns: ['Name', 'Status', 'Notes'],
  rows: [
    ['', '', ''],
    ['', '', ''],
  ],
}

function clone(data: DataTableData): DataTableData {
  return { columns: [...data.columns], rows: data.rows.map((r) => [...r]) }
}

function DataTableComponent({ data, nodeKey }: { data: DataTableData; nodeKey: NodeKey }): React.JSX.Element {
  const [editor] = useLexicalComposerContext()

  const mutate = useCallback(
    (fn: (draft: DataTableData) => void) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey)
        if ($isDataTableNode(node)) {
          const draft = clone(node.getData())
          fn(draft)
          node.setData(draft)
        }
      })
    },
    [editor, nodeKey],
  )

  const setHeader = (col: number, value: string) => mutate((d) => (d.columns[col] = value))
  const setCell = (row: number, col: number, value: string) =>
    mutate((d) => {
      if (d.rows[row]) d.rows[row][col] = value
    })
  const addRow = () => mutate((d) => d.rows.push(new Array(d.columns.length).fill('')))
  const removeRow = (row: number) => mutate((d) => d.rows.splice(row, 1))
  const addColumn = () =>
    mutate((d) => {
      d.columns.push(`Column ${d.columns.length + 1}`)
      d.rows.forEach((r) => r.push(''))
    })
  const removeColumn = (col: number) =>
    mutate((d) => {
      if (d.columns.length <= 1) return
      d.columns.splice(col, 1)
      d.rows.forEach((r) => r.splice(col, 1))
    })

  return (
    <div className="my-2 rounded border border-border bg-default" data-datatable-block="true">
      <div className="flex items-center justify-between border-b border-border px-2 py-1 text-xs text-passive-1">
        <span className="font-semibold">Data table</span>
        <div className="flex gap-1">
          <button className="rounded px-2 py-0.5 hover:bg-contrast" onClick={addColumn} type="button">
            + Column
          </button>
          <button className="rounded px-2 py-0.5 hover:bg-contrast" onClick={addRow} type="button">
            + Row
          </button>
        </div>
      </div>
      <div className="overflow-x-auto p-1">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              {data.columns.map((col, c) => (
                <th key={`h-${c}`} className="border border-border bg-contrast p-0">
                  <div className="flex items-center">
                    <input
                      key={`hi-${c}`}
                      className="min-w-0 flex-grow bg-transparent px-2 py-1 text-left font-semibold text-text outline-none"
                      defaultValue={col}
                      onBlur={(e) => setHeader(c, e.target.value)}
                    />
                    <button
                      className="px-1 text-passive-1 hover:text-danger"
                      onClick={() => removeColumn(c)}
                      title="Delete column"
                      type="button"
                    >
                      ×
                    </button>
                  </div>
                </th>
              ))}
              <th className="w-6 border border-border bg-contrast" />
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, r) => (
              <tr key={`r-${r}`}>
                {data.columns.map((_, c) => (
                  <td key={`c-${r}-${c}`} className="border border-border p-0">
                    <input
                      key={`ci-${r}-${c}`}
                      className="w-full bg-transparent px-2 py-1 text-foreground outline-none focus:bg-contrast"
                      defaultValue={row[c] ?? ''}
                      onBlur={(e) => setCell(r, c, e.target.value)}
                    />
                  </td>
                ))}
                <td className="border border-border text-center align-middle">
                  <button
                    className="px-1 text-passive-1 hover:text-danger"
                    onClick={() => removeRow(r)}
                    title="Delete row"
                    type="button"
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export type SerializedDataTableNode = Spread<{ data: DataTableData }, SerializedLexicalNode>

export class DataTableNode extends DecoratorNode<React.JSX.Element> {
  __data: DataTableData

  static getType(): string {
    return 'datatable'
  }

  static clone(node: DataTableNode): DataTableNode {
    return new DataTableNode(node.__data, node.__key)
  }

  constructor(data: DataTableData, key?: NodeKey) {
    super(key)
    this.__data = data
  }

  static importJSON(serializedNode: SerializedDataTableNode): DataTableNode {
    return $createDataTableNode(serializedNode.data)
  }

  exportJSON(): SerializedDataTableNode {
    return { type: 'datatable', version: 1, data: this.__data }
  }

  createDOM(): HTMLElement {
    const div = document.createElement('div')
    div.style.display = 'contents'
    return div
  }

  updateDOM(): false {
    return false
  }

  getData(): DataTableData {
    return this.getLatest().__data
  }

  setData(data: DataTableData): void {
    this.getWritable().__data = data
  }

  getTextContent(): string {
    const header = this.__data.columns.join(' | ')
    const rows = this.__data.rows.map((r) => r.join(' | '))
    return [header, ...rows].join('\n')
  }

  isInline(): false {
    return false
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): React.JSX.Element {
    return <DataTableComponent data={this.__data} nodeKey={this.getKey()} />
  }
}

export function $createDataTableNode(data: DataTableData = DEFAULT_DATATABLE): DataTableNode {
  return new DataTableNode(data)
}

export function $isDataTableNode(node: LexicalNode | null | undefined): node is DataTableNode {
  return node instanceof DataTableNode
}
