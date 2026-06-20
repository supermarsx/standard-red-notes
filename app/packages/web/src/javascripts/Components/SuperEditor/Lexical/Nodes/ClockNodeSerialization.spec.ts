/**
 * @jest-environment jsdom
 *
 * Mirrors QrCodeNodeSerialization.spec.ts:
 *   1. ClockNode serialization round-trips (exportJSON -> importJSON ->
 *      exportJSON) including timezone + format options + world-clock zones.
 *   2. Old / missing / malformed data degrades to a sensible default clock
 *      rather than throwing (backward-compat).
 *
 * Constructing a node assigns a key, which is a write requiring an active
 * editor; node work runs inside editor.update().
 */

import { createHeadlessEditor } from '@lexical/headless'

import {
  $createClockNode,
  ClockData,
  ClockNode,
  DEFAULT_CLOCK_DATA,
  normalize,
  SerializedClockNode,
} from './ClockNode'

const editor = createHeadlessEditor({
  namespace: 'ClockNodeSerializationTest',
  nodes: [ClockNode],
  onError: (error) => {
    throw error
  },
})

function inEditor<T>(fn: () => T): T {
  let result: T
  editor.update(
    () => {
      result = fn()
    },
    { discrete: true },
  )
  return result!
}

const sampleData: ClockData = {
  version: 1,
  timeZone: 'Asia/Tokyo',
  hour24: false,
  showSeconds: false,
  showDate: false,
  worldClock: true,
  worldZones: ['Europe/London', 'America/New_York'],
}

describe('ClockNode serialization round-trip', () => {
  it('round-trips all config without loss', () => {
    const { first, second } = inEditor(() => {
      const first = $createClockNode(sampleData).exportJSON()
      const second = ClockNode.importJSON(first).exportJSON()
      return { first, second }
    })
    expect(second.data).toEqual(first.data)
    expect(second.data.timeZone).toBe('Asia/Tokyo')
    expect(second.data.hour24).toBe(false)
    expect(second.data.worldClock).toBe(true)
    expect(second.data.worldZones).toEqual(['Europe/London', 'America/New_York'])
  })

  it('keeps type and version stable', () => {
    const json = inEditor(() => $createClockNode(sampleData).exportJSON())
    expect(json.type).toBe('clock-widget')
    expect(json.type).toBe(ClockNode.getType())
    expect(json.version).toBe(1)
  })

  it('is a block node', () => {
    const inline = inEditor(() => $createClockNode(sampleData).isInline())
    expect(inline).toBe(false)
  })

  it('degrades gracefully when data is missing (old data)', () => {
    const legacy = { type: 'clock-widget', version: 1 } as unknown as SerializedClockNode
    const json = inEditor(() => ClockNode.importJSON(legacy).exportJSON())
    expect(json.data.timeZone).toBe('')
    expect(json.data.hour24).toBe(DEFAULT_CLOCK_DATA.hour24)
    expect(json.data.worldClock).toBe(false)
    expect(json.data.worldZones.length).toBeGreaterThan(0)
  })

  it('does not throw on a completely malformed data blob', () => {
    const garbage = { type: 'clock-widget', version: 1, data: 42 } as unknown as SerializedClockNode
    const json = inEditor(() => ClockNode.importJSON(garbage).exportJSON())
    expect(json.data.timeZone).toBe('')
    expect(json.data.worldZones.length).toBeGreaterThan(0)
  })
})

describe('normalize (backward-compat / coercion)', () => {
  it('returns defaults for null/undefined', () => {
    expect(normalize(null).timeZone).toBe('')
    expect(normalize(undefined).worldClock).toBe(false)
  })

  it('keeps the empty "follow configured" sentinel', () => {
    expect(normalize({ timeZone: '' }).timeZone).toBe('')
  })

  it('preserves a valid pinned zone', () => {
    expect(normalize({ timeZone: 'Europe/Berlin' }).timeZone).toBe('Europe/Berlin')
  })

  it('drops an unknown single zone back to "" (follow configured)', () => {
    expect(normalize({ timeZone: 'Bad/Zone' }).timeZone).toBe('')
  })

  it('coerces non-boolean flags to their defaults', () => {
    const result = normalize({
      hour24: 'yes' as unknown as boolean,
      showSeconds: 1 as unknown as boolean,
    })
    expect(result.hour24).toBe(DEFAULT_CLOCK_DATA.hour24)
    expect(result.showSeconds).toBe(DEFAULT_CLOCK_DATA.showSeconds)
  })

  it('filters invalid world zones and keeps valid ones', () => {
    const result = normalize({ worldZones: ['Asia/Tokyo', 'Bad/Zone', 'UTC'] })
    expect(result.worldZones).toEqual(['Asia/Tokyo', 'UTC'])
  })

  it('falls back to defaults when no world zones survive', () => {
    const result = normalize({ worldZones: ['Bad/Zone', 42 as unknown as string] })
    expect(result.worldZones.length).toBeGreaterThan(0)
    expect(result.worldZones.every((z) => typeof z === 'string')).toBe(true)
  })

  it('always stamps the current version', () => {
    expect(normalize({ version: 999 as unknown as number }).version).toBe(DEFAULT_CLOCK_DATA.version)
  })
})
