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

type KanbanCard = { id: string; text: string }
type KanbanColumn = { id: string; title: string; cards: KanbanCard[] }
export type KanbanData = { columns: KanbanColumn[] }

const uid = () => Math.random().toString(36).slice(2, 9)

const DEFAULT_KANBAN: KanbanData = {
  columns: [
    { id: uid(), title: 'To do', cards: [] },
    { id: uid(), title: 'In progress', cards: [] },
    { id: uid(), title: 'Done', cards: [] },
  ],
}

function clone(data: KanbanData): KanbanData {
  return { columns: data.columns.map((c) => ({ ...c, cards: c.cards.map((card) => ({ ...card })) })) }
}

function KanbanComponent({ data, nodeKey }: { data: KanbanData; nodeKey: NodeKey }): React.JSX.Element {
  const [editor] = useLexicalComposerContext()

  const mutate = useCallback(
    (fn: (draft: KanbanData) => void) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey)
        if ($isKanbanNode(node)) {
          const draft = clone(node.getData())
          fn(draft)
          node.setData(draft)
        }
      })
    },
    [editor, nodeKey],
  )

  const addColumn = () => mutate((d) => d.columns.push({ id: uid(), title: 'New column', cards: [] }))
  const removeColumn = (colId: string) => mutate((d) => (d.columns = d.columns.filter((c) => c.id !== colId)))
  const renameColumn = (colId: string, title: string) =>
    mutate((d) => {
      const col = d.columns.find((c) => c.id === colId)
      if (col) col.title = title
    })
  const addCard = (colId: string) =>
    mutate((d) => {
      const col = d.columns.find((c) => c.id === colId)
      if (col) col.cards.push({ id: uid(), text: '' })
    })
  const editCard = (colId: string, cardId: string, text: string) =>
    mutate((d) => {
      const card = d.columns.find((c) => c.id === colId)?.cards.find((cc) => cc.id === cardId)
      if (card) card.text = text
    })
  const removeCard = (colId: string, cardId: string) =>
    mutate((d) => {
      const col = d.columns.find((c) => c.id === colId)
      if (col) col.cards = col.cards.filter((cc) => cc.id !== cardId)
    })
  const moveCard = (colId: string, cardId: string, dir: -1 | 1) =>
    mutate((d) => {
      const from = d.columns.findIndex((c) => c.id === colId)
      const to = from + dir
      if (from < 0 || to < 0 || to >= d.columns.length) return
      const idx = d.columns[from].cards.findIndex((cc) => cc.id === cardId)
      if (idx < 0) return
      const [card] = d.columns[from].cards.splice(idx, 1)
      d.columns[to].cards.push(card)
    })

  return (
    <div className="my-2 rounded border border-border bg-default" data-kanban-block="true">
      <div className="flex items-center justify-between border-b border-border px-2 py-1 text-xs text-passive-1">
        <span className="font-semibold">Kanban board</span>
        <button className="rounded px-2 py-0.5 hover:bg-contrast" onClick={addColumn} type="button">
          + Column
        </button>
      </div>
      <div className="flex gap-2 overflow-x-auto p-2">
        {data.columns.map((col, colIndex) => (
          <div key={col.id} className="flex w-56 flex-shrink-0 flex-col rounded bg-contrast p-2">
            <div className="mb-1 flex items-center gap-1">
              <input
                key={`title-${col.id}`}
                className="min-w-0 flex-grow bg-transparent text-sm font-semibold text-text outline-none"
                defaultValue={col.title}
                onBlur={(e) => renameColumn(col.id, e.target.value)}
              />
              <button
                className="rounded px-1 text-passive-1 hover:bg-default hover:text-danger"
                onClick={() => removeColumn(col.id)}
                title="Delete column"
                type="button"
              >
                ×
              </button>
            </div>
            <div className="flex flex-col gap-1">
              {col.cards.map((card) => (
                <div key={card.id} className="rounded border border-border bg-default p-1.5">
                  <textarea
                    key={`text-${card.id}`}
                    className="w-full resize-none bg-transparent text-sm text-foreground outline-none"
                    rows={Math.max(1, card.text.split('\n').length)}
                    defaultValue={card.text}
                    placeholder="Card…"
                    onBlur={(e) => editCard(col.id, card.id, e.target.value)}
                  />
                  <div className="mt-1 flex items-center justify-end gap-1 text-xs text-passive-1">
                    <button
                      className="rounded px-1 hover:bg-contrast disabled:opacity-40"
                      disabled={colIndex === 0}
                      onClick={() => moveCard(col.id, card.id, -1)}
                      title="Move left"
                      type="button"
                    >
                      ‹
                    </button>
                    <button
                      className="rounded px-1 hover:bg-contrast disabled:opacity-40"
                      disabled={colIndex === data.columns.length - 1}
                      onClick={() => moveCard(col.id, card.id, 1)}
                      title="Move right"
                      type="button"
                    >
                      ›
                    </button>
                    <button
                      className="rounded px-1 hover:bg-contrast hover:text-danger"
                      onClick={() => removeCard(col.id, card.id)}
                      title="Delete card"
                      type="button"
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <button
              className="mt-1 rounded px-1 py-0.5 text-left text-xs text-passive-1 hover:bg-default"
              onClick={() => addCard(col.id)}
              type="button"
            >
              + Add card
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

export type SerializedKanbanNode = Spread<{ data: KanbanData }, SerializedLexicalNode>

export class KanbanNode extends DecoratorNode<React.JSX.Element> {
  __data: KanbanData

  static getType(): string {
    return 'kanban'
  }

  static clone(node: KanbanNode): KanbanNode {
    return new KanbanNode(node.__data, node.__key)
  }

  constructor(data: KanbanData, key?: NodeKey) {
    super(key)
    this.__data = data
  }

  static importJSON(serializedNode: SerializedKanbanNode): KanbanNode {
    return $createKanbanNode(serializedNode.data)
  }

  exportJSON(): SerializedKanbanNode {
    return { type: 'kanban', version: 1, data: this.__data }
  }

  createDOM(): HTMLElement {
    const div = document.createElement('div')
    div.style.display = 'contents'
    return div
  }

  updateDOM(): false {
    return false
  }

  getData(): KanbanData {
    return this.getLatest().__data
  }

  setData(data: KanbanData): void {
    this.getWritable().__data = data
  }

  getTextContent(): string {
    return this.__data.columns
      .map((c) => `## ${c.title}\n${c.cards.map((card) => `- ${card.text}`).join('\n')}`)
      .join('\n\n')
  }

  isInline(): false {
    return false
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): React.JSX.Element {
    return <KanbanComponent data={this.__data} nodeKey={this.getKey()} />
  }
}

export function $createKanbanNode(data: KanbanData = DEFAULT_KANBAN): KanbanNode {
  return new KanbanNode(data)
}

export function $isKanbanNode(node: LexicalNode | null | undefined): node is KanbanNode {
  return node instanceof KanbanNode
}
