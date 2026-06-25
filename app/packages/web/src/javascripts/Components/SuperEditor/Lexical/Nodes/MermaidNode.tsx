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

/** Mermaid built-in themes that can be selected per-diagram. */
export const MERMAID_THEMES = ['default', 'dark', 'forest', 'neutral', 'base'] as const
export type MermaidTheme = (typeof MERMAID_THEMES)[number]
export const DEFAULT_MERMAID_THEME: MermaidTheme = 'default'

/** Split-pane view modes for the interactive editor. */
export const MERMAID_VIEW_MODES = ['split', 'code', 'preview'] as const
export type MermaidViewMode = (typeof MERMAID_VIEW_MODES)[number]
export const DEFAULT_MERMAID_VIEW_MODE: MermaidViewMode = 'split'

export const MERMAID_VERSION = 2

/** Debounce delay (ms) before re-rendering the preview while typing. */
const RENDER_DEBOUNCE_MS = 400

function isMermaidTheme(value: unknown): value is MermaidTheme {
  return typeof value === 'string' && (MERMAID_THEMES as readonly string[]).includes(value)
}

function isMermaidViewMode(value: unknown): value is MermaidViewMode {
  return typeof value === 'string' && (MERMAID_VIEW_MODES as readonly string[]).includes(value)
}

// Lazily loaded mermaid singleton so the heavy library is code-split and only
// fetched when a diagram is actually rendered.
let mermaidPromise: Promise<typeof import('mermaid').default> | undefined
function loadMermaid(): Promise<typeof import('mermaid').default> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => m.default)
  }
  return mermaidPromise
}

let renderSeq = 0

