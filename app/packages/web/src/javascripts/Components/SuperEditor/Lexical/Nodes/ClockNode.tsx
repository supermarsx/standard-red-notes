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
import { useApplication } from '@/Components/ApplicationProvider'
import {
  ClockFormatOptions,
  formatDateInZone,
  formatTimeInZone,
  formatZoneOffsetLabel,
  getSupportedTimeZones,
  isValidTimeZone,
  timeZoneDisplayLabel,
} from '@/Timezone/timezone'
import { getConfiguredTimeZone as getAppConfiguredTimeZone } from '@/Timezone/timezoneService'

export const CLOCK_VERSION = 1

/**
 * Persisted config for a clock block.
 *
 * `timeZone === ''` means "use whatever timezone is configured in Preferences at
 * render time" (so the block follows the global setting). A concrete IANA id
 * pins the block to that zone. World-clock mode renders `worldZones` instead of
 * the single `timeZone`.
 */
export type ClockData = {
  version: number
  /** IANA zone id, or "" to follow the global configured zone. */
  timeZone: string
  /** 24-hour vs 12-hour time. */
  hour24: boolean
  /** Show seconds in the time. */
  showSeconds: boolean
  /** Show the date line under the time. */
  showDate: boolean
  /** When true, render the `worldZones` list instead of a single clock. */
  worldClock: boolean
  /** Zones shown in world-clock mode. */
  worldZones: string[]
}

const DEFAULT_WORLD_ZONES = ['America/New_York', 'Europe/London', 'Asia/Tokyo']

export const DEFAULT_CLOCK_DATA: ClockData = {
  version: CLOCK_VERSION,
  timeZone: '',
  hour24: true,
  showSeconds: true,
  showDate: true,
  worldClock: false,
  worldZones: DEFAULT_WORLD_ZONES,
}

function coerceBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Keep only valid IANA zones; fall back to the defaults if none survive. */
function coerceWorldZones(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_WORLD_ZONES]
  }
  const zones = value.filter((z): z is string => isValidTimeZone(z))
  return zones.length > 0 ? zones : [...DEFAULT_WORLD_ZONES]
}

/**
 * Normalizes data from importJSON with backward-compatible defaults. Notes
 * serialized before this widget existed (or with malformed/partial data) yield a
 * sensible default clock rather than throwing. An unknown single `timeZone`
 * degrades to "" ("follow configured zone"). Never throws.
 */
export function normalize(data: Partial<ClockData> | undefined | null): ClockData {
  if (data == null || typeof data !== 'object') {
    return { ...DEFAULT_CLOCK_DATA, worldZones: [...DEFAULT_WORLD_ZONES] }
  }
  const timeZone = data.timeZone === '' || data.timeZone == null ? '' : isValidTimeZone(data.timeZone) ? data.timeZone : ''
  return {
    version: CLOCK_VERSION,
    timeZone,
    hour24: coerceBool(data.hour24, DEFAULT_CLOCK_DATA.hour24),
    showSeconds: coerceBool(data.showSeconds, DEFAULT_CLOCK_DATA.showSeconds),
    showDate: coerceBool(data.showDate, DEFAULT_CLOCK_DATA.showDate),
    worldClock: coerceBool(data.worldClock, DEFAULT_CLOCK_DATA.worldClock),
    worldZones: coerceWorldZones(data.worldZones),
  }
}

function clone(data: ClockData): ClockData {
  return { ...data, worldZones: [...data.worldZones] }
}

/**
 * A live-updating clock. Ticks once per second (or per minute when seconds are
 * hidden) via setInterval, cleared on unmount. All formatting goes through
 * `Intl.DateTimeFormat` with an explicit `timeZone`.
 */
