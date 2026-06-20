import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  $getNodeByKey,
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
import {
  $getOrderedFootnoteReferences,
  FootnoteEntry,
  footnoteEntryDomId,
  footnoteReferenceDomId,
  orderEntriesByReferences,
} from './FootnoteShared'

/**
 * Block-level "Footnotes" section, rendered at the end of the note. A singleton
 * (one per document, enforced by FootnotePlugin) that owns the editable content
 * of every footnote entry, keyed by `footnoteId`. The displayed number and the
 * order of entries are derived from the document order of the reference markers,
 * not stored here, so the section always agrees with the inline numbering.
 */
function FootnotesComponent({ entries, nodeKey }: { entries: FootnoteEntry[]; nodeKey: NodeKey }): React.JSX.Element {
  const [editor] = useLexicalComposerContext()
  const [ordered, setOrdered] = useState<FootnoteEntry[]>(entries)

  const recompute = useCallback(() => {
    editor.getEditorState().read(() => {
      const orderedIds = $getOrderedFootnoteReferences().map((node) => node.getFootnoteId())
      const node = $getNodeByKey(nodeKey)
      const current = $isFootnotesNode(node) ? node.getEntries() : entries
      setOrdered(orderEntriesByReferences(orderedIds, current))
    })
  }, [editor, nodeKey, entries])

  useEffect(() => {
    recompute()
    return editor.registerUpdateListener(() => {
      recompute()
    })
  }, [editor, recompute])

  const updateEntry = useCallback(
    (footnoteId: string, content: string) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey)
        if ($isFootnotesNode(node)) {
          node.setEntryContent(footnoteId, content)
        }
      })
    },
    [editor, nodeKey],
  )

  const onBackLink = useCallback(
    (footnoteId: string) => {
      const ref = editor.getRootElement()?.ownerDocument.getElementById(footnoteReferenceDomId(footnoteId))
      if (ref) {
        scrollIntoViewIfNeeded(ref)
      }
    },
    [editor],
  )

  if (ordered.length === 0) {
    return <></>
  }

  return (
    <section
      className="mt-6 border-t border-border pt-3 text-sm"
      data-footnotes-section="true"
      aria-label="Footnotes"
    >
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-passive-1">Footnotes</div>
      <ol className="m-0 list-none p-0">
        {ordered.map((entry, index) => (
          <FootnoteEntryRow
            key={entry.footnoteId}
            number={index + 1}
            entry={entry}
            onChange={updateEntry}
            onBackLink={onBackLink}
          />
        ))}
      </ol>
    </section>
  )
}

function FootnoteEntryRow({
  number,
  entry,
  onChange,
  onBackLink,
}: {
  number: number
  entry: FootnoteEntry
  onChange: (footnoteId: string, content: string) => void
  onBackLink: (footnoteId: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(entry.content)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // Keep the local draft in sync when the stored content changes from elsewhere
  // (collaboration, undo) but the field is not being actively edited.
  useEffect(() => {
    if (document.activeElement !== textareaRef.current) {
      setDraft(entry.content)
    }
  }, [entry.content])

  return (
    <li
      id={footnoteEntryDomId(entry.footnoteId)}
      className="mb-2 flex items-start gap-2"
      data-footnote-entry="true"
      data-footnote-id={entry.footnoteId}
    >
      <button
        type="button"
        className="mt-0.5 shrink-0 cursor-pointer rounded px-1 text-xs font-semibold text-info hover:bg-info-backdrop"
        title="Back to reference"
        data-footnote-backlink="true"
        onClick={() => onBackLink(entry.footnoteId)}
      >
        {number}.
      </button>
      <textarea
        ref={textareaRef}
        className="min-h-[1.75rem] w-full resize-y rounded border border-transparent bg-transparent px-1 py-0.5 text-sm text-foreground outline-none hover:border-border focus:border-info"
        data-footnote-entry-input="true"
        rows={Math.max(1, draft.split('\n').length)}
        placeholder="Footnote text…"
        value={draft}
        spellCheck={true}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== entry.content) {
            onChange(entry.footnoteId, draft)
          }
        }}
      />
    </li>
  )
}

