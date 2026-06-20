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
 * Music-staff block. The user writes **ABC notation** and we render it to a
 * music staff (SVG) via **abcjs** (lazy-loaded). ABC notation is a compact
 * text-based music format; abcjs renders it into a target DOM element.
 *
 * HONEST LIMITATIONS:
 *  - abcjs renders into a DOM element (`renderAbc(element, source)`), not a pure
 *    string->SVG function, so we render into a container ref.
 *  - abcjs is moderately heavy but is code-split (lazy `import()`), so it is only
 *    fetched when a staff block is actually rendered. SHIPPED (not deferred).
 *  - abcjs is tolerant of malformed input (it renders what it can and reports
 *    warnings); we surface any thrown error inline and keep the last good render.
 */

export const MUSIC_STAFF_VERSION = 1

export type MusicStaffData = {
  version: number
  /** ABC notation source. */
  source: string
}

const DEFAULT_SOURCE = `X:1
T:Scale
M:4/4
L:1/4
K:C
C D E F | G A B c |`

const DEFAULT_MUSIC_STAFF: MusicStaffData = {
  version: MUSIC_STAFF_VERSION,
  source: DEFAULT_SOURCE,
}

/**
 * Normalizes data from importJSON with backward-compatible defaults so old or
 * malformed data yields an editable block rather than throwing. Never throws.
 */
export function normalize(data: Partial<MusicStaffData> | undefined | null): MusicStaffData {
  if (data == null || typeof data !== 'object') {
    return { ...DEFAULT_MUSIC_STAFF }
  }
  return {
    version: MUSIC_STAFF_VERSION,
    source: typeof data.source === 'string' ? data.source : DEFAULT_SOURCE,
  }
}

function clone(data: MusicStaffData): MusicStaffData {
  return { ...data }
}

// Lazily-loaded abcjs singleton so the library is code-split and only fetched
// when a staff is actually rendered.
type AbcjsModule = {
  renderAbc: (target: HTMLElement | string, source: string, params?: object) => unknown
}
let abcjsPromise: Promise<AbcjsModule> | undefined
function loadAbcjs(): Promise<AbcjsModule> {
  if (!abcjsPromise) {
    abcjsPromise = import('abcjs').then((m) => (m as { default?: AbcjsModule }).default ?? (m as unknown as AbcjsModule))
  }
  return abcjsPromise
}

function MusicStaffComponent({
  data,
  nodeKey,
}: {
  data: MusicStaffData
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

  const render = useCallback(async (source: string) => {
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
    try {
      const abcjs = await loadAbcjs()
      abcjs.renderAbc(output, source, { responsive: 'resize' })
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void render(data.source)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.source])

  const commit = useCallback(() => {
    setEditing(false)
    editor.update(() => {
      const node = $getNodeByKey(nodeKey)
      if ($isMusicStaffNode(node)) {
        node.setData({ version: MUSIC_STAFF_VERSION, source: draft })
      }
    })
    void render(draft)
  }, [draft, editor, nodeKey, render])

  return (
    <div className="my-2 rounded border border-border bg-default" data-music-staff-block="true">
      <div className="flex items-center justify-between border-b border-border px-2 py-1 text-xs text-passive-1">
        <span className="font-semibold">Music staff</span>
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

      <div className="overflow-auto bg-white p-2">
        <div ref={outputRef} />
        {error ? <div className="mt-1 text-xs text-danger">{error}</div> : null}
      </div>
    </div>
  )
}

export type SerializedMusicStaffNode = Spread<{ data: MusicStaffData }, SerializedLexicalNode>

export class MusicStaffNode extends DecoratorNode<React.JSX.Element> {
  __data: MusicStaffData

  static getType(): string {
    return 'music-staff'
  }

  static clone(node: MusicStaffNode): MusicStaffNode {
    return new MusicStaffNode(node.__data, node.__key)
  }

  constructor(data: MusicStaffData, key?: NodeKey) {
    super(key)
    this.__data = data
  }

  static importJSON(serializedNode: SerializedMusicStaffNode): MusicStaffNode {
    return $createMusicStaffNode(normalize(serializedNode.data))
  }

  exportJSON(): SerializedMusicStaffNode {
    return { type: 'music-staff', version: 1, data: this.__data }
  }

  createDOM(): HTMLElement {
    const div = document.createElement('div')
    div.style.display = 'contents'
    return div
  }

  updateDOM(): false {
    return false
  }

  getData(): MusicStaffData {
    return this.getLatest().__data
  }

  setData(data: MusicStaffData): void {
    this.getWritable().__data = data
  }

  getTextContent(): string {
    return this.__data.source
  }

  isInline(): false {
    return false
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): React.JSX.Element {
    return <MusicStaffComponent data={this.__data} nodeKey={this.getKey()} />
  }
}

export function $createMusicStaffNode(data: MusicStaffData = DEFAULT_MUSIC_STAFF): MusicStaffNode {
  return new MusicStaffNode(clone(data))
}

export function $isMusicStaffNode(node: LexicalNode | null | undefined): node is MusicStaffNode {
  return node instanceof MusicStaffNode
}
