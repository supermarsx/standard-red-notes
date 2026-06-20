/**
 * @jest-environment jsdom
 *
 * Round-trips the serialization of the math decorator nodes (MathNode and
 * InlineMathNode). For each node we assert:
 *   - the LaTeX `equation` is preserved exactly across
 *     exportJSON -> importJSON -> exportJSON
 *   - the `type` and `version` fields are stable
 *   - missing/old `equation` data degrades gracefully to an empty string
 *
 * Like the other decorator nodes, constructing a node assigns it a key, which is
 * a write requiring an active editor context (Lexical 0.45). We therefore use a
 * headless editor and run all node work inside editor.update(). We do NOT import
 * the node's React component / KaTeX here — only the node classes — so the test
 * stays lightweight and offline.
 */

import { createHeadlessEditor } from '@lexical/headless'

import { $createMathNode, MathNode, SerializedMathNode } from './MathNode'
import { $createInlineMathNode, InlineMathNode, SerializedInlineMathNode } from './InlineMathNode'

const editor = createHeadlessEditor({
  namespace: 'MathNodeSerializationTest',
  nodes: [MathNode, InlineMathNode],
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

describe('Math node serialization', () => {
  describe('MathNode (block)', () => {
    const equation = '\\int_0^1 x^2 \\, dx = \\frac{1}{3}'

    it('round-trips the equation without loss', () => {
      const { first, second } = inEditor(() => {
        const first = $createMathNode(equation).exportJSON()
        const second = MathNode.importJSON(first).exportJSON()
        return { first, second }
      })
      expect(second.equation).toBe(equation)
      expect(second).toEqual(first)
    })

    it('keeps type and version stable', () => {
      const json = inEditor(() => $createMathNode(equation).exportJSON())
      expect(json.type).toBe('math')
      expect(json.type).toBe(MathNode.getType())
      expect(json.version).toBe(1)
    })

    it('degrades gracefully when equation is missing (old data)', () => {
      const legacy = { type: 'math', version: 1 } as unknown as SerializedMathNode
      const json = inEditor(() => MathNode.importJSON(legacy).exportJSON())
      expect(json.equation).toBe('')
    })

    it('exposes the equation via getEquation()', () => {
      const value = inEditor(() => $createMathNode(equation).getEquation())
      expect(value).toBe(equation)
    })
  })

  describe('InlineMathNode', () => {
    const equation = 'e^{i\\pi} + 1 = 0'

    it('round-trips the equation without loss', () => {
      const { first, second } = inEditor(() => {
        const first = $createInlineMathNode(equation).exportJSON()
        const second = InlineMathNode.importJSON(first).exportJSON()
        return { first, second }
      })
      expect(second.equation).toBe(equation)
      expect(second).toEqual(first)
    })

    it('keeps type and version stable', () => {
      const json = inEditor(() => $createInlineMathNode(equation).exportJSON())
      expect(json.type).toBe('inline-math')
      expect(json.type).toBe(InlineMathNode.getType())
      expect(json.version).toBe(1)
    })

    it('is inline', () => {
      const inline = inEditor(() => $createInlineMathNode(equation).isInline())
      expect(inline).toBe(true)
    })

    it('degrades gracefully when equation is missing (old data)', () => {
      const legacy = { type: 'inline-math', version: 1 } as unknown as SerializedInlineMathNode
      const json = inEditor(() => InlineMathNode.importJSON(legacy).exportJSON())
      expect(json.equation).toBe('')
    })
  })

  it('exposes unique getType() across both math nodes', () => {
    const types = [MathNode.getType(), InlineMathNode.getType()]
    expect(new Set(types).size).toBe(types.length)
    expect(types).toEqual(['math', 'inline-math'])
  })
})
