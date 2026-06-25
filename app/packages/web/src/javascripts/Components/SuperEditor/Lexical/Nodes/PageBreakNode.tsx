import * as React from 'react'
import {
  DecoratorNode,
  EditorConfig,
  LexicalEditor,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
} from 'lexical'
import { PAGE_BREAK_CLASS } from '../../Layout/applyPrintLayout'

/**
 * Standard Red Notes: a "Page break" block. On screen it renders as a clear
 * labelled horizontal divider so the author can see where the page will split;
 * when printing/exporting, the dynamic print stylesheet (see `applyPrintLayout`)
 * turns the `PAGE_BREAK_CLASS` element into a hard `break-after: page`.
 */
function PageBreakComponent(): React.JSX.Element {
  return (
    <div
      className={`${PAGE_BREAK_CLASS} my-4 flex select-none items-center gap-3 text-xs font-medium uppercase tracking-wide text-passive-1`}
      contentEditable={false}
      data-page-break="true"
    >
      <span className="h-px flex-grow border-t border-dashed border-border" />
      <span className="flex-shrink-0">Page break</span>
      <span className="h-px flex-grow border-t border-dashed border-border" />
    </div>
  )
}

export type SerializedPageBreakNode = SerializedLexicalNode

export class PageBreakNode extends DecoratorNode<React.JSX.Element> {
  static getType(): string {
    return 'page-break'
  }

  static clone(node: PageBreakNode): PageBreakNode {
    return new PageBreakNode(node.__key)
  }

  constructor(key?: NodeKey) {
    super(key)
  }

  static importJSON(_serializedNode: SerializedPageBreakNode): PageBreakNode {
    return $createPageBreakNode()
  }

  exportJSON(): SerializedPageBreakNode {
    return { type: 'page-break', version: 1 }
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
    return '\n'
  }

  isInline(): false {
    return false
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): React.JSX.Element {
    return <PageBreakComponent />
  }
}

export function $createPageBreakNode(): PageBreakNode {
  return new PageBreakNode()
}

export function $isPageBreakNode(node: LexicalNode | null | undefined): node is PageBreakNode {
  return node instanceof PageBreakNode
}
