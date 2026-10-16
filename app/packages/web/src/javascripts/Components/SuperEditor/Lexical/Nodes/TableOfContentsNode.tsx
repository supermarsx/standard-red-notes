import * as React from 'react'
import {
  $getNodeByKey,
  DecoratorNode,
  EditorConfig,
  LexicalEditor,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
} from 'lexical'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { TableOfContentsPlugin, TableOfContentsEntry } from '@lexical/react/LexicalTableOfContentsPlugin'

/**
 * Standard Red Notes: live, clickable table-of-contents / index block.
 *
 * Unlike the toolbar's TOC popover (which is ephemeral UI), this is a real
 * DecoratorNode persisted in the document. It renders a LIVE index built from
 * the document's headings via @lexical/react/LexicalTableOfContentsPlugin, so
 * it stays in sync as headings are added/removed/renamed. Clicking an entry
 * selects and scrolls to the corresponding heading.
 *
 * Follows the DecoratorNode pattern of KanbanNode / DataTableNode
 * (display:contents host, importJSON/exportJSON, $create/$is helpers).
 */

/** Maximum heading level (h1..h6) shown in the index. */
const MAX_TOC_LEVEL = 6

export type TableOfContentsFormat = {
  maxLevel: number
  numbered: boolean
  showTitle: boolean
}

export const DEFAULT_TABLE_OF_CONTENTS_FORMAT: TableOfContentsFormat = {
  maxLevel: 6,
  numbered: false,
  showTitle: true,
}

export function normalizeTableOfContentsFormat(value?: Partial<TableOfContentsFormat>): TableOfContentsFormat {
  return {
    maxLevel:
      typeof value?.maxLevel === 'number' && Number.isFinite(value.maxLevel)
        ? Math.max(1, Math.min(MAX_TOC_LEVEL, Math.trunc(value.maxLevel)))
        : MAX_TOC_LEVEL,
    numbered: value?.numbered === true,
    showTitle: value?.showTitle !== false,
  }
}

function levelOf(tag: string): number {
  const level = parseInt(tag.slice(1), 10)
  return Number.isFinite(level) && level >= 1 ? level : 1
}

function scrollToHeading(editor: LexicalEditor, key: NodeKey): void {
  editor.update(() => {
    const node = $getNodeByKey(key)
    if (!node) {
      return
    }
    node.selectEnd()
    editor.focus()
    const domElement = editor.getElementByKey(key)
    if (!domElement) {
      return
    }
    // Defer so selection/focus settles before scrolling (mirrors toolbar TOC).
    setTimeout(() => {
      domElement.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 1)
  })
}

function TableOfContentsList({
  entries,
  editor,
  format,
}: {
  entries: Array<TableOfContentsEntry>
  editor: LexicalEditor
  format: TableOfContentsFormat
}): React.JSX.Element {
  const headings = entries.filter(([, , tag]) => levelOf(tag) <= format.maxLevel)

  if (headings.length === 0) {
    return (
      <div className="text-passive-1 px-3 py-2 text-sm" data-srn-print-exclude="true">
        No headings found
      </div>
    )
  }

  // Smallest heading level present becomes the baseline (0 indent), so an index
  // that starts at h2 doesn't render with a stray leading indent.
  const minLevel = headings.reduce((min, [, , tag]) => Math.min(min, levelOf(tag)), MAX_TOC_LEVEL)

  return (
    <ul className="m-0 list-none p-0">
      {headings.map(([key, text, tag], index) => {
        const indent = levelOf(tag) - minLevel
        return (
          <li key={key} style={{ paddingLeft: `${indent * 1}rem` }}>
            <button
              type="button"
              data-srn-print-static-text="true"
              className="text-foreground hover:bg-contrast hover:text-info block w-full truncate rounded px-2 py-0.5 text-left text-sm outline-none"
              title={text || 'Untitled heading'}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => scrollToHeading(editor, key)}
            >
              {format.numbered ? `${index + 1}. ` : ''}
              {text || 'Untitled heading'}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function TableOfContentsComponent({ format }: { format: TableOfContentsFormat }): React.JSX.Element {
  const [editor] = useLexicalComposerContext()
  return (
    <div
      className="border-border bg-default my-2 rounded border"
      data-table-of-contents-block="true"
      data-super-widget-layout="compact"
    >
      {format.showTitle && (
        <div className="border-border text-passive-1 border-b px-3 py-1 text-xs font-semibold uppercase">
          Table of Contents
        </div>
      )}
      <div className="py-1">
        <TableOfContentsPlugin>
          {(entries) => <TableOfContentsList entries={entries} editor={editor} format={format} />}
        </TableOfContentsPlugin>
      </div>
    </div>
  )
}

export type SerializedTableOfContentsNode = SerializedLexicalNode & { format?: TableOfContentsFormat }

export class TableOfContentsNode extends DecoratorNode<React.JSX.Element> {
  __format: TableOfContentsFormat
  static getType(): string {
    return 'table-of-contents'
  }

  static clone(node: TableOfContentsNode): TableOfContentsNode {
    return new TableOfContentsNode(node.__key, node.__format)
  }

  constructor(key?: NodeKey, format?: Partial<TableOfContentsFormat>) {
    super(key)
    this.__format = normalizeTableOfContentsFormat(format)
  }

  static importJSON(_serializedNode: SerializedTableOfContentsNode): TableOfContentsNode {
    return new TableOfContentsNode(undefined, _serializedNode.format)
  }

  exportJSON(): SerializedTableOfContentsNode {
    return { type: 'table-of-contents', version: 1, format: this.getFormat() }
  }

  getFormat(): TableOfContentsFormat {
    return this.getLatest().__format
  }

  setFormat(format: Partial<TableOfContentsFormat>): void {
    this.getWritable().__format = normalizeTableOfContentsFormat({ ...this.getFormat(), ...format })
  }

  createDOM(): HTMLElement {
    const div = document.createElement('div')
    div.style.display = 'contents'
    return div
  }

  updateDOM(): false {
    return false
  }

  getTextContent(): string {
    return ''
  }

  isInline(): false {
    return false
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): React.JSX.Element {
    return <TableOfContentsComponent format={this.__format} />
  }
}

export function $createTableOfContentsNode(): TableOfContentsNode {
  return new TableOfContentsNode()
}

export function $isTableOfContentsNode(node: LexicalNode | null | undefined): node is TableOfContentsNode {
  return node instanceof TableOfContentsNode
}
