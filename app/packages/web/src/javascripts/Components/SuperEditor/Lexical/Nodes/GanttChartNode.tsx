import * as React from 'react'
import { useCallback, useEffect, useState } from 'react'
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
 * Gantt-chart block. Reuses **mermaid** (already a dependency — see MermaidNode)
 * to render the chart. Instead of asking the user to hand-write mermaid `gantt`
 * syntax, this block provides a *structured* editor (title + a list of tasks,
 * each with a name, optional section, start date and duration); the structured
 * data is then compiled to mermaid `gantt` source via `buildGanttSource()` and
 * rendered. Parse/render errors are surfaced inline (the previous good render is
 * kept), mirroring MermaidNode.
 *
 * The node persists the STRUCTURED data (not the generated mermaid string) so it
 * stays editable; the mermaid source is derived on the fly.
 */

export const GANTT_VERSION = 1

export type GanttTask = {
  /** Task label shown in the chart. */
  name: string
  /** Optional section grouping. Empty string => no section. */
  section: string
  /**
   * Start date in YYYY-MM-DD. When empty, mermaid auto-chains the task after
   * the previous one (we emit `after <prevId>` / today for the first task).
   */
  start: string
  /** Duration token understood by mermaid, e.g. `3d`, `2w`, `1h`. */
  duration: string
}

export type GanttChartData = {
  version: number
  title: string
  tasks: GanttTask[]
}

const DEFAULT_GANTT: GanttChartData = {
  version: GANTT_VERSION,
  title: 'Project plan',
  tasks: [
    { name: 'Research', section: 'Phase 1', start: '2024-01-01', duration: '5d' },
    { name: 'Design', section: 'Phase 1', start: '', duration: '4d' },
    { name: 'Build', section: 'Phase 2', start: '', duration: '10d' },
    { name: 'Launch', section: 'Phase 2', start: '', duration: '2d' },
  ],
}

function coerceString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function coerceTask(value: unknown): GanttTask {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<GanttTask>
  return {
    name: coerceString(v.name),
    section: coerceString(v.section),
    start: coerceString(v.start),
    duration: coerceString(v.duration) || '1d',
  }
}

/**
 * Normalizes data from importJSON with backward-compatible defaults so old or
 * malformed data yields an editable block rather than throwing. Never throws.
 */
export function normalize(data: Partial<GanttChartData> | undefined | null): GanttChartData {
  if (data == null || typeof data !== 'object') {
    return cloneData(DEFAULT_GANTT)
  }
  const tasks = Array.isArray(data.tasks) ? data.tasks.map(coerceTask) : []
  return {
    version: GANTT_VERSION,
    title: typeof data.title === 'string' ? data.title : DEFAULT_GANTT.title,
    tasks,
  }
}

function cloneData(data: GanttChartData): GanttChartData {
  return { version: data.version, title: data.title, tasks: data.tasks.map((t) => ({ ...t })) }
}

/** Mermaid task ids must be alphanumeric; derive a stable, safe id per task. */
function taskId(index: number): string {
  return `t${index}`
}

/** Escape characters that would break a mermaid gantt task line. */
function sanitizeLabel(label: string): string {
  // Mermaid treats `:` and `,` as field separators on a task line; strip them.
  return label.replace(/[:,\n]/g, ' ').trim()
}

/**
 * Compile the structured data into mermaid `gantt` source. Tasks with an empty
 * start date are chained `after` the previous task (or start today when first),
 * which is the idiomatic mermaid way to express sequential work.
 */
export function buildGanttSource(data: GanttChartData): string {
  const lines: string[] = ['gantt', 'dateFormat YYYY-MM-DD']
  const title = sanitizeLabel(data.title)
  if (title) {
    lines.push(`title ${title}`)
  }

  let currentSection: string | null = null
  data.tasks.forEach((task, index) => {
    const name = sanitizeLabel(task.name) || `Task ${index + 1}`
    const section = sanitizeLabel(task.section)
    if (section && section !== currentSection) {
      lines.push(`section ${section}`)
      currentSection = section
    } else if (!section && currentSection !== null) {
      // A task with no section after a sectioned one: mermaid keeps it in the
      // last section; that is acceptable and avoids an empty `section`.
    }

    const id = taskId(index)
    const duration = sanitizeLabel(task.duration) || '1d'
    const start = task.start.trim()
    let timing: string
    if (start) {
      timing = `${start}, ${duration}`
    } else if (index === 0) {
      timing = `${duration}`
    } else {
      timing = `after ${taskId(index - 1)}, ${duration}`
    }
    lines.push(`${name} :${id}, ${timing}`)
  })

  return lines.join('\n')
}

// Lazily loaded mermaid singleton (mirrors MermaidNode) so the heavy library is
// code-split and only fetched when a chart is actually rendered.
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
      return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5
    }
  } catch {
    /* ignore */
  }
  return false
}

let renderSeq = 0

