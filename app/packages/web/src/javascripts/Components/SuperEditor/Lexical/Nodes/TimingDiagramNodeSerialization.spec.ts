/**
 * @jest-environment jsdom
 *
 * Mirrors QrCodeNodeSerialization.spec.ts:
 *   1. TimingDiagramNode serialization round-trips the WaveJSON source.
 *   2. Old / missing / malformed data degrades gracefully to an editable block
 *      (default source) rather than throwing.
 */

import { createHeadlessEditor } from '@lexical/headless'

import {
  $createTimingDiagramNode,
  normalize,
  SerializedTimingDiagramNode,
  TimingDiagramData,
  TimingDiagramNode,
} from './TimingDiagramNode'

const editor = createHeadlessEditor({
  namespace: 'TimingDiagramNodeSerializationTest',
  nodes: [TimingDiagramNode],
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

const sampleData: TimingDiagramData = {
  version: 1,
  source: '{ "signal": [{ "name": "clk", "wave": "p..." }] }',
}

describe('TimingDiagramNode serialization round-trip', () => {
  it('round-trips the WaveJSON source without loss', () => {
    const { first, second } = inEditor(() => {
      const first = $createTimingDiagramNode(sampleData).exportJSON()
      const second = TimingDiagramNode.importJSON(first).exportJSON()
      return { first, second }
    })
    expect(second.data).toEqual(first.data)
    expect(second.data.source).toBe(sampleData.source)
  })

  it('keeps type and version stable', () => {
    const json = inEditor(() => $createTimingDiagramNode(sampleData).exportJSON())
    expect(json.type).toBe('timing-diagram')
    expect(json.type).toBe(TimingDiagramNode.getType())
    expect(json.version).toBe(1)
  })

  it('is a block node', () => {
    const inline = inEditor(() => $createTimingDiagramNode(sampleData).isInline())
    expect(inline).toBe(false)
  })

  it('exposes the source as the node text content', () => {
    const text = inEditor(() => $createTimingDiagramNode(sampleData).getTextContent())
    expect(text).toBe(sampleData.source)
  })

  it('degrades gracefully when data is missing (old data)', () => {
    const legacy = { type: 'timing-diagram', version: 1 } as unknown as SerializedTimingDiagramNode
    const json = inEditor(() => TimingDiagramNode.importJSON(legacy).exportJSON())
    expect(typeof json.data.source).toBe('string')
    expect(json.data.source.length).toBeGreaterThan(0)
  })

  it('does not throw on a completely malformed data blob', () => {
    const garbage = { type: 'timing-diagram', version: 1, data: 42 } as unknown as SerializedTimingDiagramNode
    const json = inEditor(() => TimingDiagramNode.importJSON(garbage).exportJSON())
    expect(typeof json.data.source).toBe('string')
  })
})

describe('normalize', () => {
  it('returns the default source for null/undefined', () => {
    expect(normalize(null).source.length).toBeGreaterThan(0)
    expect(normalize(undefined).source.length).toBeGreaterThan(0)
  })

  it('coerces a non-string source to the default', () => {
    expect(typeof normalize({ source: 123 as unknown as string }).source).toBe('string')
  })

  it('preserves a valid source', () => {
    expect(normalize({ source: 'abc' }).source).toBe('abc')
  })
})
