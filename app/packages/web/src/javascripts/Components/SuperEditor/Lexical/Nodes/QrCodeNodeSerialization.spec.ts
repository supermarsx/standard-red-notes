/**
 * @jest-environment jsdom
 *
 * Mirrors TimelineNodeSerialization.spec.ts / MathNodeSerialization.spec.ts.
 *
 *   1. QrCodeNode serialization round-trips (exportJSON -> importJSON ->
 *      exportJSON) including text, size and error-correction level.
 *   2. Old / missing / malformed data degrades gracefully to an empty, editable
 *      QR block (empty text, default size/level) rather than throwing.
 *
 * Constructing a node assigns a key, which is a write requiring an active
 * editor; node work runs inside editor.update().
 */

import { createHeadlessEditor } from '@lexical/headless'

import {
  $createQrCodeNode,
  normalize,
  QrCodeData,
  QrCodeNode,
  QR_DEFAULT_ERROR_CORRECTION,
  QR_DEFAULT_SIZE,
  SerializedQrCodeNode,
} from './QrCodeNode'

const editor = createHeadlessEditor({
  namespace: 'QrCodeNodeSerializationTest',
  nodes: [QrCodeNode],
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

const sampleData: QrCodeData = {
  version: 1,
  text: 'https://standardnotes.com',
  size: 256,
  errorCorrection: 'H',
}

describe('QrCodeNode serialization round-trip', () => {
  it('round-trips text, size and error-correction without loss', () => {
    const { first, second } = inEditor(() => {
      const first = $createQrCodeNode(sampleData).exportJSON()
      const second = QrCodeNode.importJSON(first).exportJSON()
      return { first, second }
    })
    expect(second.data).toEqual(first.data)
    expect(second.data.text).toBe('https://standardnotes.com')
    expect(second.data.size).toBe(256)
    expect(second.data.errorCorrection).toBe('H')
  })

  it('keeps type and version stable', () => {
    const json = inEditor(() => $createQrCodeNode(sampleData).exportJSON())
    expect(json.type).toBe('qr-code')
    expect(json.type).toBe(QrCodeNode.getType())
    expect(json.version).toBe(1)
  })

  it('is a block node', () => {
    const inline = inEditor(() => $createQrCodeNode(sampleData).isInline())
    expect(inline).toBe(false)
  })

  it('exposes the encoded text as the node text content', () => {
    const text = inEditor(() => $createQrCodeNode(sampleData).getTextContent())
    expect(text).toBe('https://standardnotes.com')
  })

  it('degrades gracefully when data is missing (old data)', () => {
    const legacy = { type: 'qr-code', version: 1 } as unknown as SerializedQrCodeNode
    const json = inEditor(() => QrCodeNode.importJSON(legacy).exportJSON())
    expect(json.data.text).toBe('')
    expect(json.data.size).toBe(QR_DEFAULT_SIZE)
    expect(json.data.errorCorrection).toBe(QR_DEFAULT_ERROR_CORRECTION)
  })

  it('does not throw on a completely malformed data blob', () => {
    const garbage = { type: 'qr-code', version: 1, data: 42 } as unknown as SerializedQrCodeNode
    const json = inEditor(() => QrCodeNode.importJSON(garbage).exportJSON())
    expect(json.data.text).toBe('')
    expect(json.data.size).toBe(QR_DEFAULT_SIZE)
    expect(json.data.errorCorrection).toBe(QR_DEFAULT_ERROR_CORRECTION)
  })
})

describe('normalize', () => {
  it('coerces a non-string text to an empty string', () => {
    expect(normalize({ text: 123 as unknown as string }).text).toBe('')
  })

  it('falls back to the default error-correction level for invalid values', () => {
    expect(normalize({ errorCorrection: 'Z' as unknown as QrCodeData['errorCorrection'] }).errorCorrection).toBe(
      QR_DEFAULT_ERROR_CORRECTION,
    )
  })

  it('clamps oversized sizes into range and rounds them', () => {
    expect(normalize({ size: 9999 }).size).toBe(512)
    expect(normalize({ size: 10 }).size).toBe(64)
    expect(normalize({ size: 200.6 }).size).toBe(201)
  })

  it('returns defaults for null/undefined', () => {
    expect(normalize(null)).toEqual({
      version: 1,
      text: '',
      size: QR_DEFAULT_SIZE,
      errorCorrection: QR_DEFAULT_ERROR_CORRECTION,
    })
    expect(normalize(undefined).text).toBe('')
  })

  it('preserves valid data', () => {
    expect(normalize({ text: 'hi', size: 128, errorCorrection: 'Q' })).toEqual({
      version: 1,
      text: 'hi',
      size: 128,
      errorCorrection: 'Q',
    })
  })
})
