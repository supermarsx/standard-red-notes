import * as React from 'react'
import { useCallback } from 'react'
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
 * A single timeline item. `start`/`end` are either ISO date strings (e.g.
 * `2026-01-15`) or numbers used as ordinal positions on the axis. Dates are the
 * primary use case; numbers are tolerated so the same widget can model ordinal
 * sequences (phase 1, phase 2, …). `color` is an optional hex accent for the bar.
 */
export type TimelineItem = {
  id: string
  label: string
  start: string | number
  end: string | number
  color?: string
}

export type TimelineData = {
  version: number
  title: string
  items: TimelineItem[]
}

const uid = () => Math.random().toString(36).slice(2, 9)

export const DEFAULT_TIMELINE_TITLE = 'Timeline'

export const TIMELINE_VERSION = 1

/** A small palette offered as quick-pick swatches for each bar. */
export const TIMELINE_COLOR_PRESETS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7'] as const

/** True for `#rgb`/`#rrggbb` hex strings; anything else is treated as "no color". */
function isValidHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)
}

const DEFAULT_TIMELINE: TimelineData = {
  version: TIMELINE_VERSION,
  title: DEFAULT_TIMELINE_TITLE,
  items: [],
}

/**
 * Converts a start/end value to a numeric position on a shared axis. ISO date
 * strings become epoch milliseconds; numbers pass through; anything unparseable
 * yields NaN (callers filter those out). Never throws.
 */
export function toAxisValue(value: string | number | undefined | null): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return NaN
    // Prefer a pure number (ordinal) when the string is fully numeric.
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
    const time = Date.parse(trimmed)
    return Number.isNaN(time) ? NaN : time
  }
  return NaN
}

export type BarLayout = { left: number; width: number }

/**
 * Pure layout math for the waterfall/Gantt bars. Given the items and the shared
 * [min, max] axis span, returns the left offset and width of each bar as
 * percentages (0..100) of the total span, keyed by item id.
 *
 * - If an item's start/end can't be parsed, it spans the full axis (left 0,
 *   width 100) so it stays visible rather than vanishing.
 * - If start > end the two are swapped so the bar still renders forward.
 * - A zero-width span (single instant, or all items at one point) gives every
 *   bar full width to avoid divide-by-zero and an invisible 0%-wide bar.
 */
export function computeBarLayouts(items: TimelineItem[], min: number, max: number): Map<string, BarLayout> {
  const span = max - min
  const layouts = new Map<string, BarLayout>()
  for (const item of items) {
    let start = toAxisValue(item.start)
    let end = toAxisValue(item.end)
    if (Number.isNaN(start) || Number.isNaN(end) || !Number.isFinite(span) || span <= 0) {
      layouts.set(item.id, { left: 0, width: 100 })
      continue
    }
    if (start > end) {
      const tmp = start
      start = end
      end = tmp
    }
    const left = ((start - min) / span) * 100
    const width = Math.max(((end - start) / span) * 100, 1)
    layouts.set(item.id, {
      left: Math.min(Math.max(left, 0), 100),
      width: Math.min(width, 100 - Math.min(Math.max(left, 0), 100)),
    })
  }
  return layouts
}

/**
 * Computes the [min, max] of the axis across all items' start/end values. Items
 * with unparseable values are ignored. Returns null when nothing is parseable.
 */
export function computeAxisRange(items: TimelineItem[]): { min: number; max: number } | null {
  const values: number[] = []
  for (const item of items) {
    const start = toAxisValue(item.start)
    const end = toAxisValue(item.end)
    if (!Number.isNaN(start)) values.push(start)
    if (!Number.isNaN(end)) values.push(end)
  }
  if (values.length === 0) return null
  return { min: Math.min(...values), max: Math.max(...values) }
}

/** Human-readable rendering of a start/end value (date or ordinal). */
function formatAxisLabel(value: string | number): string {
  if (typeof value === 'number') return String(value)
  const trimmed = value.trim()
  if (trimmed === '') return ''
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed
  const time = Date.parse(trimmed)
  if (Number.isNaN(time)) return trimmed
  // Render bare ISO dates (YYYY-MM-DD) without a spurious timezone shift.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed
  return new Date(time).toLocaleDateString()
}

/** Coerce a start/end coming from JSON into a string|number, defaulting to ''. */
function coerceBound(value: unknown): string | number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') return value
  return ''
}

/**
 * Normalizes data from importJSON with backward-compatible defaults. Notes
 * serialized before this widget existed (or with malformed data) yield an empty
 * timeline rather than throwing. Invalid colors are dropped.
 */
