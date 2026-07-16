import * as React from 'react'
import { useCallback, useState } from 'react'
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

export type CalendarData = { events: Record<string, string[]> }

const DEFAULT_CALENDAR: CalendarData = { events: {} }

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

function dateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function CalendarComponent({ data, nodeKey }: { data: CalendarData; nodeKey: NodeKey }): React.JSX.Element {
  const [editor] = useLexicalComposerContext()
  const now = new Date()
  const [view, setView] = useState({ year: now.getFullYear(), month: now.getMonth() })
  const [selected, setSelected] = useState<string | null>(null)

  const mutate = useCallback(
    (fn: (events: Record<string, string[]>) => void) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey)
        if ($isCalendarNode(node)) {
          const events: Record<string, string[]> = JSON.parse(JSON.stringify(node.getData().events))
          fn(events)
          node.setData({ events })
        }
      })
    },
    [editor, nodeKey],
  )

  const addEvent = (key: string, text: string) => {
    const trimmed = text.trim()
    if (!trimmed) {
      return
    }
    mutate((events) => {
      events[key] = [...(events[key] ?? []), trimmed]
    })
  }
  const removeEvent = (key: string, index: number) =>
    mutate((events) => {
      events[key] = (events[key] ?? []).filter((_, i) => i !== index)
      if (events[key].length === 0) {
        delete events[key]
      }
    })

  const shiftMonth = (delta: number) =>
    setView((v) => {
      const m = v.month + delta
      const year = v.year + Math.floor(m / 12)
      const month = ((m % 12) + 12) % 12
      return { year, month }
    })

  const firstDay = new Date(view.year, view.month, 1).getDay()
  const daysInMonth = new Date(view.year, view.month + 1, 0).getDate()
  const todayKey = dateKey(now.getFullYear(), now.getMonth(), now.getDate())

  const cells: (number | null)[] = []
  for (let i = 0; i < firstDay; i++) {
    cells.push(null)
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(d)
  }

  return (
    <div className="border-border bg-default my-2 rounded border" data-calendar-block="true">
      <div className="border-border flex items-center justify-between border-b px-2 py-1 text-sm">
        <button className="hover:bg-contrast rounded px-2 py-0.5" onClick={() => shiftMonth(-1)} type="button">
          ‹
        </button>
        <span className="font-semibold">
          {MONTHS[view.month]} {view.year}
        </span>
        <button className="hover:bg-contrast rounded px-2 py-0.5" onClick={() => shiftMonth(1)} type="button">
          ›
        </button>
      </div>
      <div className="text-passive-1 grid grid-cols-7 gap-px p-1 text-center text-[0.65rem]">
        {WEEKDAYS.map((w) => (
          <div key={w} className="py-0.5 font-semibold">
            {w}
          </div>
        ))}
        {cells.map((day, i) => {
          if (day === null) {
            return <div key={`empty-${i}`} />
          }
          const key = dateKey(view.year, view.month, day)
          const count = data.events[key]?.length ?? 0
          const isToday = key === todayKey
          const isSelected = key === selected
          return (
            <button
              key={key}
              type="button"
              onClick={() => setSelected(isSelected ? null : key)}
              className={`hover:bg-contrast flex aspect-square flex-col items-center justify-center rounded text-xs ${
                isSelected ? 'bg-info text-info-contrast' : isToday ? 'ring-info ring-1' : ''
              }`}
            >
              <span>{day}</span>
              {count > 0 && (
                <span className={`mt-0.5 h-1 w-1 rounded-full ${isSelected ? 'bg-info-contrast' : 'bg-info'}`} />
              )}
            </button>
          )
        })}
      </div>
      {selected && (
        <div className="border-border border-t p-2 text-sm">
          <div className="mb-1 font-semibold">{selected}</div>
          <ul className="mb-2 flex flex-col gap-1">
            {(data.events[selected] ?? []).map((event, index) => (
              <li key={index} className="bg-contrast flex items-center justify-between gap-2 rounded px-2 py-1">
                <span className="text-foreground min-w-0 break-words">{event}</span>
                <button
                  className="text-passive-1 hover:text-danger flex-shrink-0"
                  onClick={() => removeEvent(selected, index)}
                  type="button"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <input
            key={selected}
            className="border-border bg-default text-foreground focus:border-info w-full rounded border px-2 py-1 text-sm outline-none"
            placeholder="Add an event, press Enter…"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                addEvent(selected, e.currentTarget.value)
                e.currentTarget.value = ''
              }
            }}
            onBlur={(e) => {
              addEvent(selected, e.target.value)
              e.target.value = ''
            }}
          />
        </div>
      )}
    </div>
  )
}

export type SerializedCalendarNode = Spread<{ data: CalendarData }, SerializedLexicalNode>

export class CalendarNode extends DecoratorNode<React.JSX.Element> {
  __data: CalendarData

  static getType(): string {
    return 'calendar'
  }

  static clone(node: CalendarNode): CalendarNode {
    return new CalendarNode(node.__data, node.__key)
  }

  constructor(data: CalendarData, key?: NodeKey) {
    super(key)
    this.__data = data
  }

  static importJSON(serializedNode: SerializedCalendarNode): CalendarNode {
    return $createCalendarNode(serializedNode.data)
  }

  exportJSON(): SerializedCalendarNode {
    return { type: 'calendar', version: 1, data: this.__data }
  }

  createDOM(): HTMLElement {
    const div = document.createElement('div')
    div.style.display = 'contents'
    return div
  }

  updateDOM(): false {
    return false
  }

  getData(): CalendarData {
    return this.getLatest().__data
  }

  setData(data: CalendarData): void {
    this.getWritable().__data = data
  }

  getTextContent(): string {
    return Object.entries(this.__data.events)
      .map(([key, list]) => `${key}: ${list.join(', ')}`)
      .join('\n')
  }

  isInline(): false {
    return false
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): React.JSX.Element {
    return <CalendarComponent data={this.__data} nodeKey={this.getKey()} />
  }
}

export function $createCalendarNode(data: CalendarData = DEFAULT_CALENDAR): CalendarNode {
  return new CalendarNode(data)
}

export function $isCalendarNode(node: LexicalNode | null | undefined): node is CalendarNode {
  return node instanceof CalendarNode
}