/**
 * Scroll an element into view only when it is not already fully visible.
 */
function scrollIntoViewIfNeeded(element: HTMLElement): void {
  const rect = element.getBoundingClientRect()
  const viewHeight = window.innerHeight || document.documentElement.clientHeight
  const fullyVisible = rect.top >= 0 && rect.bottom <= viewHeight
  if (!fullyVisible) {
    element.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
}

export type SerializedFootnotesNode = Spread<{ entries: FootnoteEntry[] }, SerializedLexicalNode>

export class FootnotesNode extends DecoratorNode<React.JSX.Element> {
  __entries: FootnoteEntry[]

  static getType(): string {
    return 'footnotes'
  }

  static clone(node: FootnotesNode): FootnotesNode {
    return new FootnotesNode(node.__entries, node.__key)
  }

  constructor(entries: FootnoteEntry[] = [], key?: NodeKey) {
    super(key)
    this.__entries = entries
  }

  static importJSON(serializedNode: SerializedFootnotesNode): FootnotesNode {
    const entries = Array.isArray(serializedNode.entries)
      ? serializedNode.entries
          .filter((entry) => entry && typeof entry.footnoteId === 'string')
          .map((entry) => ({ footnoteId: entry.footnoteId, content: typeof entry.content === 'string' ? entry.content : '' }))
      : []
    return $createFootnotesNode(entries)
  }

  exportJSON(): SerializedFootnotesNode {
    return {
      type: 'footnotes',
      version: 1,
      entries: this.__entries.map((entry) => ({ footnoteId: entry.footnoteId, content: entry.content })),
    }
  }

  exportDOM(): DOMExportOutput {
    const section = document.createElement('section')
    section.setAttribute('data-footnotes-section', 'true')
    this.__entries.forEach((entry, index) => {
      const p = document.createElement('p')
      p.setAttribute('data-footnote-id', entry.footnoteId)
      p.textContent = `${index + 1}. ${entry.content}`
      section.appendChild(p)
    })
    return { element: section }
  }

  createDOM(): HTMLElement {
    const div = document.createElement('div')
    div.style.display = 'contents'
    return div
  }

  updateDOM(): false {
    return false
  }

  getEntries(): FootnoteEntry[] {
    return this.getLatest().__entries
  }

  setEntries(entries: FootnoteEntry[]): void {
    this.getWritable().__entries = entries
  }

  setEntryContent(footnoteId: string, content: string): void {
    const self = this.getWritable()
    const existing = self.__entries.find((entry) => entry.footnoteId === footnoteId)
    if (existing) {
      self.__entries = self.__entries.map((entry) =>
        entry.footnoteId === footnoteId ? { footnoteId, content } : entry,
      )
    } else {
      self.__entries = [...self.__entries, { footnoteId, content }]
    }
  }

  hasEntry(footnoteId: string): boolean {
    return this.getLatest().__entries.some((entry) => entry.footnoteId === footnoteId)
  }

  addEntry(footnoteId: string, content = ''): void {
    if (this.hasEntry(footnoteId)) {
      return
    }
    const self = this.getWritable()
    self.__entries = [...self.__entries, { footnoteId, content }]
  }

  /**
   * Drop entries whose footnoteId is not in the supplied set of live reference
   * ids (orphan cleanup after a reference is deleted).
   */
  pruneOrphans(liveFootnoteIds: Set<string>): void {
    const self = this.getWritable()
    self.__entries = self.__entries.filter((entry) => liveFootnoteIds.has(entry.footnoteId))
  }

  getTextContent(): string {
    return this.__entries.map((entry, index) => `[${index + 1}] ${entry.content}`).join('\n')
  }

  isInline(): false {
    return false
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): React.JSX.Element {
    return <FootnotesComponent entries={this.__entries} nodeKey={this.getKey()} />
  }
}

export function $createFootnotesNode(entries: FootnoteEntry[] = []): FootnotesNode {
  return new FootnotesNode(entries)
}

export function $isFootnotesNode(node: LexicalNode | null | undefined): node is FootnotesNode {
  return node instanceof FootnotesNode
}
