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

const DEFAULT_MERMAID = 'graph TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[OK]\n  B -->|No| D[Rethink]'

// Lazily loaded mermaid singleton so the heavy library is code-split and only
// fetched when a diagram is actually rendered.
let mermaidPromise: Promise<typeof import('mermaid').default> | undefined
function loadMermaid(): Promise<typeof import('mermaid').default> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => m.default)
  }
  return mermaidPromise
}

function prefersDark(): boolean {
  try {
    const bg = getComputedStyle(document.body).backgroundColor
    const match = bg.match(/\d+/g)
    if (match && match.length >= 3) {
      const [r, g, b] = match.map(Number)
      // Perceived luminance; < 0.5 => dark theme.
      return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5
    }
  } catch {
    /* ignore */
  }
  return false
}

let renderSeq = 0

function MermaidComponent({
  code,
  nodeKey,
}: {
  code: string
  nodeKey: NodeKey
}): React.JSX.Element {
  const [editor] = useLexicalComposerContext()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(code)
  const [svg, setSvg] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setDraft(code)
  }, [code])

  const render = useCallback(async (source: string) => {
    const trimmed = source.trim()
    if (!trimmed) {
      setSvg('')
      setError(null)
      return
    }
    try {
      const mermaid = await loadMermaid()
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: prefersDark() ? 'dark' : 'default',
        fontFamily: 'inherit',
      })
      const id = `mermaid-${nodeKey}-${renderSeq++}`
      const { svg: rendered } = await mermaid.render(id, trimmed)
      setSvg(rendered)
      setError(null)
    } catch (e) {
      // Keep the last good diagram; show the error inline.
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [nodeKey])

  useEffect(() => {
    void render(code)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code])

  const commit = useCallback(() => {
    setEditing(false)
    editor.update(() => {
      const node = $getNodeByKey(nodeKey)
      if ($isMermaidNode(node)) {
        node.setCode(draft)
      }
    })
    void render(draft)
  }, [draft, editor, nodeKey, render])

  return (
    <div
      ref={containerRef}
      className="my-2 rounded border border-border bg-default"
      data-mermaid-block="true"
    >
      <div className="flex items-center justify-between border-b border-border px-2 py-1 text-xs text-passive-1">
        <span className="font-semibold">Mermaid diagram</span>
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
          rows={Math.max(4, draft.split('\n').length + 1)}
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          autoFocus
        />
      ) : null}

      <div className="overflow-auto p-2">
        {svg ? (
          <div dangerouslySetInnerHTML={{ __html: svg }} />
        ) : (
          !error && <div className="text-sm text-passive-1">Empty diagram</div>
        )}
        {error ? <div className="mt-1 text-xs text-danger">{error}</div> : null}
      </div>
    </div>
  )
}

export type SerializedMermaidNode = Spread<{ code: string }, SerializedLexicalNode>

export class MermaidNode extends DecoratorNode<React.JSX.Element> {
  __code: string

  static getType(): string {
    return 'mermaid'
  }

  static clone(node: MermaidNode): MermaidNode {
    return new MermaidNode(node.__code, node.__key)
  }

  constructor(code: string, key?: NodeKey) {
    super(key)
    this.__code = code
  }

  static importJSON(serializedNode: SerializedMermaidNode): MermaidNode {
    return $createMermaidNode(serializedNode.code)
  }

  exportJSON(): SerializedMermaidNode {
    return {
      type: 'mermaid',
      version: 1,
      code: this.__code,
    }
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('pre')
    element.setAttribute('data-lexical-mermaid', 'true')
    const codeEl = document.createElement('code')
    codeEl.className = 'language-mermaid'
    codeEl.textContent = this.__code
    element.appendChild(codeEl)
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

  getCode(): string {
    return this.getLatest().__code
  }

  setCode(code: string): void {
    this.getWritable().__code = code
  }

  getTextContent(): string {
    return '```mermaid\n' + this.__code + '\n```'
  }

  isInline(): false {
    return false
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): React.JSX.Element {
    return <MermaidComponent code={this.__code} nodeKey={this.getKey()} />
  }
}

export function $createMermaidNode(code = DEFAULT_MERMAID): MermaidNode {
  return new MermaidNode(code)
}

export function $isMermaidNode(node: LexicalNode | null | undefined): node is MermaidNode {
  return node instanceof MermaidNode
}
