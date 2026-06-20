import * as React from 'react'
import { useCallback, useEffect, useState } from 'react'
import {
  DecoratorNode,
  DOMExportOutput,
  EditorConfig,
  LexicalEditor,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
  Spread,
} from 'lexical'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $getOrderedFootnoteReferences, footnoteEntryDomId, footnoteReferenceDomId } from './FootnoteShared'

/**
 * Inline superscript marker (e.g. `[1]`) that links to a footnote entry. The
 * displayed number is NOT stored: it is derived from the document order of all
 * FootnoteReferenceNodes so inserting/deleting/reordering renumbers everything.
 * The only persisted state is a stable `footnoteId` that pairs the reference
 * with its entry in the FootnotesNode.
 */
function FootnoteReferenceComponent({ footnoteId }: { footnoteId: string }): React.JSX.Element {
  const [editor] = useLexicalComposerContext()
  const [number, setNumber] = useState<number | null>(null)

  const computeNumber = useCallback(() => {
    editor.getEditorState().read(() => {
      const ordered = $getOrderedFootnoteReferences()
      const index = ordered.findIndex((node) => node.getFootnoteId() === footnoteId)
      setNumber(index >= 0 ? index + 1 : null)
    })
  }, [editor, footnoteId])

  // Recompute on every editor update: a sibling reference being added/removed
  // changes our number even though our own node didn't change.
  useEffect(() => {
    computeNumber()
    return editor.registerUpdateListener(() => {
      computeNumber()
    })
  }, [editor, computeNumber])

  const onActivate = useCallback(() => {
    const entry = editor.getRootElement()?.ownerDocument.getElementById(footnoteEntryDomId(footnoteId))
    if (entry) {
      scrollIntoViewIfNeeded(entry)
      const editable = entry.querySelector<HTMLElement>('[data-footnote-entry-input="true"]')
      editable?.focus()
    }
  }, [editor, footnoteId])

  const label = number != null ? `[${number}]` : '[?]'

  return (
    <sup
      id={footnoteReferenceDomId(footnoteId)}
      className="cursor-pointer select-none px-0.5 align-super text-[0.7em] font-semibold text-info"
      role="button"
      tabIndex={0}
      data-footnote-reference="true"
      data-footnote-id={footnoteId}
      title="Go to footnote"
      onClick={onActivate}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onActivate()
        }
      }}
    >
      {label}
    </sup>
  )
}

/**
 * Scroll an element into view only when it is not already fully visible, so we
 * don't yank the viewport for footnotes already on screen.
 */
function scrollIntoViewIfNeeded(element: HTMLElement): void {
  const rect = element.getBoundingClientRect()
  const viewHeight = window.innerHeight || document.documentElement.clientHeight
  const fullyVisible = rect.top >= 0 && rect.bottom <= viewHeight
  if (!fullyVisible) {
    element.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
}

export type SerializedFootnoteReferenceNode = Spread<{ footnoteId: string }, SerializedLexicalNode>

export class FootnoteReferenceNode extends DecoratorNode<React.JSX.Element> {
  __footnoteId: string

  static getType(): string {
    return 'footnote-reference'
  }

  static clone(node: FootnoteReferenceNode): FootnoteReferenceNode {
    return new FootnoteReferenceNode(node.__footnoteId, node.__key)
  }

  constructor(footnoteId: string, key?: NodeKey) {
    super(key)
    this.__footnoteId = footnoteId
  }

  static importJSON(serializedNode: SerializedFootnoteReferenceNode): FootnoteReferenceNode {
    return $createFootnoteReferenceNode(serializedNode.footnoteId || createFootnoteId())
  }

  exportJSON(): SerializedFootnoteReferenceNode {
    return {
      type: 'footnote-reference',
      version: 1,
      footnoteId: this.__footnoteId,
    }
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('sup')
    element.setAttribute('data-footnote-reference', 'true')
    element.setAttribute('data-footnote-id', this.__footnoteId)
    element.textContent = '[fn]'
    return { element }
  }

  createDOM(): HTMLElement {
    const span = document.createElement('span')
    span.style.display = 'inline'
    return span
  }

  updateDOM(): false {
    return false
  }

  getFootnoteId(): string {
    return this.getLatest().__footnoteId
  }

  setFootnoteId(footnoteId: string): void {
    this.getWritable().__footnoteId = footnoteId
  }

  getTextContent(): string {
    return '[^]'
  }

  isInline(): true {
    return true
  }

  isKeyboardSelectable(): boolean {
    return true
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): React.JSX.Element {
    return <FootnoteReferenceComponent footnoteId={this.__footnoteId} />
  }
}

let footnoteIdCounter = 0

/**
 * Stable, document-unique id used to pair a reference with its entry. Combines a
 * time component, a random component, and a monotonic counter so ids minted in
 * the same millisecond (e.g. rapid inserts) never collide.
 */
export function createFootnoteId(): string {
  footnoteIdCounter += 1
  const random = Math.random().toString(36).slice(2, 8)
  return `fn-${Date.now().toString(36)}-${footnoteIdCounter.toString(36)}-${random}`
}

export function $createFootnoteReferenceNode(footnoteId: string = createFootnoteId()): FootnoteReferenceNode {
  return new FootnoteReferenceNode(footnoteId)
}

export function $isFootnoteReferenceNode(node: LexicalNode | null | undefined): node is FootnoteReferenceNode {
  return node instanceof FootnoteReferenceNode
}