function ClockComponent({ data, nodeKey }: { data: ClockData; nodeKey: NodeKey }): React.JSX.Element {
  const [editor] = useLexicalComposerContext()
  const application = useApplication()
  const [now, setNow] = useState<Date>(() => new Date())

  // Live tick. Interval cleared on unmount / when cadence changes.
  useEffect(() => {
    const intervalMs = data.showSeconds ? 1000 : 1000 * 30
    const id = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(id)
  }, [data.showSeconds])

  // The zone this block resolves to: an empty config follows the global setting.
  const configuredZone = getAppConfiguredTimeZone(application)
  const effectiveZone = data.timeZone === '' ? configuredZone : data.timeZone

  const formatOptions: ClockFormatOptions = { hour24: data.hour24, showSeconds: data.showSeconds }

  const mutate = useCallback(
    (fn: (draft: ClockData) => void) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey)
        if ($isClockNode(node)) {
          const next = clone(node.getData())
          fn(next)
          node.setData(next)
        }
      })
    },
    [editor, nodeKey],
  )

  const zones = getSupportedTimeZones()

  return (
    <div className="my-2 rounded border border-border bg-default" data-clock-block="true">
      <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1 text-xs text-passive-1">
        <span className="font-semibold">Clock</span>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={data.worldClock}
            aria-label="World clock mode"
            onChange={(e) => mutate((d) => (d.worldClock = e.target.checked))}
          />
          World clock
        </label>
      </div>

      <div className="p-3">
        {data.worldClock ? (
          <ul className="flex flex-col gap-2">
            {data.worldZones.map((zone, index) => (
              <li key={`${zone}-${index}`} className="flex items-baseline justify-between gap-3">
                <span className="text-sm text-foreground">
                  {timeZoneDisplayLabel(zone)}
                  <span className="ml-1 text-xs text-passive-1">{formatZoneOffsetLabel(now, zone)}</span>
                </span>
                <span className="font-mono text-base text-foreground">{formatTimeInZone(now, zone, formatOptions)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex flex-col items-center">
            <div className="font-mono text-3xl text-foreground">{formatTimeInZone(now, effectiveZone, formatOptions)}</div>
            {data.showDate && <div className="mt-1 text-sm text-passive-1">{formatDateInZone(now, effectiveZone)}</div>}
            <div className="mt-1 text-xs text-passive-1">
              {timeZoneDisplayLabel(effectiveZone)}
              {data.timeZone === '' ? ' (configured)' : ''}
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-border px-2 py-2 text-xs text-passive-1">
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={data.hour24}
            aria-label="24-hour time"
            onChange={(e) => mutate((d) => (d.hour24 = e.target.checked))}
          />
          24-hour
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={data.showSeconds}
            aria-label="Show seconds"
            onChange={(e) => mutate((d) => (d.showSeconds = e.target.checked))}
          />
          Seconds
        </label>
        {!data.worldClock && (
          <>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={data.showDate}
                aria-label="Show date"
                onChange={(e) => mutate((d) => (d.showDate = e.target.checked))}
              />
              Date
            </label>
            <label className="flex items-center gap-1">
              Timezone
              <select
                className="rounded border border-border bg-default px-1 py-0.5 text-foreground"
                value={data.timeZone}
                aria-label="Clock timezone"
                onChange={(e) => mutate((d) => (d.timeZone = e.target.value))}
              >
                <option value="">Configured ({timeZoneDisplayLabel(configuredZone)})</option>
                {zones.map((zone) => (
                  <option key={zone} value={zone}>
                    {timeZoneDisplayLabel(zone)}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>
    </div>
  )
}

export type SerializedClockNode = Spread<{ data: ClockData }, SerializedLexicalNode>

export class ClockNode extends DecoratorNode<React.JSX.Element> {
  __data: ClockData

  static getType(): string {
    return 'clock-widget'
  }

  static clone(node: ClockNode): ClockNode {
    return new ClockNode(node.__data, node.__key)
  }

  constructor(data: ClockData, key?: NodeKey) {
    super(key)
    this.__data = data
  }

  static importJSON(serializedNode: SerializedClockNode): ClockNode {
    return $createClockNode(normalize(serializedNode.data))
  }

  exportJSON(): SerializedClockNode {
    return { type: 'clock-widget', version: 1, data: this.__data }
  }

  createDOM(): HTMLElement {
    const div = document.createElement('div')
    div.style.display = 'contents'
    return div
  }

  updateDOM(): false {
    return false
  }

  getData(): ClockData {
    return this.getLatest().__data
  }

  setData(data: ClockData): void {
    this.getWritable().__data = data
  }

  getTextContent(): string {
    return ''
  }

  isInline(): false {
    return false
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): React.JSX.Element {
    return <ClockComponent data={this.__data} nodeKey={this.getKey()} />
  }
}

export function $createClockNode(data: ClockData = DEFAULT_CLOCK_DATA): ClockNode {
  return new ClockNode(clone(data))
}

export function $isClockNode(node: LexicalNode | null | undefined): node is ClockNode {
  return node instanceof ClockNode
}
