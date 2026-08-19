import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  FileProtocolError,
  MAX_FILE_CHUNK_BYTES,
  MAX_FILE_TRANSFER_BYTES,
  decodeFileBinaryFrame,
  encodeFileBinaryFrame,
  type FileBinaryHeader,
} from '../src/filesProtocol.js'

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function header(bytes: Uint8Array, overrides: Partial<FileBinaryHeader> = {}): FileBinaryHeader {
  return {
    kind: 'UPLOAD_CHUNK',
    requestId: 'request-1',
    transferId: 'transfer-1',
    generation: 1,
    index: 0,
    offset: 0,
    declaredSize: bytes.byteLength,
    byteLength: bytes.byteLength,
    sha256: digest(bytes),
    final: true,
    ...overrides,
  }
}

function expectProtocolCode(operation: () => unknown, code: FileProtocolError['code']): void {
  try {
    operation()
    throw new Error('Expected file protocol operation to fail.')
  } catch (error) {
    expect(error).toBeInstanceOf(FileProtocolError)
    expect((error as FileProtocolError).code).toBe(code)
  }
}

describe('FILES_V1 binary protocol', () => {
  it('round trips an exact 256 KiB chunk without copying it into JSON', () => {
    const bytes = new Uint8Array(MAX_FILE_CHUNK_BYTES).fill(0xa5)
    const encoded = encodeFileBinaryFrame(header(bytes), bytes)

    const decoded = decodeFileBinaryFrame(encoded)

    expect(decoded.header).toEqual(header(bytes))
    expect(decoded.bytes.byteLength).toBe(MAX_FILE_CHUNK_BYTES)
    expect(Buffer.from(decoded.bytes).equals(Buffer.from(bytes))).toBe(true)
  })

  it('rejects a chunk one byte over the binary payload boundary', () => {
    const bytes = new Uint8Array(MAX_FILE_CHUNK_BYTES + 1)
    expectProtocolCode(() => encodeFileBinaryFrame(header(bytes), bytes), 'FILE_FRAME_MALFORMED')
  })

  it('rejects truncated prefixes and headers', () => {
    expectProtocolCode(() => decodeFileBinaryFrame(new Uint8Array([1, 2, 3])), 'FILE_FRAME_MALFORMED')

    const bytes = new Uint8Array([1, 2, 3])
    const encoded = encodeFileBinaryFrame(header(bytes), bytes)
    expectProtocolCode(() => decodeFileBinaryFrame(encoded.subarray(0, 10)), 'FILE_FRAME_MALFORMED')
  })

  it('rejects a non-canonical prefix header length and a truncated payload', () => {
    const bytes = new Uint8Array([1, 2, 3])
    const encoded = encodeFileBinaryFrame(header(bytes), bytes)
    const wrongHeaderLength = Buffer.from(encoded)
    wrongHeaderLength.writeUInt16BE(wrongHeaderLength.readUInt16BE(6) - 1, 6)
    expectProtocolCode(() => decodeFileBinaryFrame(wrongHeaderLength), 'FILE_FRAME_MALFORMED')

    expectProtocolCode(() => decodeFileBinaryFrame(encoded.subarray(0, encoded.byteLength - 1)), 'FILE_FRAME_MALFORMED')
  })

  it('rejects oversized declarations, unsafe offsets, and final-size disagreement before encoding', () => {
    const bytes = new Uint8Array([1])
    expectProtocolCode(
      () => encodeFileBinaryFrame(header(bytes, { declaredSize: MAX_FILE_TRANSFER_BYTES + 1 }), bytes),
      'FILE_FRAME_MALFORMED',
    )
    expectProtocolCode(
      () => encodeFileBinaryFrame(header(bytes, { offset: Number.MAX_SAFE_INTEGER }), bytes),
      'FILE_FRAME_MALFORMED',
    )
    expectProtocolCode(
      () => encodeFileBinaryFrame(header(bytes, { declaredSize: 2, final: true }), bytes),
      'FILE_FRAME_MALFORMED',
    )
  })

  it('rejects checksum mismatches without exposing the payload', () => {
    const bytes = new Uint8Array([1, 2, 3])
    const encoded = encodeFileBinaryFrame(header(bytes), bytes)
    encoded[encoded.byteLength - 1] ^= 0xff

    expectProtocolCode(() => decodeFileBinaryFrame(encoded), 'FILE_FRAME_INTEGRITY')
  })
})
