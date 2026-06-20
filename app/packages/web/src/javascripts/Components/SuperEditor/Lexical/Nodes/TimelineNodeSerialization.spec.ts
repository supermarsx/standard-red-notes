/**
 * @jest-environment jsdom
 *
 * Mirrors MathNodeSerialization.spec.ts / FootnoteNodeSerialization.spec.ts.
 * Two things are covered:
 *
 *   1. TimelineNode serialization round-trips (exportJSON -> importJSON ->
 *      exportJSON) including title, items, dates/ordinals and colors. Old /
 *      missing / malformed data degrades gracefully to an empty timeline rather
 *      than throwing.
 *   2. The pure waterfall/Gantt layout math (computeAxisRange + computeBarLayouts)
 *      maps item start..end onto the shared axis as left/width percentages.
 *
 * As with the other decorator nodes, constructing a node assigns a key, which is
 * a write requiring an active editor; node work runs inside editor.update().
 */

import { createHeadlessEditor } from '@lexical/headless'

import {
  $createTimelineNode,
  TimelineNode,
  SerializedTimelineNode,
  TimelineData,
  TimelineItem,
  computeAxisRange,
  computeBarLayouts,
  toAxisValue,
  DEFAULT_TIMELINE_TITLE,
} from './TimelineNode'