function normalize(data: Partial<TimelineData> | undefined | null): TimelineData {
  const rawItems = Array.isArray(data?.items) ? data!.items : []
  const items: TimelineItem[] = rawItems
    .filter((item): item is TimelineItem => item != null && typeof item === 'object')
    .map((item) => {
      const next: TimelineItem = {
        id: typeof item.id === 'string' && item.id ? item.id : uid(),
        label: typeof item.label === 'string' ? item.label : '',
        start: coerceBound(item.start),
        end: coerceBound(item.end),
      }
      if (isValidHexColor(item.color)) next.color = item.color
      return next
    })
  return {
    version: TIMELINE_VERSION,
    title: typeof data?.title === 'string' ? data!.title : DEFAULT_TIMELINE_TITLE,
    items,
  }
}

function clone(data: TimelineData): TimelineData {
  return {
    version: data.version,
    title: data.title,
    items: data.items.map((item) => ({ ...item })),
  }
}

function TimelineComponent({ data, nodeKey }: { data: TimelineData; nodeKey: NodeKey }): React.JSX.Element {
  const [editor] = useLexicalComposerContext()

  const mutate = useCallback(
    (fn: (draft: TimelineData) => void) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey)
        if ($isTimelineNode(node)) {
          const draft = clone(node.getData())
          fn(draft)
          node.setData(draft)
        }
      })
    },
    [editor, nodeKey],
  )

  const renameTimeline = (title: string) => mutate((d) => (d.title = title))
  const addItem = () =>
    mutate((d) => d.items.push({ id: uid(), label: 'New item', start: '', end: '' }))
  const removeItem = (id: string) => mutate((d) => (d.items = d.items.filter((i) => i.id !== id)))
  const setLabel = (id: string, label: string) =>
    mutate((d) => {
      const item = d.items.find((i) => i.id === id)
      if (item) item.label = label
    })
  const setStart = (id: string, start: string) =>
    mutate((d) => {
      const item = d.items.find((i) => i.id === id)
      if (item) item.start = start
    })
  const setEnd = (id: string, end: string) =>
    mutate((d) => {
      const item = d.items.find((i) => i.id === id)
      if (item) item.end = end
    })
  const setColor = (id: string, color: string | undefined) =>
    mutate((d) => {
      const item = d.items.find((i) => i.id === id)
      if (!item) return
      if (isValidHexColor(color)) item.color = color
      else delete item.color
    })

  const range = computeAxisRange(data.items)
  const layouts = range ? computeBarLayouts(data.items, range.min, range.max) : new Map()

  return (
    <div className="my-2 rounded border border-border bg-default" data-timeline-block="true">
      <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1 text-xs text-passive-1">
        <input
          key={`timeline-title-${nodeKey}`}
          className="min-w-0 flex-grow bg-transparent font-semibold text-text outline-none"
          defaultValue={data.title}
          placeholder="Timeline title…"
          aria-label="Timeline title"
          onBlur={(e) => renameTimeline(e.target.value)}
        />
        <button
          className="flex-shrink-0 rounded px-2 py-0.5 hover:bg-contrast"
          onClick={addItem}
          type="button"
        >
          + Item
        </button>
      </div>

      {/* Waterfall / Gantt rendering: one row per item, each bar positioned by its
          start..end proportion of the shared axis. Scrolls horizontally on small
          screens so bars stay readable rather than squashing. */}
      <div className="overflow-x-auto p-2">
        {data.items.length === 0 ? (
          <div className="px-1 py-2 text-sm text-passive-1">No items yet. Use “+ Item” to add one.</div>
        ) : (
          <div className="flex min-w-[20rem] flex-col gap-1.5">
            {data.items.map((item) => {
              const layout = layouts.get(item.id) ?? { left: 0, width: 100 }
              const accent = item.color
              const startLabel = formatAxisLabel(item.start)
              const endLabel = formatAxisLabel(item.end)
              const rangeLabel =
                startLabel && endLabel ? `${startLabel} → ${endLabel}` : startLabel || endLabel || ''
              return (
                <div key={item.id} className="flex flex-col gap-0.5">
                  <div className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="min-w-0 truncate font-medium text-text">{item.label || 'Untitled'}</span>
                    {rangeLabel && <span className="flex-shrink-0 text-passive-1">{rangeLabel}</span>}
                  </div>
                  <div className="relative h-5 w-full overflow-hidden rounded bg-contrast">
                    <div
                      className="absolute top-0 flex h-full items-center rounded px-1.5 text-[0.65rem] text-info-contrast"
                      style={{
                        left: `${layout.left}%`,
                        width: `${layout.width}%`,
                        // Use the per-bar accent when present; otherwise fall back to
                        // the theme's `info` color so bars read in light AND dark.
                        backgroundColor: accent ?? 'var(--sn-stylekit-info-color)',
                      }}
                      title={rangeLabel ? `${item.label}: ${rangeLabel}` : item.label}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Editing list: add/remove items, set label + start + end + optional color. */}
      <div className="flex flex-col gap-2 border-t border-border p-2">
        {data.items.map((item) => (
          <div
            key={item.id}
            className="flex flex-col gap-1 rounded border border-border bg-contrast p-2 sm:flex-row sm:items-center"
          >
            <input
              key={`label-${item.id}`}
              className="min-w-0 flex-grow rounded border border-border bg-default px-2 py-1 text-sm text-foreground outline-none focus:border-info"
              defaultValue={item.label}
              placeholder="Label…"
              aria-label="Item label"
              onBlur={(e) => setLabel(item.id, e.target.value)}
            />
            <input
              key={`start-${item.id}`}
              className="rounded border border-border bg-default px-2 py-1 text-sm text-foreground outline-none focus:border-info"
              defaultValue={typeof item.start === 'number' ? String(item.start) : item.start}
              placeholder="Start (date or #)…"
              aria-label="Item start"
              onBlur={(e) => setStart(item.id, e.target.value)}
            />
            <input
              key={`end-${item.id}`}
              className="rounded border border-border bg-default px-2 py-1 text-sm text-foreground outline-none focus:border-info"
              defaultValue={typeof item.end === 'number' ? String(item.end) : item.end}
              placeholder="End (date or #)…"
              aria-label="Item end"
              onBlur={(e) => setEnd(item.id, e.target.value)}
            />
            <div className="flex items-center gap-1">
              <label
                className="relative h-5 w-5 flex-shrink-0 cursor-pointer rounded-full border border-border"
                style={{ backgroundColor: item.color ?? 'transparent' }}
                title="Pick a custom bar color"
              >
                <input
                  key={`color-${item.id}`}
                  type="color"
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  value={item.color ?? '#000000'}
                  onChange={(e) => setColor(item.id, e.target.value)}
                  aria-label="Bar color"
                />
              </label>
              {TIMELINE_COLOR_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className="h-4 w-4 flex-shrink-0 rounded-full border border-border"
                  style={{ backgroundColor: preset }}
                  title={`Set bar color ${preset}`}
                  aria-label={`Set bar color ${preset}`}
                  aria-pressed={item.color === preset}
                  onClick={() => setColor(item.id, preset)}
                />
              ))}
              <button
                type="button"
                className="rounded px-1 text-xs text-passive-1 hover:bg-default disabled:opacity-40"
                disabled={!item.color}
                onClick={() => setColor(item.id, undefined)}
                title="Clear bar color"
              >
                Clear
              </button>
              <button
                className="rounded px-1 text-passive-1 hover:bg-default hover:text-danger"
                onClick={() => removeItem(item.id)}
                title="Delete item"
                type="button"
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export type SerializedTimelineNode = Spread<{ data: TimelineData }, SerializedLexicalNode>

export class TimelineNode extends DecoratorNode<React.JSX.Element> {
  __data: TimelineData

  static getType(): string {
    return 'timeline'
  }

  static clone(node: TimelineNode): TimelineNode {
    return new TimelineNode(node.__data, node.__key)
  }

  constructor(data: TimelineData, key?: NodeKey) {
    super(key)
    this.__data = data
  }

  static importJSON(serializedNode: SerializedTimelineNode): TimelineNode {
    return $createTimelineNode(normalize(serializedNode.data))
  }

  exportJSON(): SerializedTimelineNode {
    return { type: 'timeline', version: 1, data: this.__data }
  }

  createDOM(): HTMLElement {
    const div = document.createElement('div')
    div.style.display = 'contents'
    return div
  }

  updateDOM(): false {
    return false
  }

  getData(): TimelineData {
    return this.getLatest().__data
  }

  setData(data: TimelineData): void {
    this.getWritable().__data = data
  }

  getTextContent(): string {
    const heading = `# ${this.__data.title}`
    const items = this.__data.items
      .map((item) => {
        const start = formatAxisLabel(item.start)
        const end = formatAxisLabel(item.end)
        const range = start && end ? ` (${start} → ${end})` : start || end ? ` (${start || end})` : ''
        return `- ${item.label}${range}`
      })
      .join('\n')
    return items ? `${heading}\n${items}` : heading
  }

  isInline(): false {
    return false
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): React.JSX.Element {
    return <TimelineComponent data={this.__data} nodeKey={this.getKey()} />
  }
}

export function $createTimelineNode(data: TimelineData = DEFAULT_TIMELINE): TimelineNode {
  return new TimelineNode(data)
}

export function $isTimelineNode(node: LexicalNode | null | undefined): node is TimelineNode {
  return node instanceof TimelineNode
}
