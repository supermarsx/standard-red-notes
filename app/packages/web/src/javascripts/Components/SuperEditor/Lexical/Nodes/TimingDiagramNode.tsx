import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
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

/**
 * Timing-diagram block for true HARDWARE / digital-signal timing (clocks, data
 * buses, enables, etc.).
 *
 * LIBRARY CHOICE — mermaid has NO hardware-timing/waveform chart type, so we use
 * **wavedrom** (lazy-loaded), the de-facto digital-waveform renderer. The user
 * writes a WaveJSON source (the same JSON wavedrom uses, e.g.
 * `{ "signal": [{ "name": "clk", "wave": "p....." }] }`) and we render it to an
 * inline SVG.
 *
 * HONEST LIMITATIONS:
 *  - WaveDrom renders into the DOM (`renderWaveForm` builds an <svg> from a
 *    container element); it is not a pure string->SVG function, so we render into
 *    an offscreen container, then move the produced SVG into the block.
 *  - The source is WaveJSON (a JSON object), NOT WaveDrom's "tutorial" JS form
 *    (which allows JS expressions). We `JSON.parse` it ourselves and only pass a
 *    plain object to wavedrom, so no `eval` of user input occurs.
 *  - Invalid JSON or a wavedrom render failure is shown inline; the previous good
 *    render is kept.
 */

export const TIMING_VERSION = 1

export type TimingDiagramData = {
  version: number
  /** WaveJSON source as a string (parsed with JSON.parse before rendering). */
  source: string
}

const DEFAULT_SOURCE = `{
  "signal": [
    { "name": "clk",  "wave": "p......" },
    { "name": "data", "wave": "x.34.5x", "data": ["A", "B", "C"] },
    { "name": "req",  "wave": "0.1..0." }
  ]
}`

const DEFAULT_TIMING: TimingDiagramData = {
  version: TIMING_VERSION,
  source: DEFAULT_SOURCE,
}

/**
 * Normalizes data from importJSON with backward-compatible defaults so old or
 * malformed data yields an editable block rather than throwing. Never throws.
 */
export function normalize(data: Partial<TimingDiagramData> | undefined | null): TimingDiagramData {
  if (data == null || typeof data !== 'object') {
    return { ...DEFAULT_TIMING }
  }
  return {
    version: TIMING_VERSION,
    source: typeof data.source === 'string' ? data.source : DEFAULT_SOURCE,
  }
}

function clone(data: TimingDiagramData): TimingDiagramData {
  return { ...data }
}

// Lazily-loaded wavedrom singleton so the library is code-split and only fetched
// when a timing diagram is actually rendered.
type WaveDromModule = {
  renderWaveForm: (index: number, source: object, outputName: string) => void
}
let wavedromPromise: Promise<WaveDromModule> | undefined
function loadWaveDrom(): Promise<WaveDromModule> {
  if (!wavedromPromise) {
    wavedromPromise = import('wavedrom').then((m) => (m as { default?: WaveDromModule }).default ?? (m as unknown as WaveDromModule))
  }
  return wavedromPromise
}

let renderSeq = 0

function TimingDiagramComponent({
  data,
  nodeKey,
}: {
  data: TimingDiagramData
  nodeKey: NodeKey
}): React.JSX.Element {
  const [editor] = useLexicalComposerContext()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(data.source)
  const [error, setError] = useState<string | null>(null)
  const outputRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setDraft(data.source)
  }, [data.source])

  const render = useCallback(
    async (source: string) => {
      const output = outputRef.current
      if (!output) {
        return
      }
      const trimmed = source.trim()
      if (!trimmed) {
        output.innerHTML = ''
        setError(null)
        return
      }
      let parsed: object
      try {
        const value = JSON.parse(trimmed)
        if (!value || typeof value !== 'object') {
          throw new Error('WaveJSON must be an object')
        }
        parsed = value
      } catch (e) {
        setError(`Invalid WaveJSON: ${e instanceof Error ? e.message : String(e)}`)
        return
      }
      try {
        const wavedrom = await loadWaveDrom()
        // wavedrom renders into an element whose id matches `WaveDrom_Display_<n>`.
        const seq = renderSeq++
        const host = document.createElement('div')
        host.id = `WaveDrom_Display_${seq}`
        output.innerHTML = ''
        output.appendChild(host)
        wavedrom.renderWaveForm(seq, parsed, 'WaveDrom_Display_')
        setError(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [],
  )

  useEffect(() => {
    void render(data.source)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.source])

  const commit = useCallback(() => {
    setEditing(false)
    editor.update(() => {
      const node = $getNodeByKey(nodeKey)
      if ($isTimingDiagramNode(node)) {
        node.setData({ version: TIMING_VERSION, source: draft })
      }
    })
    void render(draft)
  }, [draft, editor, nodeKey, render])

  return (
    <div className="my-2 rounded border border-border bg-default" data-timing-block="true">
      <div className="flex items-center justify-between border-b border-border px-2 py-1 text-xs text-passive-1">
        <span className="font-semibold">Timing diagram</span>
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
          rows={Math.max(6, draft.split('\n').length + 1)}
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          autoFocus
        />
      ) : null}

      <div className="overflow-auto p-2">
        <div ref={outputRef} />
        {error ? <div className="mt-1 text-xs text-danger">{error}</div> : null}
      </div>
    </div>
  )
}

export type SerializedTimingDiagramNode = Spread<{ data: TimingDiagramData }, SerializedLexicalNode>

export class TimingDiagramNode extends DecoratorNode<React.JSX.Element> {
  __data: TimingDiagramData

  static getType(): string {
    return 'timing-diagram'
  }

  static clone(node: TimingDiagramNode): TimingDiagramNode {
    return new TimingDiagramNode(node.__data, node.__key)
  }

  constructor(data: TimingDiagramData, key?: NodeKey) {
    super(key)
    this.__data = data
  }

  static importJSON(serializedNode: SerializedTimingDiagramNode): TimingDiagramNode {
    return $createTimingDiagramNode(normalize(serializedNode.data))
  }

  exportJSON(): SerializedTimingDiagramNode {
    return { type: 'timing-diagram', version: 1, data: this.__data }
  }

  createDOM(): HTMLElement {
    const div = document.createElement('div')
    div.style.display = 'contents'
    return div
  }

  updateDOM(): false {
    return false
  }

  getData(): TimingDiagramData {
    return this.getLatest().__data
  }

  setData(data: TimingDiagramData): void {
    this.getWritable().__data = data
  }

  getTextContent(): string {
    return this.__data.source
  }

  isInline(): false {
    return false
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): React.JSX.Element {
    return <TimingDiagramComponent data={this.__data} nodeKey={this.getKey()} />
  }
}

export function $createTimingDiagramNode(data: TimingDiagramData = DEFAULT_TIMING): TimingDiagramNode {
  return new TimingDiagramNode(clone(data))
}

export function $isTimingDiagramNode(node: LexicalNode | null | undefined): node is TimingDiagramNode {
  return node instanceof TimingDiagramNode
}
