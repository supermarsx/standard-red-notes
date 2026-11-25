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
  title: string
  subtitle: string
  font: 'document' | 'sans' | 'serif' | 'mono'
  alignment: 'start' | 'center' | 'end'
  titleSize: number
  subtitleSize: number
  entrySize: number
  titleWeight: 'normal' | 'semibold' | 'bold'
  titleItalic: boolean
  uppercaseTitle: boolean
  titleColor: string
  subtitleColor: string
  entryColor: string
  indentation: number
  entrySpacing: number
  wrapEntries: boolean
  appearance: 'card' | 'plain'
}

export const DEFAULT_TABLE_OF_CONTENTS_FORMAT: TableOfContentsFormat = {
  maxLevel: 6,
  numbered: false,
  showTitle: true,
  title: 'Table of Contents',
  subtitle: '',
  font: 'document',
  alignment: 'start',
  titleSize: 12,
  subtitleSize: 12,
  entrySize: 14,
  titleWeight: 'semibold',
  titleItalic: false,
  uppercaseTitle: true,
  titleColor: '',
  subtitleColor: '',
  entryColor: '',
  indentation: 16,
  entrySpacing: 2,
  wrapEntries: false,
  appearance: 'card',
}

const boundedNumber = (value: unknown, fallback: number, min: number, max: number): number => {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
}
const color = (value: unknown): string => {
  return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value : ''
}

export function normalizeTableOfContentsFormat(value?: Partial<TableOfContentsFormat>): TableOfContentsFormat {
  return {
    maxLevel:
      typeof value?.maxLevel === 'number' && Number.isFinite(value.maxLevel)
        ? Math.max(1, Math.min(MAX_TOC_LEVEL, Math.trunc(value.maxLevel)))
        : MAX_TOC_LEVEL,
    numbered: value?.numbered === true,
    showTitle: value?.showTitle !== false,
    title: typeof value?.title === 'string' ? value.title.slice(0, 256) : DEFAULT_TABLE_OF_CONTENTS_FORMAT.title,
    subtitle: typeof value?.subtitle === 'string' ? value.subtitle.slice(0, 1000) : '',
    font: value?.font === 'sans' || value?.font === 'serif' || value?.font === 'mono' ? value.font : 'document',
    alignment: value?.alignment === 'center' || value?.alignment === 'end' ? value.alignment : 'start',
    titleSize: boundedNumber(value?.titleSize, 12, 8, 48),
    subtitleSize: boundedNumber(value?.subtitleSize, 12, 8, 32),
    entrySize: boundedNumber(value?.entrySize, 14, 8, 32),
    titleWeight: value?.titleWeight === 'normal' || value?.titleWeight === 'bold' ? value.titleWeight : 'semibold',
    titleItalic: value?.titleItalic === true,
    uppercaseTitle: value?.uppercaseTitle !== false,
    titleColor: color(value?.titleColor),
    subtitleColor: color(value?.subtitleColor),
    entryColor: color(value?.entryColor),
    indentation: boundedNumber(value?.indentation, 16, 0, 64),
    entrySpacing: boundedNumber(value?.entrySpacing, 2, 0, 24),
    wrapEntries: value?.wrapEntries === true,
    appearance: value?.appearance === 'plain' ? 'plain' : 'card',
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
  const headings = entries.filter(([, text, tag]) => text.trim().length > 0 && levelOf(tag) <= format.maxLevel)

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
    <ul
      className="text-foreground m-0 list-none p-0"
      style={{ textAlign: format.alignment, fontSize: format.entrySize, color: format.entryColor || undefined }}
    >
      {headings.map(([key, text, tag], index) => {
        const indent = levelOf(tag) - minLevel
        return (
          <li
            key={key}
            style={{ paddingInlineStart: `${indent * format.indentation}px`, paddingBlock: format.entrySpacing }}
          >
            <button
              type="button"
              data-srn-print-static-text="true"
              className={`text-foreground hover:bg-contrast hover:text-info block w-full rounded px-2 outline-none ${format.wrapEntries ? 'break-words whitespace-normal' : 'truncate'}`}
              style={{
                textAlign: 'inherit',
                fontSize: 'inherit',
                color: 'inherit',
              }}
              title={text}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => scrollToHeading(editor, key)}
            >
              {format.numbered ? `${index + 1}. ` : ''}
              {text}
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
      className={`my-2 ${format.appearance === 'card' ? 'border-border bg-default rounded border' : ''}`}
      style={{
        fontFamily: {
          document: 'inherit',
          sans: 'ui-sans-serif, sans-serif',
          serif: 'ui-serif, serif',
          mono: 'ui-monospace, monospace',
        }[format.font],
        textAlign: format.alignment,
        lineHeight: 1.5,
      }}
      data-table-of-contents-block="true"
      data-super-widget-layout="compact"
    >
      {((format.showTitle && format.title.trim()) || format.subtitle.trim()) && (
        <div className={`px-3 py-2 ${format.appearance === 'card' ? 'border-border border-b' : ''}`}>
          {format.showTitle && format.title.trim() && (
            <div
              data-toc-title="true"
              className="text-passive-1 break-words"
              style={{
                fontSize: format.titleSize,
                lineHeight: 1.25,
                fontWeight: { normal: 400, semibold: 600, bold: 700 }[format.titleWeight],
                fontStyle: format.titleItalic ? 'italic' : 'normal',
                textTransform: format.uppercaseTitle ? 'uppercase' : 'none',
                color: format.titleColor || undefined,
              }}
            >
              {format.title}
            </div>
          )}
          {format.subtitle.trim() && (
            <div
              data-toc-subtitle="true"
              className="text-passive-1 mt-1 break-words whitespace-pre-wrap"
              style={{
                fontSize: format.subtitleSize,
                color: format.subtitleColor || undefined,
              }}
            >
              {format.subtitle}
            </div>
          )}
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

export type SerializedTableOfContentsNode = SerializedLexicalNode & { format?: Partial<TableOfContentsFormat> }

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
    // Older collaborators can sync the original three-field format directly.
    return normalizeTableOfContentsFormat(this.getLatest().__format)
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
    return <TableOfContentsComponent format={this.getFormat()} />
  }
}

export function $createTableOfContentsNode(): TableOfContentsNode {
  return new TableOfContentsNode()
}

export function $isTableOfContentsNode(node: LexicalNode | null | undefined): node is TableOfContentsNode {
  return node instanceof TableOfContentsNode
}
