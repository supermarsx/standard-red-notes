/**
 * @jest-environment jsdom
 *
 * Tests for the footnotes feature, mirroring the structure of
 * MathNodeSerialization.spec.ts. We cover three things the feature relies on:
 *
 *   1. Numbering is derived purely from the document ORDER of reference nodes,
 *      so inserting / deleting / reordering renumbers consistently. This is
 *      tested both against the pure helper (computeFootnoteNumbering) and against
 *      a live headless editor tree ($getOrderedFootnoteReferences).
 *   2. References and entries pair by a stable footnoteId, and entry ordering /
 *      orphan-dropping follows the reference order (orderEntriesByReferences).
 *   3. Serialization round-trips for both the reference node and the footnotes
 *      section node, and old / missing data degrades gracefully.
 *
 * As with the math nodes, constructing a node assigns a key, which is a write
 * requiring an active editor; we therefore run node work inside editor.update().
 * No React component is imported here, keeping the test offline and lightweight.
 */

import { createHeadlessEditor } from '@lexical/headless'
import { $getRoot, $createParagraphNode } from 'lexical'

import {
  $createFootnoteReferenceNode,
  FootnoteReferenceNode,
  SerializedFootnoteReferenceNode,
  createFootnoteId,
} from './FootnoteReferenceNode'
import { $createFootnotesNode, FootnotesNode, SerializedFootnotesNode } from './FootnotesNode'
import {
  $getOrderedFootnoteReferences,
  computeFootnoteNumbering,
  orderEntriesByReferences,
} from './FootnoteShared'

