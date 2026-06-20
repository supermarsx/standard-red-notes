import {
  MAP_DOCUMENT_VERSION,
  MapDocument,
  addChildNode,
  addNode,
  autoArrangeTree,
  connectNodes,
  createEmptyMapDocument,
  createFamilyTreeStarter,
  createMindMapStarter,
  deleteNode,
  moveNode,
  normalizeMapDocument,
  parseMapDocument,
  serializeMapDocument,
  setNodeColor,
  setNodeText,
} from './MapDocument'

const doc = (nodes: MapDocument['nodes'], edges: MapDocument['edges'] = []): MapDocument =>
  normalizeMapDocument(nodes, edges)

describe('MapDocument', () => {
  describe('parseMapDocument', () => {
    it('returns an empty map (recovered) for empty/whitespace/null/undefined', () => {
      for (const input of ['', '   ', null, undefined]) {
        const { document, recovered } = parseMapDocument(input)
        expect(document.nodes).toEqual([])
        expect(document.edges).toEqual([])
        expect(document.version).toBe(MAP_DOCUMENT_VERSION)
        expect(recovered).toBe(true)
      }
    })

    it('never throws on malformed JSON and reports not-recovered', () => {
      const { document, recovered } = parseMapDocument('{not valid json')
      expect(document.nodes).toEqual([])
      expect(recovered).toBe(false)
    })

    it('treats non-map JSON (no nodes array) as a fresh map, not-recovered', () => {
      const { document, recovered } = parseMapDocument(JSON.stringify({ cards: [] }))
      expect(document.nodes).toEqual([])
      expect(recovered).toBe(false)
    })

    it('parses a valid map with nodes and edges', () => {
      const text = JSON.stringify({
        version: 1,
        nodes: [
          { id: 'a', text: 'A', x: 1, y: 2, color: '#fff' },
          { id: 'b', text: 'B', x: 3, y: 4 },
        ],
        edges: [{ from: 'a', to: 'b' }],
      })
      const { document, recovered } = parseMapDocument(text)
      expect(recovered).toBe(true)
      expect(document.nodes).toHaveLength(2)
      expect(document.edges).toEqual([{ from: 'a', to: 'b' }])
      expect(document.nodes[0]).toEqual({ id: 'a', text: 'A', x: 1, y: 2, color: '#fff' })
    })

    it('parses a tree map via parentId without an edges array (backward compat)', () => {
      const text = JSON.stringify({
        nodes: [
          { id: 'root', text: 'Root', x: 0, y: 0 },
          { id: 'child', text: 'Child', x: 0, y: 100, parentId: 'root' },
        ],
      })
      const { document, recovered } = parseMapDocument(text)
      expect(recovered).toBe(true)
      expect(document.edges).toEqual([])
      expect(document.nodes[1].parentId).toBe('root')
    })

    it('normalizes missing text/x/y and drops nodes without ids', () => {
      const text = JSON.stringify({
        nodes: [{ id: 'a' }, { text: 'no id' }, { id: '', text: 'empty id' }],
      })
      const { document } = parseMapDocument(text)
      expect(document.nodes).toEqual([{ id: 'a', text: '', x: 0, y: 0 }])
    })

    it('dedupes nodes with duplicate ids (first wins)', () => {
      const text = JSON.stringify({
        nodes: [
          { id: 'dup', text: 'first', x: 0, y: 0 },
          { id: 'dup', text: 'second', x: 5, y: 5 },
        ],
      })
      const { document } = parseMapDocument(text)
      expect(document.nodes).toHaveLength(1)
      expect(document.nodes[0].text).toBe('first')
    })

    it('drops dangling edges and parentId references to missing nodes', () => {
      const text = JSON.stringify({
        nodes: [
          { id: 'a', text: 'A', x: 0, y: 0, parentId: 'ghost' },
          { id: 'b', text: 'B', x: 0, y: 0 },
        ],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'a', to: 'missing' },
        ],
      })
      const { document } = parseMapDocument(text)
      expect(document.nodes[0].parentId).toBeUndefined()
      expect(document.edges).toEqual([{ from: 'a', to: 'b' }])
    })

    it('drops self-loops and duplicate (undirected) edges', () => {
      const text = JSON.stringify({
        nodes: [
          { id: 'a', text: '', x: 0, y: 0 },
          { id: 'b', text: '', x: 0, y: 0 },
        ],
        edges: [
          { from: 'a', to: 'a' },
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
        ],
      })
      const { document } = parseMapDocument(text)
      expect(document.edges).toEqual([{ from: 'a', to: 'b' }])
    })

    it('preserves an unknown future version number', () => {
      const text = JSON.stringify({ version: 99, nodes: [] })
      const { document } = parseMapDocument(text)
      expect(document.version).toBe(99)
    })
  })

  describe('serializeMapDocument round-trip', () => {
    it('round-trips a map with nodes (with and without optional fields) and edges', () => {
      const original = doc(
        [
          { id: 'a', text: 'A', x: 1, y: 2, color: '#abc', parentId: undefined },
          { id: 'b', text: 'B', x: 3, y: 4, parentId: 'a' },
        ],
        [{ from: 'a', to: 'b' }],
      )
      const { document } = parseMapDocument(serializeMapDocument(original))
      expect(document).toEqual(original)
    })

    it('omits undefined optional keys in serialized output', () => {
      const json = serializeMapDocument(doc([{ id: 'a', text: 'A', x: 0, y: 0 }]))
      const parsed = JSON.parse(json)
      expect(parsed.nodes[0]).toEqual({ id: 'a', text: 'A', x: 0, y: 0 })
      expect('color' in parsed.nodes[0]).toBe(false)
      expect('parentId' in parsed.nodes[0]).toBe(false)
    })

    it('serializes an empty map cleanly', () => {
      const json = serializeMapDocument(createEmptyMapDocument())
      expect(JSON.parse(json)).toEqual({ version: MAP_DOCUMENT_VERSION, nodes: [], edges: [] })
    })
  })

  describe('mutators', () => {
    it('addNode appends a positioned node', () => {
      const result = addNode(createEmptyMapDocument(), 10, 20, 'hi')
      expect(result.nodes).toHaveLength(1)
      expect(result.nodes[0]).toMatchObject({ text: 'hi', x: 10, y: 20 })
    })

    it('addChildNode sets parentId and adds an edge', () => {
      const base = addNode(createEmptyMapDocument(), 0, 0, 'parent')
      const parentId = base.nodes[0].id
      const result = addChildNode(base, parentId, 'child')
      expect(result.nodes).toHaveLength(2)
      const child = result.nodes.find((n) => n.text === 'child')!
      expect(child.parentId).toBe(parentId)
      expect(result.edges).toEqual([{ from: parentId, to: child.id }])
    })

    it('addChildNode is a no-op for an unknown parent', () => {
      const base = addNode(createEmptyMapDocument(), 0, 0, 'parent')
      expect(addChildNode(base, 'ghost', 'child')).toEqual(base)
    })

    it('setNodeText updates only the targeted node', () => {
      const base = doc([
        { id: 'a', text: 'A', x: 0, y: 0 },
        { id: 'b', text: 'B', x: 0, y: 0 },
      ])
      const result = setNodeText(base, 'a', 'renamed')
      expect(result.nodes.find((n) => n.id === 'a')!.text).toBe('renamed')
      expect(result.nodes.find((n) => n.id === 'b')!.text).toBe('B')
    })

    it('moveNode updates coordinates', () => {
      const base = doc([{ id: 'a', text: 'A', x: 0, y: 0 }])
      const result = moveNode(base, 'a', 99, 88)
      expect(result.nodes[0]).toMatchObject({ x: 99, y: 88 })
    })

    it('setNodeColor sets and clears color', () => {
      const base = doc([{ id: 'a', text: 'A', x: 0, y: 0 }])
      const colored = setNodeColor(base, 'a', '#123456')
      expect(colored.nodes[0].color).toBe('#123456')
      const cleared = setNodeColor(colored, 'a', undefined)
      expect(cleared.nodes[0].color).toBeUndefined()
    })

    it('connectNodes adds an edge and ignores self-loops/duplicates', () => {
      const base = doc([
        { id: 'a', text: '', x: 0, y: 0 },
        { id: 'b', text: '', x: 0, y: 0 },
      ])
      const once = connectNodes(base, 'a', 'b')
      expect(once.edges).toEqual([{ from: 'a', to: 'b' }])
      expect(connectNodes(once, 'b', 'a').edges).toHaveLength(1)
      expect(connectNodes(base, 'a', 'a').edges).toHaveLength(0)
    })

    it('deleteNode removes the node, clears it as a parent, and prunes dangling edges', () => {
      const base = doc(
        [
          { id: 'a', text: 'A', x: 0, y: 0 },
          { id: 'b', text: 'B', x: 0, y: 0, parentId: 'a' },
          { id: 'c', text: 'C', x: 0, y: 0 },
        ],
        [
          { from: 'a', to: 'b' },
          { from: 'a', to: 'c' },
          { from: 'b', to: 'c' },
        ],
      )
      const result = deleteNode(base, 'a')
      expect(result.nodes.map((n) => n.id).sort()).toEqual(['b', 'c'])
      expect(result.nodes.find((n) => n.id === 'b')!.parentId).toBeUndefined()
      expect(result.edges).toEqual([{ from: 'b', to: 'c' }])
    })
  })

  describe('templates', () => {
    it('createMindMapStarter builds a central root with radial children connected by edges', () => {
      const map = createMindMapStarter()
      expect(map.nodes.length).toBeGreaterThan(1)
      const root = map.nodes[0]
      // every non-root node has an edge to root, and no parentId (free graph)
      expect(map.edges).toHaveLength(map.nodes.length - 1)
      for (const edge of map.edges) {
        expect(edge.from).toBe(root.id)
      }
      expect(map.nodes.every((n) => n.parentId === undefined)).toBe(true)
    })

    it('createFamilyTreeStarter builds a top root with parentId children (tree)', () => {
      const map = createFamilyTreeStarter()
      const root = map.nodes[0]
      const children = map.nodes.filter((n) => n.parentId === root.id)
      expect(children.length).toBeGreaterThan(0)
      expect(children.every((c) => c.y > root.y)).toBe(true)
    })
  })

  describe('autoArrangeTree', () => {
    it('positions tree nodes top-down by generation', () => {
      const base = doc([
        { id: 'root', text: 'R', x: 999, y: 999, parentId: undefined },
        { id: 'c1', text: 'C1', x: 0, y: 0, parentId: 'root' },
        { id: 'c2', text: 'C2', x: 0, y: 0, parentId: 'root' },
      ])
      const result = autoArrangeTree(base)
      const root = result.nodes.find((n) => n.id === 'root')!
      const c1 = result.nodes.find((n) => n.id === 'c1')!
      const c2 = result.nodes.find((n) => n.id === 'c2')!
      expect(c1.y).toBeGreaterThan(root.y)
      expect(c2.y).toBe(c1.y)
      // root centered over its two children
      expect(root.x).toBeGreaterThan(Math.min(c1.x, c2.x))
      expect(root.x).toBeLessThan(Math.max(c1.x, c2.x))
    })
  })
})
