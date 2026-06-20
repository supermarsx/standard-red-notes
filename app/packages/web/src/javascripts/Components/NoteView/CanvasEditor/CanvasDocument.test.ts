import {
  CANVAS_DOCUMENT_VERSION,
  CanvasDocument,
  createEmptyCanvasDocument,
  parseCanvasDocument,
  serializeCanvasDocument,
} from './CanvasDocument'

describe('CanvasDocument', () => {
  describe('createEmptyCanvasDocument', () => {
    it('creates a versioned empty document', () => {
      const doc = createEmptyCanvasDocument()
      expect(doc).toEqual({ version: CANVAS_DOCUMENT_VERSION, nodes: [], edges: [] })
    })
  })

  describe('serialize/parse round-trip', () => {
    it('round-trips a populated document without data loss', () => {
      const original: CanvasDocument = {
        version: CANVAS_DOCUMENT_VERSION,
        nodes: [
          { id: 'a', x: 10, y: 20, width: 200, height: 100, text: 'Hello', color: '#ef4444' },
          { id: 'b', x: -50, y: 300, width: 150, height: 80, text: 'World' },
        ],
        edges: [{ id: 'e1', fromNode: 'a', toNode: 'b', fromSide: 'right', toSide: 'left' }],
      }

      const serialized = serializeCanvasDocument(original)
      const { document, recovered } = parseCanvasDocument(serialized)

      expect(recovered).toBe(true)
      expect(document).toEqual(original)
    })

    it('preserves a node with no color (color stays undefined)', () => {
      const original = createEmptyCanvasDocument()
      original.nodes.push({ id: 'n1', x: 0, y: 0, width: 200, height: 100, text: '' })

      const { document } = parseCanvasDocument(serializeCanvasDocument(original))
      expect(document.nodes[0].color).toBeUndefined()
    })
  })

  describe('malformed and legacy input fallback', () => {
    it('returns an empty (recoverable) document for empty string', () => {
      const { document, recovered } = parseCanvasDocument('')
      expect(document).toEqual(createEmptyCanvasDocument())
      expect(recovered).toBe(true)
    })

    it('returns an empty (recoverable) document for whitespace', () => {
      const { document, recovered } = parseCanvasDocument('   \n  ')
      expect(document.nodes).toHaveLength(0)
      expect(recovered).toBe(true)
    })

    it('returns an empty document and flags non-recovery for invalid JSON', () => {
      const { document, recovered } = parseCanvasDocument('{not valid json}')
      expect(document).toEqual(createEmptyCanvasDocument())
      expect(recovered).toBe(false)
    })

    it('returns an empty document and flags non-recovery for legacy plain text', () => {
      const { document, recovered } = parseCanvasDocument('This is just a plain note.')
      expect(document.nodes).toHaveLength(0)
      expect(recovered).toBe(false)
    })

    it('returns an empty document and flags non-recovery for a JSON object that is not a canvas', () => {
      const { document, recovered } = parseCanvasDocument(JSON.stringify({ root: { children: [] } }))
      expect(document.nodes).toHaveLength(0)
      expect(recovered).toBe(false)
    })

    it('never throws on null or undefined', () => {
      expect(() => parseCanvasDocument(null)).not.toThrow()
      expect(() => parseCanvasDocument(undefined)).not.toThrow()
    })
  })

  describe('node sanitization', () => {
    it('drops nodes without a valid id', () => {
      const { document } = parseCanvasDocument(
        JSON.stringify({ nodes: [{ x: 1, y: 2 }, { id: 'ok', x: 0, y: 0 }], edges: [] }),
      )
      expect(document.nodes).toHaveLength(1)
      expect(document.nodes[0].id).toBe('ok')
    })

    it('fills missing geometry with defaults and coerces bad values', () => {
      const { document } = parseCanvasDocument(
        JSON.stringify({
          nodes: [{ id: 'a', x: 'bad', y: null, width: -10, height: 0, text: 42 }],
          edges: [],
        }),
      )
      const node = document.nodes[0]
      expect(node.x).toBe(0)
      expect(node.y).toBe(0)
      expect(node.width).toBe(200)
      expect(node.height).toBe(100)
      expect(node.text).toBe('')
    })

    it('de-duplicates nodes with the same id', () => {
      const { document } = parseCanvasDocument(
        JSON.stringify({
          nodes: [
            { id: 'dup', x: 0, y: 0 },
            { id: 'dup', x: 5, y: 5 },
          ],
          edges: [],
        }),
      )
      expect(document.nodes).toHaveLength(1)
      expect(document.nodes[0].x).toBe(0)
    })
  })

  describe('edge sanitization', () => {
    it('drops edges that reference missing nodes', () => {
      const { document } = parseCanvasDocument(
        JSON.stringify({
          nodes: [{ id: 'a', x: 0, y: 0 }],
          edges: [
            { id: 'e1', fromNode: 'a', toNode: 'missing' },
            { id: 'e2', fromNode: 'a', toNode: 'a' },
          ],
        }),
      )
      expect(document.edges).toHaveLength(1)
      expect(document.edges[0].id).toBe('e2')
    })

    it('drops edges with invalid side values', () => {
      const { document } = parseCanvasDocument(
        JSON.stringify({
          nodes: [
            { id: 'a', x: 0, y: 0 },
            { id: 'b', x: 1, y: 1 },
          ],
          edges: [{ id: 'e1', fromNode: 'a', toNode: 'b', fromSide: 'diagonal', toSide: 'left' }],
        }),
      )
      expect(document.edges[0].fromSide).toBeUndefined()
      expect(document.edges[0].toSide).toBe('left')
    })

    it('de-duplicates edges with the same id', () => {
      const { document } = parseCanvasDocument(
        JSON.stringify({
          nodes: [
            { id: 'a', x: 0, y: 0 },
            { id: 'b', x: 1, y: 1 },
          ],
          edges: [
            { id: 'dup', fromNode: 'a', toNode: 'b' },
            { id: 'dup', fromNode: 'b', toNode: 'a' },
          ],
        }),
      )
      expect(document.edges).toHaveLength(1)
    })
  })
})
