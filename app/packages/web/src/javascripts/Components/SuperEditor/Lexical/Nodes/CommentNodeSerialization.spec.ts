/**
 * @jest-environment jsdom
 *
 * Mirrors ClockNodeSerialization.spec.ts:
 *   1. CommentNode serialization round-trips (exportJSON -> importJSON ->
 *      exportJSON) preserving text, author, and createdAt.
 *   2. Old / missing / malformed data degrades to a sensible default comment
 *      rather than throwing (backward-compat), always yielding a numeric
 *      createdAt.
 *   3. `normalize` coercion units + the getTextContent() annotation string.
 *
 * Constructing a node assigns a key, which is a write requiring an active
 * editor; node work runs inside editor.update().
 */

import { createHeadlessEditor } from '@lexical/headless'

import { $createCommentNode, CommentData, CommentNode, normalize, SerializedCommentNode } from './CommentNode'

const editor = createHeadlessEditor({
  namespace: 'CommentNodeSerializationTest',
  nodes: [CommentNode],
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

const sampleData: CommentData = {
  version: 1,
  text: 'Please double-check this figure.',
  author: 'Alex',
  createdAt: 1_700_000_000_000,
}

describe('CommentNode serialization round-trip', () => {
  it('round-trips text, author, and createdAt without loss', () => {
    const { first, second } = inEditor(() => {
      const first = $createCommentNode(sampleData).exportJSON()
      const second = CommentNode.importJSON(first).exportJSON()
      return { first, second }
    })
    expect(second.data).toEqual(first.data)
    expect(second.data.text).toBe('Please double-check this figure.')
    expect(second.data.author).toBe('Alex')
    expect(second.data.createdAt).toBe(1_700_000_000_000)
  })

  it('keeps type and version stable', () => {
    const json = inEditor(() => $createCommentNode(sampleData).exportJSON())
    expect(json.type).toBe('comment')
    expect(json.type).toBe(CommentNode.getType())
    expect(json.version).toBe(1)
  })

  it('is a block node', () => {
    const inline = inEditor(() => $createCommentNode(sampleData).isInline())
    expect(inline).toBe(false)
  })

  it('degrades gracefully when data is missing (old data), stamping a numeric createdAt', () => {
    const legacy = { type: 'comment', version: 1 } as unknown as SerializedCommentNode
    const json = inEditor(() => CommentNode.importJSON(legacy).exportJSON())
    expect(json.data.text).toBe('')
    expect(json.data.author).toBe('')
    expect(typeof json.data.createdAt).toBe('number')
    expect(Number.isFinite(json.data.createdAt)).toBe(true)
  })

  it('does not throw on a completely malformed data blob', () => {
    const garbage = { type: 'comment', version: 1, data: 42 } as unknown as SerializedCommentNode
    const json = inEditor(() => CommentNode.importJSON(garbage).exportJSON())
    expect(json.data.text).toBe('')
    expect(json.data.author).toBe('')
    expect(typeof json.data.createdAt).toBe('number')
  })

  it('stamps createdAt when created without an explicit timestamp', () => {
    const before = Date.now()
    const json = inEditor(() => $createCommentNode().exportJSON())
    expect(json.data.createdAt).toBeGreaterThanOrEqual(before)
  })

  it('exposes the comment as an annotation via getTextContent (author + text)', () => {
    const text = inEditor(() => $createCommentNode(sampleData).getTextContent())
    expect(text).toContain('Please double-check this figure.')
    expect(text).toContain('Alex')
    expect(text).toBe('[Comment — Alex] Please double-check this figure.')
  })

  it('omits the author segment from getTextContent when author is empty', () => {
    const text = inEditor(() => $createCommentNode({ text: 'Bare note', author: '' }).getTextContent())
    expect(text).toBe('[Comment] Bare note')
  })
})

describe('normalize (backward-compat / coercion)', () => {
  it('returns defaults for null/undefined with a numeric createdAt', () => {
    expect(normalize(null).text).toBe('')
    expect(normalize(undefined).author).toBe('')
    expect(typeof normalize(null).createdAt).toBe('number')
    expect(Number.isFinite(normalize(undefined).createdAt)).toBe(true)
  })

  it('string-coerces non-string text and author', () => {
    const result = normalize({
      text: 123 as unknown as string,
      author: true as unknown as string,
    })
    expect(result.text).toBe('123')
    expect(result.author).toBe('true')
  })

  it('preserves a valid numeric createdAt', () => {
    expect(normalize({ createdAt: 1_700_000_000_000 }).createdAt).toBe(1_700_000_000_000)
  })

  it('repairs a NaN / non-numeric createdAt to a finite number', () => {
    const result = normalize({ createdAt: 'nope' as unknown as number })
    expect(Number.isFinite(result.createdAt)).toBe(true)
  })

  it('always stamps the current version', () => {
    expect(normalize({ version: 999 as unknown as number }).version).toBe(1)
  })
})