function MermaidComponent({
  code,
  theme,
  viewMode,
  nodeKey,
}: {
  code: string
  theme: MermaidTheme
  viewMode: MermaidViewMode
  nodeKey: NodeKey
}): React.JSX.Element {
  const [editor] = useLexicalComposerContext()
  // Local draft so typing in the textarea stays snappy; committed to the node
  // (and debounce-rendered) as it changes.
  const [draft, setDraft] = useState(code)
  const [svg, setSvg] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  // Incremented to force a re-render even when the source/theme are unchanged
  // (the Reload button).
  const [reloadToken, setReloadToken] = useState(0)
  // Guards against a late async render overwriting a newer one.
  const renderTokenRef = useRef(0)

  // Keep the draft in sync when the node's code changes from the outside
  // (e.g. undo/redo, collaborative edits).
  useEffect(() => {
    setDraft(code)
  }, [code])

  const render = useCallback(
    async (source: string, activeTheme: MermaidTheme) => {
      const token = ++renderTokenRef.current
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
          theme: activeTheme,
          fontFamily: 'inherit',
        })
        const id = `mermaid-${nodeKey}-${renderSeq++}`
        const { svg: rendered } = await mermaid.render(id, trimmed)
        // Drop the result if a newer render started in the meantime.
        if (token !== renderTokenRef.current) {
          return
        }
        setSvg(rendered)
        setError(null)
      } catch (e) {
        if (token !== renderTokenRef.current) {
          return
        }
        // Keep the last good diagram; show the error inline so a bad keystroke
        // never crashes the editor.
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [nodeKey],
  )

  // Debounced render whenever the draft, theme, or reload token changes.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      void render(draft, theme)
    }, RENDER_DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [draft, theme, reloadToken, render])

  // Invalidate any in-flight render when the component unmounts.
  useEffect(() => {
    return () => {
      renderTokenRef.current++
    }
  }, [])

  const persistCode = useCallback(
    (next: string) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey)
        if ($isMermaidNode(node)) {
          node.setCode(next)
        }
      })
    },
    [editor, nodeKey],
  )

  const onCodeChange = useCallback(
    (next: string) => {
      setDraft(next)
      persistCode(next)
    },
    [persistCode],
  )

  const setTheme = useCallback(
    (next: MermaidTheme) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey)
        if ($isMermaidNode(node)) {
          node.setTheme(next)
        }
      })
    },
    [editor, nodeKey],
  )

  const setViewMode = useCallback(
    (next: MermaidViewMode) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey)
        if ($isMermaidNode(node)) {
          node.setViewMode(next)
        }
      })
    },
    [editor, nodeKey],
  )

  const reload = useCallback(() => {
    setReloadToken((t) => t + 1)
  }, [])

  const showCode = viewMode === 'split' || viewMode === 'code'
  const showPreview = viewMode === 'split' || viewMode === 'preview'

  return (
    <div className="my-2 rounded border border-border bg-default" data-mermaid-block="true">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-2 py-1 text-xs text-passive-1">
        <span className="font-semibold">Mermaid diagram</span>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded border border-border" role="group" aria-label="View mode">
            {MERMAID_VIEW_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                className={
                  'px-2 py-0.5 capitalize ' +
                  (viewMode === mode ? 'bg-info text-info-contrast' : 'hover:bg-contrast')
                }
                aria-pressed={viewMode === mode}
                onClick={() => setViewMode(mode)}
              >
                {mode}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1">
            Theme
            <select
              className="rounded border border-border bg-default px-1 py-0.5 text-foreground outline-none focus:border-info"
              value={theme}
              onChange={(e) => setTheme(e.target.value as MermaidTheme)}
              aria-label="Diagram theme"
            >
              {MERMAID_THEMES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="rounded px-2 py-0.5 hover:bg-contrast"
            onClick={reload}
            title="Re-render the diagram"
          >
            Reload
          </button>
        </div>
      </div>

      <div className={'flex ' + (viewMode === 'split' ? 'flex-col md:flex-row' : 'flex-col')}>
        {showCode ? (
          <div className={'flex flex-col ' + (viewMode === 'split' ? 'md:w-1/2 md:border-r md:border-border' : 'w-full')}>
            <textarea
              className="w-full resize-y bg-default p-2 font-mono text-sm text-foreground outline-none"
              rows={Math.max(6, draft.split('\n').length + 1)}
              value={draft}
              spellCheck={false}
              onChange={(e) => onCodeChange(e.target.value)}
              placeholder="Enter mermaid source…"
              aria-label="Mermaid source"
            />
          </div>
        ) : null}

        {showPreview ? (
          <div className={'overflow-auto p-2 ' + (viewMode === 'split' ? 'md:w-1/2' : 'w-full')}>
            {svg ? (
              <div dangerouslySetInnerHTML={{ __html: svg }} />
            ) : (
              !error && <div className="text-sm text-passive-1">Empty diagram</div>
            )}
            {error ? (
              <div className="mt-1 whitespace-pre-wrap text-xs text-danger" role="alert">
                {error}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export type SerializedMermaidNode = Spread<
  { code: string; theme: MermaidTheme; viewMode: MermaidViewMode },
  SerializedLexicalNode
>

export class MermaidNode extends DecoratorNode<React.JSX.Element> {
  __code: string
  __theme: MermaidTheme
  __viewMode: MermaidViewMode

  static getType(): string {
    return 'mermaid'
  }

  static clone(node: MermaidNode): MermaidNode {
    return new MermaidNode(node.__code, node.__theme, node.__viewMode, node.__key)
  }

  constructor(code: string, theme: MermaidTheme = DEFAULT_MERMAID_THEME, viewMode: MermaidViewMode = DEFAULT_MERMAID_VIEW_MODE, key?: NodeKey) {
    super(key)
    this.__code = code
    this.__theme = theme
    this.__viewMode = viewMode
  }

  static importJSON(serializedNode: SerializedMermaidNode): MermaidNode {
    // Backward-compatible: old nodes (version 1) stored only `code`; theme and
    // viewMode are absent and fall back to defaults. Some very old serializations
    // may even be a bare string — guard against that too.
    const raw = serializedNode as unknown
    if (typeof raw === 'string') {
      return $createMermaidNode(raw)
    }
    const code = typeof serializedNode.code === 'string' ? serializedNode.code : DEFAULT_MERMAID
    const theme = isMermaidTheme(serializedNode.theme) ? serializedNode.theme : DEFAULT_MERMAID_THEME
    const viewMode = isMermaidViewMode(serializedNode.viewMode) ? serializedNode.viewMode : DEFAULT_MERMAID_VIEW_MODE
    return $createMermaidNode(code, theme, viewMode)
  }

  exportJSON(): SerializedMermaidNode {
    return {
      type: 'mermaid',
      version: MERMAID_VERSION,
      code: this.__code,
      theme: this.__theme,
      viewMode: this.__viewMode,
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

  getTheme(): MermaidTheme {
    return this.getLatest().__theme
  }

  setTheme(theme: MermaidTheme): void {
    this.getWritable().__theme = theme
  }

  getViewMode(): MermaidViewMode {
    return this.getLatest().__viewMode
  }

  setViewMode(viewMode: MermaidViewMode): void {
    this.getWritable().__viewMode = viewMode
  }

  getTextContent(): string {
    return '```mermaid\n' + this.__code + '\n```'
  }

  isInline(): false {
    return false
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): React.JSX.Element {
    return (
      <MermaidComponent
        code={this.__code}
        theme={this.__theme}
        viewMode={this.__viewMode}
        nodeKey={this.getKey()}
      />
    )
  }
}

export function $createMermaidNode(
  code = DEFAULT_MERMAID,
  theme: MermaidTheme = DEFAULT_MERMAID_THEME,
  viewMode: MermaidViewMode = DEFAULT_MERMAID_VIEW_MODE,
): MermaidNode {
  return new MermaidNode(code, theme, viewMode)
}

export function $isMermaidNode(node: LexicalNode | null | undefined): node is MermaidNode {
  return node instanceof MermaidNode
}
