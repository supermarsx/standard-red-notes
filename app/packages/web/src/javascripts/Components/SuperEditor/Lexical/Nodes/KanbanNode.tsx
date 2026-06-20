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
/** `color` is an optional hex string (e.g. `#3b82f6`) used as a column accent. */
type KanbanColumn = { id: string; title: string; color?: string; cards: KanbanCard[] }
export type KanbanData = { title: string; columns: KanbanColumn[] }

const uid = () => Math.random().toString(36).slice(2, 9)

export const DEFAULT_BOARD_TITLE = 'Kanban board'

/** A small palette offered as quick-pick swatches in the column header. */
export const COLUMN_COLOR_PRESETS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7'] as const

/** True for `#rgb`/`#rrggbb` hex strings; anything else is treated as "no color". */
function isValidHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)
}

const DEFAULT_KANBAN: KanbanData = {
  title: DEFAULT_BOARD_TITLE,
  columns: [
    { id: uid(), title: 'To do', cards: [] },
    { id: uid(), title: 'In progress', cards: [] },
    { id: uid(), title: 'Done', cards: [] },
  ],
}

/**
 * Normalizes data coming from importJSON. Notes serialized before the board
 * title was editable have no `title` field, so we backfill the default to keep
 * older notes rendering and round-tripping correctly. Likewise, columns from
 * boards saved before per-column colors existed have no `color` field; we leave
 * it undefined (i.e. "no color") so those boards are unaffected. Any invalid
 * color value is dropped rather than persisted.
 */
function normalize(data: KanbanData): KanbanData {
  return {
    title: data.title ?? DEFAULT_BOARD_TITLE,
    columns: (data.columns ?? []).map((c) => {
      if (isValidHexColor(c.color)) return c
      // Drop any absent/invalid color so legacy boards round-trip unchanged
      // (no stray `color: undefined` key is introduced).
      const { color: _color, ...rest } = c
      return rest
    }),
  }
}

function clone(data: KanbanData): KanbanData {
  return {
    title: data.title,
    columns: data.columns.map((c) => ({ ...c, cards: c.cards.map((card) => ({ ...card })) })),
  }
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

  const renameBoard = (title: string) => mutate((d) => (d.title = title))
  const addColumn = () => mutate((d) => d.columns.push({ id: uid(), title: 'New column', cards: [] }))
  const removeColumn = (colId: string) => mutate((d) => (d.columns = d.columns.filter((c) => c.id !== colId)))
  const renameColumn = (colId: string, title: string) =>
    mutate((d) => {
      const col = d.columns.find((c) => c.id === colId)
      if (col) col.title = title
    })
  const setColumnColor = (colId: string, color: string | undefined) =>
    mutate((d) => {
      const col = d.columns.find((c) => c.id === colId)
      if (!col) return
      // Passing undefined (or an invalid value) clears the color back to "none".
      if (isValidHexColor(color)) col.color = color
      else delete col.color
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
      <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1 text-xs text-passive-1">
        <input
          key={`board-title-${nodeKey}`}
          className="min-w-0 flex-grow bg-transparent font-semibold text-text outline-none"
          defaultValue={data.title}
          placeholder="Board title…"
          aria-label="Board title"
          onBlur={(e) => renameBoard(e.target.value)}
        />
        <button
          className="flex-shrink-0 rounded px-2 py-0.5 hover:bg-contrast"
          onClick={addColumn}
          type="button"
        >
          + Column
        </button>
      </div>
      <div className="flex gap-2 overflow-x-auto p-2">
        {data.columns.map((col, colIndex) => (
          <div
            key={col.id}
            className="flex w-56 flex-shrink-0 flex-col overflow-hidden rounded bg-contrast"
            style={col.color ? { borderTop: `3px solid ${col.color}` } : undefined}
          >
            <div
              className="flex flex-col gap-1 p-2"
              // Use the column color as a translucent tint behind the header so the
              // accent is visible in both light and dark themes without harming the
              // contrast of the title text (which keeps the theme `text` color).
              style={col.color ? { backgroundColor: `${col.color}26` } : undefined}
            >
              <div className="flex items-center gap-1">
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
              <div className="flex flex-wrap items-center gap-1">
                <label
                  className="relative h-4 w-4 flex-shrink-0 cursor-pointer rounded-full border border-border"
                  style={{ backgroundColor: col.color ?? 'transparent' }}
                  title="Pick a custom column color"
                >
                  <input
                    key={`color-${col.id}`}
                    type="color"
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                    value={col.color ?? '#000000'}
                    onChange={(e) => setColumnColor(col.id, e.target.value)}
                    aria-label="Column color"
                  />
                </label>
                {COLUMN_COLOR_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    className="h-4 w-4 flex-shrink-0 rounded-full border border-border"
                    style={{ backgroundColor: preset }}
                    title={`Set column color ${preset}`}
                    aria-label={`Set column color ${preset}`}
                    aria-pressed={col.color === preset}
                    onClick={() => setColumnColor(col.id, preset)}
                  />
                ))}
                <button
                  type="button"
                  className="rounded px-1 text-xs text-passive-1 hover:bg-default disabled:opacity-40"
                  disabled={!col.color}
                  onClick={() => setColumnColor(col.id, undefined)}
                  title="Clear column color"
                >
                  Clear
                </button>
              </div>
            </div>
            <div className="flex flex-col p-2 pt-0">
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
    return $createKanbanNode(normalize(serializedNode.data))
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
    const board = `# ${this.__data.title}`
    const columns = this.__data.columns
      .map((c) => `## ${c.title}\n${c.cards.map((card) => `- ${card.text}`).join('\n')}`)
      .join('\n\n')
    return columns ? `${board}\n\n${columns}` : board
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