const editor = createHeadlessEditor({
  namespace: 'TimelineNodeSerializationTest',
  nodes: [TimelineNode],
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

const sampleData: TimelineData = {
  version: 1,
  title: 'Project plan',
  items: [
    { id: 'a', label: 'Design', start: '2026-01-01', end: '2026-02-01', color: '#3b82f6' },
    { id: 'b', label: 'Build', start: '2026-02-01', end: '2026-04-01' },
    { id: 'c', label: 'Phase', start: 1, end: 3 },
  ],
}

describe('TimelineNode serialization round-trip', () => {
  it('round-trips title, items, dates/ordinals and colors without loss', () => {
    const { first, second } = inEditor(() => {
      const first = $createTimelineNode(sampleData).exportJSON()
      const second = TimelineNode.importJSON(first).exportJSON()
      return { first, second }
    })
    expect(second.data).toEqual(first.data)
    expect(second.data.title).toBe('Project plan')
    expect(second.data.items).toHaveLength(3)
    expect(second.data.items[0].color).toBe('#3b82f6')
    expect(second.data.items[2].start).toBe(1)
  })

  it('keeps type and version stable', () => {
    const json = inEditor(() => $createTimelineNode(sampleData).exportJSON())
    expect(json.type).toBe('timeline')
    expect(json.type).toBe(TimelineNode.getType())
    expect(json.version).toBe(1)
  })

  it('is a block node', () => {
    const inline = inEditor(() => $createTimelineNode(sampleData).isInline())
    expect(inline).toBe(false)
  })

  it('degrades gracefully when data is missing (old data)', () => {
    const legacy = { type: 'timeline', version: 1 } as unknown as SerializedTimelineNode
    const json = inEditor(() => TimelineNode.importJSON(legacy).exportJSON())
    expect(json.data.items).toEqual([])
    expect(json.data.title).toBe(DEFAULT_TIMELINE_TITLE)
  })

  it('sanitizes malformed items on import', () => {
    const dirty = {
      type: 'timeline',
      version: 1,
      data: {
        title: 'Messy',
        items: [
          { id: 'ok', label: 'Good', start: '2026-01-01', end: '2026-02-01', color: '#abc' },
          null,
          { label: 'no id - id minted', start: 5, end: 7, color: 'notacolor' },
          'garbage',
        ],
      },
    } as unknown as SerializedTimelineNode
    const json = inEditor(() => TimelineNode.importJSON(dirty).exportJSON())
    expect(json.data.title).toBe('Messy')
    expect(json.data.items).toHaveLength(2)
    expect(json.data.items[0]).toEqual({
      id: 'ok',
      label: 'Good',
      start: '2026-01-01',
      end: '2026-02-01',
      color: '#abc',
    })
    // Bad color dropped, missing id minted, numeric bounds preserved.
    expect(json.data.items[1].color).toBeUndefined()
    expect(typeof json.data.items[1].id).toBe('string')
    expect(json.data.items[1].id.length).toBeGreaterThan(0)
    expect(json.data.items[1].start).toBe(5)
  })

  it('does not throw on a completely malformed data blob', () => {
    const garbage = { type: 'timeline', version: 1, data: 42 } as unknown as SerializedTimelineNode
    const json = inEditor(() => TimelineNode.importJSON(garbage).exportJSON())
    expect(json.data.items).toEqual([])
    expect(json.data.title).toBe(DEFAULT_TIMELINE_TITLE)
  })
})

describe('toAxisValue', () => {
  it('parses ISO dates to epoch ms', () => {
    expect(toAxisValue('2026-01-01')).toBe(Date.parse('2026-01-01'))
  })
  it('passes numbers through', () => {
    expect(toAxisValue(7)).toBe(7)
  })
  it('treats numeric strings as ordinals', () => {
    expect(toAxisValue('3')).toBe(3)
  })
  it('returns NaN for empty / unparseable values', () => {
    expect(Number.isNaN(toAxisValue(''))).toBe(true)
    expect(Number.isNaN(toAxisValue('not a date'))).toBe(true)
    expect(Number.isNaN(toAxisValue(undefined))).toBe(true)
  })
})

describe('computeAxisRange', () => {
  it('returns the min start and max end across items', () => {
    const items: TimelineItem[] = [
      { id: 'a', label: 'a', start: 0, end: 5 },
      { id: 'b', label: 'b', start: 2, end: 10 },
    ]
    expect(computeAxisRange(items)).toEqual({ min: 0, max: 10 })
  })
  it('ignores unparseable values', () => {
    const items: TimelineItem[] = [
      { id: 'a', label: 'a', start: '', end: 'nope' },
      { id: 'b', label: 'b', start: 4, end: 8 },
    ]
    expect(computeAxisRange(items)).toEqual({ min: 4, max: 8 })
  })
  it('returns null when nothing is parseable', () => {
    const items: TimelineItem[] = [{ id: 'a', label: 'a', start: '', end: '' }]
    expect(computeAxisRange(items)).toBeNull()
  })
})

describe('computeBarLayouts (waterfall/Gantt math)', () => {
  it('positions bars by their start..end proportion of the span', () => {
    // Axis [0, 10]. Item spanning 0..5 -> left 0%, width 50%. Item 2..10 ->
    // left 20%, width 80%.
    const items: TimelineItem[] = [
      { id: 'a', label: 'a', start: 0, end: 5 },
      { id: 'b', label: 'b', start: 2, end: 10 },
    ]
    const layouts = computeBarLayouts(items, 0, 10)
    expect(layouts.get('a')).toEqual({ left: 0, width: 50 })
    expect(layouts.get('b')).toEqual({ left: 20, width: 80 })
  })

  it('maps ISO dates to the same percentages as their epoch values', () => {
    const min = Date.parse('2026-01-01')
    const max = Date.parse('2026-01-11') // 10-day span
    const items: TimelineItem[] = [{ id: 'a', label: 'a', start: '2026-01-03', end: '2026-01-06' }]
    const layouts = computeBarLayouts(items, min, max)
    const layout = layouts.get('a')!
    // 2 days in -> 20%; 3-day duration -> 30%.
    expect(layout.left).toBeCloseTo(20, 5)
    expect(layout.width).toBeCloseTo(30, 5)
  })

  it('swaps reversed start/end so the bar still renders forward', () => {
    const items: TimelineItem[] = [{ id: 'a', label: 'a', start: 8, end: 2 }]
    const layouts = computeBarLayouts(items, 0, 10)
    expect(layouts.get('a')).toEqual({ left: 20, width: 60 })
  })

  it('gives a full-width bar when the value is unparseable (stays visible)', () => {
    const items: TimelineItem[] = [{ id: 'a', label: 'a', start: '', end: '' }]
    const layouts = computeBarLayouts(items, 0, 10)
    expect(layouts.get('a')).toEqual({ left: 0, width: 100 })
  })

  it('gives full-width bars when the span is zero (avoids divide-by-zero)', () => {
    const items: TimelineItem[] = [{ id: 'a', label: 'a', start: 5, end: 5 }]
    const layouts = computeBarLayouts(items, 5, 5)
    expect(layouts.get('a')).toEqual({ left: 0, width: 100 })
  })

  it('clamps a zero-duration bar to a minimum visible width', () => {
    const items: TimelineItem[] = [{ id: 'a', label: 'a', start: 5, end: 5 }]
    const layouts = computeBarLayouts(items, 0, 10)
    const layout = layouts.get('a')!
    expect(layout.left).toBe(50)
    expect(layout.width).toBe(1)
  })
})
