import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  FileProtocolError,
  MAX_FILE_BINARY_FRAME_BYTES,
  MAX_FILE_BINARY_HEADER_BYTES,
  MAX_FILE_CHUNK_BYTES,
  MAX_FILE_TRANSFER_BYTES,
  decodeFileBinaryFrame,
  encodeFileBinaryFrame,
  isFileIdentifier,
  isFileMimeType,
  isFileResourceReference,
  isFileSha256,
  isFileTransferSize,
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

function rawBinaryFrame(kindByte: number, headerValue: unknown, bytes = new Uint8Array([1])): Buffer {
  const headerBytes = Buffer.from(typeof headerValue === 'string' ? headerValue : JSON.stringify(headerValue), 'utf8')
  const frame = Buffer.alloc(8 + headerBytes.byteLength + bytes.byteLength)
  frame.write('SRNF', 0, 'ascii')
  frame.writeUInt8(1, 4)
  frame.writeUInt8(kindByte, 5)
  frame.writeUInt16BE(headerBytes.byteLength, 6)
  headerBytes.copy(frame, 8)
  Buffer.from(bytes).copy(frame, 8 + headerBytes.byteLength)
  return frame
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

  it('rejects oversized, invalid-magic, unsupported-version, and invalid-prefix frames', () => {
    expectProtocolCode(
      () => decodeFileBinaryFrame(new Uint8Array(MAX_FILE_BINARY_FRAME_BYTES + 1)),
      'FILE_FRAME_TOO_LARGE',
    )

    const bytes = new Uint8Array([1])
    const encoded = encodeFileBinaryFrame(header(bytes), bytes)
    const invalidMagic = Buffer.from(encoded)
    invalidMagic.write('NOPE', 0, 'ascii')
    expectProtocolCode(() => decodeFileBinaryFrame(invalidMagic), 'FILE_FRAME_MALFORMED')

    const unsupportedVersion = Buffer.from(encoded)
    unsupportedVersion.writeUInt8(2, 4)
    expectProtocolCode(() => decodeFileBinaryFrame(unsupportedVersion), 'FILE_FRAME_UNSUPPORTED')

    for (const malformed of [
      (() => {
        const value = Buffer.from(encoded)
        value.writeUInt8(3, 5)
        return value
      })(),
      (() => {
        const value = Buffer.from(encoded)
        value.writeUInt16BE(1, 6)
        return value
      })(),
      (() => {
        const value = Buffer.from(encoded)
        value.writeUInt16BE(MAX_FILE_BINARY_HEADER_BYTES + 1, 6)
        return value
      })(),
      (() => {
        const value = Buffer.from(encoded.subarray(0, 12))
        value.writeUInt16BE(100, 6)
        return value
      })(),
    ]) {
      expectProtocolCode(() => decodeFileBinaryFrame(malformed), 'FILE_FRAME_MALFORMED')
    }
  })

  it('rejects non-JSON, non-object, and prefix/header kind disagreement', () => {
    expectProtocolCode(() => decodeFileBinaryFrame(rawBinaryFrame(1, '{', new Uint8Array([1]))), 'FILE_FRAME_MALFORMED')
    expectProtocolCode(
      () => decodeFileBinaryFrame(rawBinaryFrame(1, null, new Uint8Array([1]))),
      'FILE_FRAME_MALFORMED',
    )
    expectProtocolCode(() => decodeFileBinaryFrame(rawBinaryFrame(1, [], new Uint8Array([1]))), 'FILE_FRAME_MALFORMED')

    const bytes = new Uint8Array([1])
    const encoded = encodeFileBinaryFrame(header(bytes), bytes)
    encoded.writeUInt8(2, 5)
    expectProtocolCode(() => decodeFileBinaryFrame(encoded), 'FILE_FRAME_MALFORMED')
  })

  it.each([
    ['extra key', { extra: true }],
    ['invalid kind', { kind: 'OTHER' }],
    ['invalid request identifier', { requestId: '../request' }],
    ['invalid transfer identifier', { transferId: '' }],
    ['non-integer generation', { generation: 1.5 }],
    ['zero generation', { generation: 0 }],
    ['non-integer index', { index: 0.5 }],
    ['negative index', { index: -1 }],
    ['non-integer offset', { offset: 0.5 }],
    ['negative offset', { offset: -1 }],
    ['zero declared size', { declaredSize: 0 }],
    ['non-integer byte length', { byteLength: 0.5 }],
    ['zero byte length', { byteLength: 0 }],
    ['oversized byte length', { byteLength: MAX_FILE_CHUNK_BYTES + 1 }],
    ['actual byte-length mismatch', { byteLength: 2 }],
    ['range overflow', { offset: 1 }],
    ['invalid digest', { sha256: 'A'.repeat(64) }],
    ['non-boolean final', { final: 'yes' }],
    ['incorrect final marker', { declaredSize: 2, final: true }],
  ])('rejects a binary header with %s', (_label, overrides) => {
    const bytes = new Uint8Array([1])
    expectProtocolCode(
      () => encodeFileBinaryFrame({ ...header(bytes), ...overrides } as FileBinaryHeader, bytes),
      'FILE_FRAME_MALFORMED',
    )
  })

  it('validates strict resource, size, MIME, identifier, and digest boundaries', () => {
    expect(isFileIdentifier('file-1')).toBe(true)
    expect(isFileIdentifier(1)).toBe(false)
    expect(isFileIdentifier('')).toBe(false)
    expect(isFileIdentifier(`x${'a'.repeat(128)}`)).toBe(false)

    expect(isFileSha256('a'.repeat(64))).toBe(true)
    expect(isFileSha256(undefined)).toBe(false)
    expect(isFileSha256('A'.repeat(64))).toBe(false)

    expect(isFileResourceReference(null)).toBe(false)
    expect(isFileResourceReference([])).toBe(false)
    expect(isFileResourceReference({ ownershipType: 'other', remoteIdentifier: 'file-1' })).toBe(false)
    expect(isFileResourceReference({ ownershipType: 'user', remoteIdentifier: '' })).toBe(false)
    expect(isFileResourceReference({ ownershipType: 'user', remoteIdentifier: 'file-1', fileUuid: '' })).toBe(false)
    expect(
      isFileResourceReference({ ownershipType: 'user', remoteIdentifier: 'file-1', sharedVaultUuid: 'vault-1' }),
    ).toBe(false)
    expect(
      isFileResourceReference({
        ownershipType: 'shared-vault',
        remoteIdentifier: 'file-1',
        sharedVaultUuid: 'vault-1',
      }),
    ).toBe(false)
    expect(
      isFileResourceReference({
        ownershipType: 'shared-vault',
        remoteIdentifier: 'file-1',
        sharedVaultUuid: 'vault-1',
        sharedVaultOwnerUuid: 'owner-1',
      }),
    ).toBe(true)

    expect(isFileTransferSize(1)).toBe(true)
    expect(isFileTransferSize(0)).toBe(false)
    expect(isFileTransferSize(0, true)).toBe(true)
    expect(isFileTransferSize(1.5)).toBe(false)
    expect(isFileTransferSize(-1, true)).toBe(false)
    expect(isFileTransferSize(MAX_FILE_TRANSFER_BYTES + 1)).toBe(false)

    expect(isFileMimeType('application/octet-stream')).toBe(true)
    expect(isFileMimeType(undefined)).toBe(false)
    expect(isFileMimeType('')).toBe(false)
    expect(isFileMimeType('x'.repeat(256))).toBe(false)
    expect(isFileMimeType('text/plain\nunsafe')).toBe(false)
  })
})
