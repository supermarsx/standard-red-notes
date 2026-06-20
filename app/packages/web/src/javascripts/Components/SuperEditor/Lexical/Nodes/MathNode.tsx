import * as React from 'react'
import { useCallback, useEffect, useState } from 'react'
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

const DEFAULT_EQUATION = '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}'

function MathComponent({ equation, nodeKey }: { equation: string; nodeKey: NodeKey }): React.JSX.Element {
  const [editor] = useLexicalComposerContext()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(equation)
  const [html, setHtml] = useState<string>('')

  useEffect(() => {
    setDraft(equation)
  }, [equation])

  const render = useCallback(async (source: string) => {
    const trimmed = source.trim()
    if (!trimmed) {
      setHtml('')
      return
    }
    // KaTeX with throwOnError:false never throws; invalid LaTeX produces inline
    // error markup which we render as-is rather than crashing the editor.
    const rendered = await renderLatexToString(trimmed, true)
    setHtml(rendered)
  }, [])

  useEffect(() => {
    void render(equation)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [equation])

  const commit = useCallback(() => {
    setEditing(false)
    editor.update(() => {
      const node = $getNodeByKey(nodeKey)
      if ($isMathNode(node)) {
        node.setEquation(draft)
      }
    })
    void render(draft)
  }, [draft, editor, nodeKey, render])

  return (
    <div className="my-2 rounded border border-border bg-default" data-math-block="true">
      <div className="flex items-center justify-between border-b border-border px-2 py-1 text-xs text-passive-1">
        <span className="font-semibold">Equation</span>
        <button
          className="rounded px-2 py-0.5 hover:bg-contrast"
          onClick={() => (editing ? commit() : setEditing(true))}
          type="button"
        >
          {editing ? 'Done' : 'Edit'}
        </button>
      </div>

      {editing ? (
        <textarea
          className="w-full resize-y bg-default p-2 font-mono text-sm text-foreground outline-none"
          rows={Math.max(2, draft.split('\n').length + 1)}
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          autoFocus
        />
      ) : null}

      <div className="overflow-x-auto p-2 text-center">
        {html ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <div className="text-sm text-passive-1">Empty equation</div>
        )}
      </div>
    </div>
  )
}

export type SerializedMathNode = Spread<{ equation: string }, SerializedLexicalNode>

export class MathNode extends DecoratorNode<React.JSX.Element> {
  __equation: string

  static getType(): string {
    return 'math'
  }

  static clone(node: MathNode): MathNode {
    return new MathNode(node.__equation, node.__key)
  }

  constructor(equation: string, key?: NodeKey) {
    super(key)
    this.__equation = equation
  }

  static importJSON(serializedNode: SerializedMathNode): MathNode {
    return $createMathNode(serializedNode.equation ?? '')
  }

  exportJSON(): SerializedMathNode {
    return {
      type: 'math',
      version: 1,
      equation: this.__equation,
    }
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('div')
    element.setAttribute('data-lexical-math', 'true')
    element.setAttribute('data-display-mode', 'true')
    element.textContent = this.__equation
    return { element }
  }

  createDOM(): HTMLElement {
    const div = document.createElement('div')
    div.style.display = 'contents'
    return div
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
    return '$$\n' + this.__equation + '\n$$'
  }

  isInline(): false {
    return false
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): React.JSX.Element {
    return <MathComponent equation={this.__equation} nodeKey={this.getKey()} />
  }
}

export function $createMathNode(equation = DEFAULT_EQUATION): MathNode {
  return new MathNode(equation)
}

export function $isMathNode(node: LexicalNode | null | undefined): node is MathNode {
  return node instanceof MathNode
}
