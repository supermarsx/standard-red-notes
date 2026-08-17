import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'util'
import {
  canUseSyntaxHighlighting,
  decodeTextPreview,
  MAX_HIGHLIGHT_BYTES,
  MAX_HIGHLIGHT_LINES,
  MAX_TEXT_PREVIEW_BYTES,
  neutralizeBidiControls,
  tokenizeTextLine,
} from './textPreviewContent'

const codecGlobal = globalThis as unknown as { TextEncoder?: unknown; TextDecoder?: unknown }
if (!codecGlobal.TextEncoder) {
  codecGlobal.TextEncoder = NodeTextEncoder
}
if (!codecGlobal.TextDecoder) {
  codecGlobal.TextDecoder = NodeTextDecoder
}

describe('text preview content safety', () => {
  it('decodes bounded valid UTF-8 without replacement characters', () => {
    const result = decodeTextPreview(new TextEncoder().encode('remote vpn.example.test 1194\n'))

    expect(result).toEqual({
      status: 'ready',
      text: 'remote vpn.example.test 1194\n',
      hadBidiControls: false,
    })
  })

  it('rejects malformed UTF-8 and binary NUL bytes', () => {
    expect(decodeTextPreview(new Uint8Array([0xc3, 0x28]))).toEqual({ status: 'binary-or-invalid-utf8' })
    expect(decodeTextPreview(new Uint8Array([0x61, 0x00, 0x62]))).toEqual({
      status: 'binary-or-invalid-utf8',
    })
  })

  it('refuses to decode text beyond the hard preview budget', () => {
    const bytes = new Uint8Array(MAX_TEXT_PREVIEW_BYTES + 1)
    bytes.fill(0x61)

    expect(decodeTextPreview(bytes)).toEqual({ status: 'too-large' })
  })

  it('disables tokenization for byte-heavy and line-heavy content', () => {
    expect(canUseSyntaxHighlighting(MAX_HIGHLIGHT_BYTES + 1, 'client', 'openvpn')).toBe(false)
    expect(canUseSyntaxHighlighting(100, 'line\n'.repeat(MAX_HIGHLIGHT_LINES + 1), 'openvpn')).toBe(false)
    expect(canUseSyntaxHighlighting(100, 'client\nremote vpn.example.test', 'openvpn')).toBe(true)
    expect(canUseSyntaxHighlighting(10, 'plain', 'plain')).toBe(false)
  })

  it('highlights OpenVPN directives, comments, and inline certificate boundaries', () => {
    expect(tokenizeTextLine('remote vpn.example.test 1194', 'openvpn')[0]).toEqual({
      kind: 'keyword',
      text: 'remote',
    })
    expect(tokenizeTextLine('# private profile', 'openvpn')).toEqual([{ kind: 'comment', text: '# private profile' }])
    expect(tokenizeTextLine('<ca>', 'openvpn')).toEqual([{ kind: 'tag', text: '<ca>' }])
  })

  it('keeps markup as text tokens rather than executable HTML', () => {
    const tokens = tokenizeTextLine('<script>alert("no")</script>', 'markup')

    expect(tokens.map((token) => token.text).join('')).toBe('<script>alert("no")</script>')
    expect(tokens.some((token) => token.kind === 'tag')).toBe(true)
  })

  it('replaces every bidi mark, embedding, override, and isolate with a visible marker', () => {
    const controls = [
      ['\u061c', 'U+061C'],
      ['\u200e', 'U+200E'],
      ['\u200f', 'U+200F'],
      ['\u202a', 'U+202A'],
      ['\u202b', 'U+202B'],
      ['\u202c', 'U+202C'],
      ['\u202d', 'U+202D'],
      ['\u202e', 'U+202E'],
      ['\u2066', 'U+2066'],
      ['\u2067', 'U+2067'],
      ['\u2068', 'U+2068'],
      ['\u2069', 'U+2069'],
    ]
    const value = controls.map(([control]) => control).join('')
    const result = neutralizeBidiControls(value)

    expect(result.hadBidiControls).toBe(true)
    for (const [control, label] of controls) {
      expect(result.text).not.toContain(control)
      expect(result.text).toContain(`[${label}`)
    }
  })
})