function GanttChartComponent({
  data,
  nodeKey,
}: {
  data: GanttChartData
  nodeKey: NodeKey
}): React.JSX.Element {
  const [editor] = useLexicalComposerContext()
  const [editing, setEditing] = useState(data.tasks.length === 0)
  const [svg, setSvg] = useState<string>('')
  const [error, setError] = useState<string | null>(null)

  const mutate = useCallback(
    (fn: (draft: GanttChartData) => void) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey)
        if ($isGanttChartNode(node)) {
          const next = cloneData(node.getData())
          fn(next)
          node.setData(next)
        }
      })
    },
    [editor, nodeKey],
  )

  const render = useCallback(
    async (source: GanttChartData) => {
      const code = buildGanttSource(source).trim()
      if (!source.tasks.length) {
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
        const id = `gantt-${nodeKey}-${renderSeq++}`
        const { svg: rendered } = await mermaid.render(id, code)
        setSvg(rendered)
        setError(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [nodeKey],
  )

  useEffect(() => {
    void render(data)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  const setTitle = (title: string) => mutate((d) => (d.title = title))
  const setTaskField = (index: number, field: keyof GanttTask, value: string) =>
    mutate((d) => {
      if (d.tasks[index]) {
        d.tasks[index] = { ...d.tasks[index], [field]: value }
      }
    })
  const addTask = () =>
    mutate((d) => d.tasks.push({ name: 'New task', section: '', start: '', duration: '1d' }))
  const removeTask = (index: number) => mutate((d) => d.tasks.splice(index, 1))

  return (
    <div className="my-2 rounded border border-border bg-default" data-gantt-block="true">
      <div className="flex items-center justify-between border-b border-border px-2 py-1 text-xs text-passive-1">
        <span className="font-semibold">Gantt chart</span>
        <button
          className="rounded px-2 py-0.5 hover:bg-contrast"
          onClick={() => setEditing((e) => !e)}
          type="button"
        >
          {editing ? 'Done' : 'Edit'}
        </button>
      </div>

      {editing ? (
        <div className="flex flex-col gap-2 p-2">
          <label className="flex flex-col gap-1 text-xs text-passive-1">
            Title
            <input
              className="rounded border border-border bg-default px-2 py-1 text-sm text-foreground outline-none focus:border-info"
              value={data.title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <div className="flex flex-col gap-2">
            {data.tasks.map((task, index) => (
              <div
                key={index}
                className="grid grid-cols-[1fr_1fr_auto] gap-1 rounded border border-border p-1 sm:grid-cols-[2fr_1fr_1fr_1fr_auto]"
              >
                <input
                  className="rounded border border-border bg-default px-2 py-1 text-sm text-foreground outline-none focus:border-info"
                  placeholder="Task name"
                  value={task.name}
                  onChange={(e) => setTaskField(index, 'name', e.target.value)}
                />
                <input
                  className="rounded border border-border bg-default px-2 py-1 text-sm text-foreground outline-none focus:border-info"
                  placeholder="Section"
                  value={task.section}
                  onChange={(e) => setTaskField(index, 'section', e.target.value)}
                />
                <input
                  className="rounded border border-border bg-default px-2 py-1 text-sm text-foreground outline-none focus:border-info"
                  placeholder="Start (YYYY-MM-DD)"
                  value={task.start}
                  onChange={(e) => setTaskField(index, 'start', e.target.value)}
                />
                <input
                  className="rounded border border-border bg-default px-2 py-1 text-sm text-foreground outline-none focus:border-info"
                  placeholder="Duration (3d)"
                  value={task.duration}
                  onChange={(e) => setTaskField(index, 'duration', e.target.value)}
                />
                <button
                  type="button"
                  className="rounded px-2 text-danger hover:bg-contrast"
                  title="Remove task"
                  onClick={() => removeTask(index)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="self-start rounded border border-border px-2 py-1 text-xs hover:bg-contrast"
            onClick={addTask}
          >
            Add task
          </button>
        </div>
      ) : null}

      <div className="overflow-auto p-2">
        {svg ? (
          <div dangerouslySetInnerHTML={{ __html: svg }} />
        ) : (
          !error && <div className="text-sm text-passive-1">Add a task to render the chart.</div>
        )}
        {error ? <div className="mt-1 text-xs text-danger">{error}</div> : null}
      </div>
    </div>
  )
}

export type SerializedGanttChartNode = Spread<{ data: GanttChartData }, SerializedLexicalNode>

export class GanttChartNode extends DecoratorNode<React.JSX.Element> {
  __data: GanttChartData

  static getType(): string {
    return 'gantt-chart'
  }

  static clone(node: GanttChartNode): GanttChartNode {
    return new GanttChartNode(node.__data, node.__key)
  }

  constructor(data: GanttChartData, key?: NodeKey) {
    super(key)
    this.__data = data
  }

  static importJSON(serializedNode: SerializedGanttChartNode): GanttChartNode {
    return $createGanttChartNode(normalize(serializedNode.data))
  }

  exportJSON(): SerializedGanttChartNode {
    return { type: 'gantt-chart', version: 1, data: this.__data }
  }

  createDOM(): HTMLElement {
    const div = document.createElement('div')
    div.style.display = 'contents'
    return div
  }

  updateDOM(): false {
    return false
  }

  getData(): GanttChartData {
    return this.getLatest().__data
  }

  setData(data: GanttChartData): void {
    this.getWritable().__data = data
  }

  getTextContent(): string {
    return '```mermaid\n' + buildGanttSource(this.__data) + '\n```'
  }

  isInline(): false {
    return false
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): React.JSX.Element {
    return <GanttChartComponent data={this.__data} nodeKey={this.getKey()} />
  }
}

export function $createGanttChartNode(data: GanttChartData = DEFAULT_GANTT): GanttChartNode {
  return new GanttChartNode(cloneData(data))
}

export function $isGanttChartNode(node: LexicalNode | null | undefined): node is GanttChartNode {
  return node instanceof GanttChartNode
}
