/**
 * @jest-environment jsdom
 *
 * Mirrors QrCodeNodeSerialization.spec.ts:
 *   1. GanttChartNode serialization round-trips (exportJSON -> importJSON ->
 *      exportJSON) including title and the full task list.
 *   2. Old / missing / malformed data degrades gracefully to an editable block
 *      rather than throwing.
 *   3. buildGanttSource() generates valid mermaid `gantt` syntax from tasks.
 */

import { createHeadlessEditor } from '@lexical/headless'

import {
  $createGanttChartNode,
  buildGanttSource,
  GanttChartData,
  GanttChartNode,
  normalize,
  SerializedGanttChartNode,
} from './GanttChartNode'

const editor = createHeadlessEditor({
  namespace: 'GanttChartNodeSerializationTest',
  nodes: [GanttChartNode],
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

const sampleData: GanttChartData = {
  version: 1,
  title: 'Launch plan',
  tasks: [
    { name: 'Research', section: 'Phase 1', start: '2024-01-01', duration: '5d' },
    { name: 'Build', section: 'Phase 2', start: '', duration: '10d' },
  ],
}

describe('GanttChartNode serialization round-trip', () => {
  it('round-trips title and tasks without loss', () => {
    const { first, second } = inEditor(() => {
      const first = $createGanttChartNode(sampleData).exportJSON()
      const second = GanttChartNode.importJSON(first).exportJSON()
      return { first, second }
    })
    expect(second.data).toEqual(first.data)
    expect(second.data.title).toBe('Launch plan')
    expect(second.data.tasks).toHaveLength(2)
    expect(second.data.tasks[0]).toEqual(sampleData.tasks[0])
  })

  it('keeps type and version stable', () => {
    const json = inEditor(() => $createGanttChartNode(sampleData).exportJSON())
    expect(json.type).toBe('gantt-chart')
    expect(json.type).toBe(GanttChartNode.getType())
    expect(json.version).toBe(1)
  })

  it('is a block node', () => {
    const inline = inEditor(() => $createGanttChartNode(sampleData).isInline())
    expect(inline).toBe(false)
  })

  it('degrades gracefully when data is missing (old data)', () => {
    // No `data` key at all -> normalize(undefined) yields the editable default
    // block (with starter tasks) rather than throwing.
    const legacy = { type: 'gantt-chart', version: 1 } as unknown as SerializedGanttChartNode
    const json = inEditor(() => GanttChartNode.importJSON(legacy).exportJSON())
    expect(typeof json.data.title).toBe('string')
    expect(json.data.tasks.length).toBeGreaterThan(0)
  })

  it('coerces an explicitly empty/partial data object to an empty task list', () => {
    // A present-but-empty `data` object (not undefined) -> empty tasks.
    const partial = { type: 'gantt-chart', version: 1, data: { title: 'X' } } as unknown as SerializedGanttChartNode
    const json = inEditor(() => GanttChartNode.importJSON(partial).exportJSON())
    expect(json.data.title).toBe('X')
    expect(json.data.tasks).toEqual([])
  })

  it('does not throw on a completely malformed data blob', () => {
    const garbage = { type: 'gantt-chart', version: 1, data: 42 } as unknown as SerializedGanttChartNode
    const json = inEditor(() => GanttChartNode.importJSON(garbage).exportJSON())
    expect(json.data.tasks.length).toBeGreaterThan(0)
  })
})

describe('normalize', () => {
  it('returns defaults for null/undefined', () => {
    expect(normalize(null).tasks.length).toBeGreaterThan(0)
    expect(typeof normalize(undefined).title).toBe('string')
  })

  it('coerces non-array tasks to an empty array', () => {
    expect(normalize({ tasks: 'nope' as unknown as GanttChartData['tasks'] }).tasks).toEqual([])
  })

  it('coerces malformed task fields and supplies a default duration', () => {
    const out = normalize({
      tasks: [{ name: 5 as unknown as string }] as unknown as GanttChartData['tasks'],
    })
    expect(out.tasks[0]).toEqual({ name: '', section: '', start: '', duration: '1d' })
  })
})

describe('buildGanttSource', () => {
  it('emits a gantt header with dateFormat and title', () => {
    const src = buildGanttSource(sampleData)
    const lines = src.split('\n')
    expect(lines[0]).toBe('gantt')
    expect(lines).toContain('dateFormat YYYY-MM-DD')
    expect(lines).toContain('title Launch plan')
  })

  it('emits sections and task lines with ids', () => {
    const src = buildGanttSource(sampleData)
    expect(src).toContain('section Phase 1')
    expect(src).toContain('Research :t0, 2024-01-01, 5d')
    expect(src).toContain('section Phase 2')
    // Second task has no start -> chained after the previous task.
    expect(src).toContain('Build :t1, after t0, 10d')
  })

  it('starts the first un-dated task without an after-clause', () => {
    const src = buildGanttSource({
      version: 1,
      title: '',
      tasks: [{ name: 'Solo', section: '', start: '', duration: '2d' }],
    })
    expect(src).toContain('Solo :t0, 2d')
  })

  it('strips field-separator characters from labels so syntax stays valid', () => {
    const src = buildGanttSource({
      version: 1,
      title: 'A: B, C',
      tasks: [{ name: 'Do: this, now', section: '', start: '2024-02-02', duration: '1d' }],
    })
    // Separator chars (`:` `,`) are replaced with a space; existing spaces are
    // kept, so `A: B, C` -> `A  B  C` (no `:`/`,` survive to break syntax).
    expect(src).toContain('title A  B  C')
    expect(src).not.toMatch(/title.*[:,]/)
    expect(src).toContain('Do  this  now :t0, 2024-02-02, 1d')
  })

  it('falls back to a generated name for empty task names', () => {
    const src = buildGanttSource({
      version: 1,
      title: '',
      tasks: [{ name: '', section: '', start: '2024-01-01', duration: '1d' }],
    })
    expect(src).toContain('Task 1 :t0, 2024-01-01, 1d')
  })
})