const editor = createHeadlessEditor({
  namespace: 'FootnoteNodeSerializationTest',
  nodes: [FootnoteReferenceNode, FootnotesNode],
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

function resetRoot(): void {
  inEditor(() => {
    $getRoot().clear()
  })
}

describe('Footnote numbering (order-derived)', () => {
  it('numbers ids by first occurrence in order', () => {
    const map = computeFootnoteNumbering(['a', 'b', 'c'])
    expect(map.get('a')).toBe(1)
    expect(map.get('b')).toBe(2)
    expect(map.get('c')).toBe(3)
  })

  it('renumbers after an insert in the middle', () => {
    const before = computeFootnoteNumbering(['a', 'b'])
    expect([before.get('a'), before.get('b')]).toEqual([1, 2])
    // Insert "x" between a and b.
    const after = computeFootnoteNumbering(['a', 'x', 'b'])
    expect(after.get('a')).toBe(1)
    expect(after.get('x')).toBe(2)
    expect(after.get('b')).toBe(3)
  })

  it('renumbers after a delete', () => {
    const after = computeFootnoteNumbering(['a', 'c'])
    expect(after.get('a')).toBe(1)
    expect(after.get('c')).toBe(2)
    expect(after.has('b')).toBe(false)
  })

  it('renumbers after a reorder', () => {
    const after = computeFootnoteNumbering(['c', 'a', 'b'])
    expect(after.get('c')).toBe(1)
    expect(after.get('a')).toBe(2)
    expect(after.get('b')).toBe(3)
  })

  it('keeps the first number for a duplicated id (botched paste)', () => {
    const map = computeFootnoteNumbering(['a', 'b', 'a'])
    expect(map.get('a')).toBe(1)
    expect(map.get('b')).toBe(2)
    expect(map.size).toBe(2)
  })

  it('derives order from the live document tree via $getOrderedFootnoteReferences', () => {
    resetRoot()
    const ids = inEditor(() => {
      const root = $getRoot()
      const p1 = $createParagraphNode()
      const ref1 = $createFootnoteReferenceNode('id-1')
      const ref2 = $createFootnoteReferenceNode('id-2')
      p1.append(ref1)
      p1.append(ref2)
      const p2 = $createParagraphNode()
      const ref3 = $createFootnoteReferenceNode('id-3')
      p2.append(ref3)
      root.append(p1)
      root.append(p2)
      return $getOrderedFootnoteReferences().map((node) => node.getFootnoteId())
    })
    expect(ids).toEqual(['id-1', 'id-2', 'id-3'])
  })

  it('reflects deletion of a reference in the derived numbering', () => {
    resetRoot()
    const numbering = inEditor(() => {
      const root = $getRoot()
      const p = $createParagraphNode()
      const ref1 = $createFootnoteReferenceNode('id-1')
      const ref2 = $createFootnoteReferenceNode('id-2')
      const ref3 = $createFootnoteReferenceNode('id-3')
      p.append(ref1)
      p.append(ref2)
      p.append(ref3)
      root.append(p)
      // Delete the middle reference.
      ref2.remove()
      const orderedIds = $getOrderedFootnoteReferences().map((node) => node.getFootnoteId())
      return computeFootnoteNumbering(orderedIds)
    })
    expect(numbering.get('id-1')).toBe(1)
    expect(numbering.get('id-3')).toBe(2)
    expect(numbering.has('id-2')).toBe(false)
  })
})

describe('Footnote reference/entry pairing by id', () => {
  it('pairs entries with references and follows reference order', () => {
    const ordered = orderEntriesByReferences(
      ['id-2', 'id-1'],
      [
        { footnoteId: 'id-1', content: 'first' },
        { footnoteId: 'id-2', content: 'second' },
      ],
    )
    expect(ordered.map((entry) => entry.footnoteId)).toEqual(['id-2', 'id-1'])
    expect(ordered[0].content).toBe('second')
    expect(ordered[1].content).toBe('first')
  })

  it('creates an empty placeholder entry for a reference with no entry', () => {
    const ordered = orderEntriesByReferences(['id-1', 'id-2'], [{ footnoteId: 'id-1', content: 'first' }])
    expect(ordered).toHaveLength(2)
    expect(ordered[1]).toEqual({ footnoteId: 'id-2', content: '' })
  })

  it('drops orphan entries whose reference is gone', () => {
    const ordered = orderEntriesByReferences(
      ['id-1'],
      [
        { footnoteId: 'id-1', content: 'keep' },
        { footnoteId: 'id-orphan', content: 'drop' },
      ],
    )
    expect(ordered).toHaveLength(1)
    expect(ordered[0].footnoteId).toBe('id-1')
  })

  it('FootnotesNode add/has/prune manage entries by id', () => {
    const result = inEditor(() => {
      const node = $createFootnotesNode()
      node.addEntry('id-1', 'one')
      node.addEntry('id-2', 'two')
      node.addEntry('id-1', 'dup-ignored')
      const hadBoth = node.hasEntry('id-1') && node.hasEntry('id-2')
      node.pruneOrphans(new Set(['id-2']))
      return { hadBoth, entries: node.getEntries() }
    })
    expect(result.hadBoth).toBe(true)
    expect(result.entries).toEqual([{ footnoteId: 'id-2', content: 'two' }])
  })

  it('setEntryContent updates existing and inserts missing', () => {
    const entries = inEditor(() => {
      const node = $createFootnotesNode([{ footnoteId: 'id-1', content: 'old' }])
      node.setEntryContent('id-1', 'new')
      node.setEntryContent('id-2', 'added')
      return node.getEntries()
    })
    expect(entries).toEqual([
      { footnoteId: 'id-1', content: 'new' },
      { footnoteId: 'id-2', content: 'added' },
    ])
  })
})

describe('Footnote serialization round-trip', () => {
  describe('FootnoteReferenceNode', () => {
    it('round-trips the footnoteId without loss', () => {
      const { first, second } = inEditor(() => {
        const first = $createFootnoteReferenceNode('id-abc').exportJSON()
        const second = FootnoteReferenceNode.importJSON(first).exportJSON()
        return { first, second }
      })
      expect(second.footnoteId).toBe('id-abc')
      expect(second).toEqual(first)
    })

    it('keeps type and version stable', () => {
      const json = inEditor(() => $createFootnoteReferenceNode('id-1').exportJSON())
      expect(json.type).toBe('footnote-reference')
      expect(json.type).toBe(FootnoteReferenceNode.getType())
      expect(json.version).toBe(1)
    })

    it('is inline', () => {
      const inline = inEditor(() => $createFootnoteReferenceNode('id-1').isInline())
      expect(inline).toBe(true)
    })

    it('mints a fresh id when old data has none (degrades gracefully)', () => {
      const legacy = { type: 'footnote-reference', version: 1 } as unknown as SerializedFootnoteReferenceNode
      const id = inEditor(() => FootnoteReferenceNode.importJSON(legacy).getFootnoteId())
      expect(typeof id).toBe('string')
      expect(id.length).toBeGreaterThan(0)
    })
  })

  describe('FootnotesNode', () => {
    const entries = [
      { footnoteId: 'id-1', content: 'first footnote' },
      { footnoteId: 'id-2', content: 'second footnote' },
    ]

    it('round-trips entries without loss', () => {
      const { first, second } = inEditor(() => {
        const first = $createFootnotesNode(entries).exportJSON()
        const second = FootnotesNode.importJSON(first).exportJSON()
        return { first, second }
      })
      expect(second.entries).toEqual(entries)
      expect(second).toEqual(first)
    })

    it('keeps type and version stable', () => {
      const json = inEditor(() => $createFootnotesNode(entries).exportJSON())
      expect(json.type).toBe('footnotes')
      expect(json.type).toBe(FootnotesNode.getType())
      expect(json.version).toBe(1)
    })

    it('is a block node', () => {
      const inline = inEditor(() => $createFootnotesNode(entries).isInline())
      expect(inline).toBe(false)
    })

    it('degrades gracefully when entries are missing (old data)', () => {
      const legacy = { type: 'footnotes', version: 1 } as unknown as SerializedFootnotesNode
      const json = inEditor(() => FootnotesNode.importJSON(legacy).exportJSON())
      expect(json.entries).toEqual([])
    })

    it('sanitizes malformed entries on import', () => {
      const dirty = {
        type: 'footnotes',
        version: 1,
        entries: [
          { footnoteId: 'ok', content: 'good' },
          { content: 'no id - dropped' },
          { footnoteId: 'no-content' },
        ],
      } as unknown as SerializedFootnotesNode
      const json = inEditor(() => FootnotesNode.importJSON(dirty).exportJSON())
      expect(json.entries).toEqual([
        { footnoteId: 'ok', content: 'good' },
        { footnoteId: 'no-content', content: '' },
      ])
    })
  })

  it('createFootnoteId produces unique ids', () => {
    const ids = new Set([createFootnoteId(), createFootnoteId(), createFootnoteId()])
    expect(ids.size).toBe(3)
  })

  it('exposes unique getType() across footnote nodes', () => {
    const types = [FootnoteReferenceNode.getType(), FootnotesNode.getType()]
    expect(new Set(types).size).toBe(types.length)
    expect(types).toEqual(['footnote-reference', 'footnotes'])
  })
})
