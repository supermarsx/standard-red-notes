/**
 * @jest-environment jsdom
 *
 * Mirrors QrCodeNodeSerialization.spec.ts:
 *   1. MusicStaffNode serialization round-trips the ABC-notation source.
 *   2. Old / missing / malformed data degrades gracefully to an editable block
 *      (default source) rather than throwing.
 */

import { createHeadlessEditor } from '@lexical/headless'

import {
  $createMusicStaffNode,
  MusicStaffData,
  MusicStaffNode,
  normalize,
  SerializedMusicStaffNode,
} from './MusicStaffNode'

const editor = createHeadlessEditor({
  namespace: 'MusicStaffNodeSerializationTest',
  nodes: [MusicStaffNode],
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

const sampleData: MusicStaffData = {
  version: 1,
  source: 'X:1\nK:C\nC D E F |',
}

describe('MusicStaffNode serialization round-trip', () => {
  it('round-trips the ABC source without loss', () => {
    const { first, second } = inEditor(() => {
      const first = $createMusicStaffNode(sampleData).exportJSON()
      const second = MusicStaffNode.importJSON(first).exportJSON()
      return { first, second }
    })
    expect(second.data).toEqual(first.data)
    expect(second.data.source).toBe(sampleData.source)
  })

  it('keeps type and version stable', () => {
    const json = inEditor(() => $createMusicStaffNode(sampleData).exportJSON())
    expect(json.type).toBe('music-staff')
    expect(json.type).toBe(MusicStaffNode.getType())
    expect(json.version).toBe(1)
  })

  it('is a block node', () => {
    const inline = inEditor(() => $createMusicStaffNode(sampleData).isInline())
    expect(inline).toBe(false)
  })

  it('exposes the source as the node text content', () => {
    const text = inEditor(() => $createMusicStaffNode(sampleData).getTextContent())
    expect(text).toBe(sampleData.source)
  })

  it('degrades gracefully when data is missing (old data)', () => {
    const legacy = { type: 'music-staff', version: 1 } as unknown as SerializedMusicStaffNode
    const json = inEditor(() => MusicStaffNode.importJSON(legacy).exportJSON())
    expect(typeof json.data.source).toBe('string')
    expect(json.data.source.length).toBeGreaterThan(0)
  })

  it('does not throw on a completely malformed data blob', () => {
    const garbage = { type: 'music-staff', version: 1, data: 42 } as unknown as SerializedMusicStaffNode
    const json = inEditor(() => MusicStaffNode.importJSON(garbage).exportJSON())
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
    expect(normalize({ source: 'K:C' }).source).toBe('K:C')
  })
})
