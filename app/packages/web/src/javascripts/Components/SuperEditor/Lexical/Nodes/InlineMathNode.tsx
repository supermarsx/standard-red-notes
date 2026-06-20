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
import { renderLatexToString } from './katexLoader'

const DEFAULT_INLINE_EQUATION = 'x^2 + y^2 = z^2'

function InlineMathComponent({ equation, nodeKey }: { equation: string; nodeKey: NodeKey }): React.JSX.Element {
  const [editor] = useLexicalComposerContext()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(equation)
  const [html, setHtml] = useState<string>('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    setDraft(equation)
  }, [equation])

  const render = useCallback(async (source: string) => {
    const trimmed = source.trim()
    if (!trimmed) {
      setHtml('')
      return
    }
    const rendered = await renderLatexToString(trimmed, false)
    setHtml(rendered)
  }, [])

  useEffect(() => {
    void render(equation)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [equation])

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const commit = useCallback(() => {
    setEditing(false)
    editor.update(() => {
      const node = $getNodeByKey(nodeKey)
      if ($isInlineMathNode(node)) {
        node.setEquation(draft)
      }
    })
    void render(draft)
  }, [draft, editor, nodeKey, render])

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="mx-0.5 inline rounded border border-border bg-default px-1 font-mono text-sm text-foreground outline-none"
        value={draft}
        spellCheck={false}
        size={Math.max(draft.length, 4)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
        }}
      />
    )
  }

  return (
    <span
      className="cursor-pointer align-middle"
      role="button"
      tabIndex={0}
      onClick={() => setEditing(true)}
      data-inline-math="true"
    >
      {html ? (
        <span dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <span className="text-passive-1">[empty math]</span>
      )}
    </span>
  )
}

export type SerializedInlineMathNode = Spread<{ equation: string }, SerializedLexicalNode>

export class InlineMathNode extends DecoratorNode<React.JSX.Element> {
  __equation: string

  static getType(): string {
    return 'inline-math'
  }

  static clone(node: InlineMathNode): InlineMathNode {
    return new InlineMathNode(node.__equation, node.__key)
  }

  constructor(equation: string, key?: NodeKey) {
    super(key)
    this.__equation = equation
  }

  static importJSON(serializedNode: SerializedInlineMathNode): InlineMathNode {
    return $createInlineMathNode(serializedNode.equation ?? '')
  }

  exportJSON(): SerializedInlineMathNode {
    return {
      type: 'inline-math',
      version: 1,
      equation: this.__equation,
    }
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('span')
    element.setAttribute('data-lexical-math', 'true')
    element.setAttribute('data-display-mode', 'false')
    element.textContent = this.__equation
    return { element }
  }

  createDOM(): HTMLElement {
    const span = document.createElement('span')
    span.style.display = 'inline-block'
    return span
  }

  updateDOM(): false {
    return false
  }

  getEquation(): string {
    return this.getLatest().__equation
  }

  setEquation(equation: string): void {
    this.getWritable().__equation = equation
  }

  getTextContent(): string {
    return '$' + this.__equation + '$'
  }

  isInline(): true {
    return true
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): React.JSX.Element {
    return <InlineMathComponent equation={this.__equation} nodeKey={this.getKey()} />
  }
}

export function $createInlineMathNode(equation = DEFAULT_INLINE_EQUATION): InlineMathNode {
  return new InlineMathNode(equation)
}

export function $isInlineMathNode(node: LexicalNode | null | undefined): node is InlineMathNode {
  return node instanceof InlineMathNode
}
