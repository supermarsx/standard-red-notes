/**
 * @jest-environment jsdom
 *
 * Tests the "Embed website" block:
 *   - sanitizeWebEmbedUrl: only http(s) URLs pass; dangerous schemes
 *     (javascript:/data:/etc) and scheme-less input are rejected.
 *   - WebEmbedNode serialization: url + height round-trip through
 *     exportJSON -> importJSON -> exportJSON, with type/version stable and
 *     missing/old data degrading gracefully.
 *
 * Constructing a decorator node assigns a key, which is a write requiring an
 * active editor context (Lexical 0.45), so node work runs inside a headless
 * editor's discrete update. We import only the node class (not its React
 * component) so the test stays lightweight and offline.
 */

import { createHeadlessEditor } from '@lexical/headless'

import { sanitizeWebEmbedUrl, isValidWebEmbedUrl } from './sanitizeWebEmbedUrl'
import { $createWebEmbedNode, WebEmbedNode, SerializedWebEmbedNode } from './WebEmbedNode'

const editor = createHeadlessEditor({
  namespace: 'WebEmbedNodeSerializationTest',
  nodes: [WebEmbedNode],
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

describe('sanitizeWebEmbedUrl', () => {
  it('accepts and normalizes a plain https URL', () => {
    expect(sanitizeWebEmbedUrl('https://example.com/page')).toBe('https://example.com/page')
  })

  it('accepts http URLs', () => {
    expect(sanitizeWebEmbedUrl('http://example.com')).toBe('http://example.com/')
  })

  it('trims surrounding whitespace', () => {
    expect(sanitizeWebEmbedUrl('  https://example.com/  ')).toBe('https://example.com/')
  })

  it('rejects scheme-less input (no auto-https)', () => {
    expect(sanitizeWebEmbedUrl('example.com')).toBe('')
    expect(sanitizeWebEmbedUrl('www.example.com/path')).toBe('')
  })

  it('rejects javascript: URLs', () => {
    expect(sanitizeWebEmbedUrl('javascript:alert(1)')).toBe('')
    expect(sanitizeWebEmbedUrl('JavaScript:alert(1)')).toBe('')
  })

  it('rejects data: URLs', () => {
    expect(sanitizeWebEmbedUrl('data:text/html,<script>alert(1)</script>')).toBe('')
  })

  it('rejects other dangerous/non-http schemes', () => {
    expect(sanitizeWebEmbedUrl('file:///etc/passwd')).toBe('')
    expect(sanitizeWebEmbedUrl('blob:https://example.com/abc')).toBe('')
    expect(sanitizeWebEmbedUrl('vbscript:msgbox(1)')).toBe('')
    expect(sanitizeWebEmbedUrl('ftp://example.com/file')).toBe('')
  })

  it('rejects empty/whitespace input', () => {
    expect(sanitizeWebEmbedUrl('')).toBe('')
    expect(sanitizeWebEmbedUrl('   ')).toBe('')
    expect(sanitizeWebEmbedUrl(null)).toBe('')
    expect(sanitizeWebEmbedUrl(undefined)).toBe('')
  })

  it('rejects http URLs without a host', () => {
    expect(sanitizeWebEmbedUrl('http://')).toBe('')
  })

  it('isValidWebEmbedUrl mirrors sanitizeWebEmbedUrl', () => {
    expect(isValidWebEmbedUrl('https://example.com')).toBe(true)
    expect(isValidWebEmbedUrl('javascript:alert(1)')).toBe(false)
  })
})

describe('WebEmbedNode serialization', () => {
  const url = 'https://example.com/some/page'

  it('round-trips url and height without loss', () => {
    const { first, second } = inEditor(() => {
      const first = $createWebEmbedNode({ url, height: 600 }).exportJSON()
      const second = WebEmbedNode.importJSON(first).exportJSON()
      return { first, second }
    })
    expect(second.data.url).toBe(url)
    expect(second.data.height).toBe(600)
    expect(second).toEqual(first)
  })

  it('keeps type and version stable', () => {
    const json = inEditor(() => $createWebEmbedNode({ url }).exportJSON())
    expect(json.type).toBe('web-embed')
    expect(json.type).toBe(WebEmbedNode.getType())
    expect(json.version).toBe(1)
  })

  it('clamps out-of-range heights', () => {
    const tooBig = inEditor(() => $createWebEmbedNode({ url, height: 5000 }).exportJSON())
    expect(tooBig.data.height).toBe(1200)
    const tooSmall = inEditor(() => $createWebEmbedNode({ url, height: 10 }).exportJSON())
    expect(tooSmall.data.height).toBe(160)
  })

  it('defaults height when missing', () => {
    const json = inEditor(() => $createWebEmbedNode({ url }).exportJSON())
    expect(json.data.height).toBe(480)
  })

  it('degrades gracefully when data is missing (old data)', () => {
    const legacy = { type: 'web-embed', version: 1 } as unknown as SerializedWebEmbedNode
    const json = inEditor(() => WebEmbedNode.importJSON(legacy).exportJSON())
    expect(json.data.url).toBe('')
    expect(json.data.height).toBe(480)
  })

  it('exposes the url via getTextContent()', () => {
    const value = inEditor(() => $createWebEmbedNode({ url }).getTextContent())
    expect(value).toBe(url)
  })
})
