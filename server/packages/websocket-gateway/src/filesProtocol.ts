import { createHash, timingSafeEqual } from 'node:crypto'

export const FILES_PROTOCOL_VERSION = 1 as const
export const FILES_NEGOTIATED_OPERATION = 'FILES_V1' as const
export const MAX_FILE_CHUNK_BYTES = 256 * 1024
export const MAX_FILE_BINARY_HEADER_BYTES = 4 * 1024
export const MAX_FILE_BINARY_FRAME_BYTES = MAX_FILE_CHUNK_BYTES + MAX_FILE_BINARY_HEADER_BYTES + 8
export const MAX_FILE_TRANSFER_BYTES = 5 * 1024 * 1024 * 1024
export const MAX_FILE_METADATA_ENTRIES = 100
export const MAX_FILE_MIME_TYPE_BYTES = 255
export const MAX_FILE_TRANSFER_CREDIT_BYTES = 4 * 1024 * 1024
export const DEFAULT_FILE_TRANSFER_CREDIT_BYTES = 512 * 1024
export const MIN_FILE_TRANSFER_DEADLINE_MS = 1_000
export const MAX_FILE_TRANSFER_DEADLINE_MS = 120_000
export const DEFAULT_FILE_TRANSFER_DEADLINE_MS = 30_000

const FILE_BINARY_MAGIC = Buffer.from('SRNF', 'ascii')
const FILE_BINARY_PREFIX_BYTES = 8
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const SHA256_PATTERN = /^[a-f0-9]{64}$/u

export type FileOwnershipType = 'user' | 'shared-vault'
export type FileBinaryKind = 'UPLOAD_CHUNK' | 'DOWNLOAD_CHUNK'

export type FileResourceReference = {
  ownershipType: FileOwnershipType
  remoteIdentifier: string
  fileUuid?: string
  sharedVaultUuid?: string
  sharedVaultOwnerUuid?: string
}

export type FileUploadDescriptor = FileResourceReference & {
  decryptedSize: number
  declaredSize: number
  mimeType: string
  resumeId?: string
}

export type FileBinaryHeader = {
  kind: FileBinaryKind
  requestId: string
  transferId: string
  generation: number
  index: number
  offset: number
  declaredSize: number
  byteLength: number
  sha256: string
  final: boolean
}

export type DecodedFileBinaryFrame = {
  header: FileBinaryHeader
  bytes: Uint8Array
}

export class FileProtocolError extends Error {
  constructor(
    readonly code:
      | 'FILE_FRAME_TOO_LARGE'
      | 'FILE_FRAME_MALFORMED'
      | 'FILE_FRAME_UNSUPPORTED'
      | 'FILE_FRAME_INTEGRITY',
    message: string,
  ) {
    super(message)
    this.name = 'FileProtocolError'
  }
}

export function encodeFileBinaryFrame(header: FileBinaryHeader, bytes: Uint8Array): Buffer {
  validateFileBinaryHeader(header, bytes.byteLength)
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8')
  if (headerBytes.byteLength > MAX_FILE_BINARY_HEADER_BYTES) {
    throw new FileProtocolError('FILE_FRAME_TOO_LARGE', 'File binary header exceeds its limit.')
  }
  const frame = Buffer.allocUnsafe(FILE_BINARY_PREFIX_BYTES + headerBytes.byteLength + bytes.byteLength)
  FILE_BINARY_MAGIC.copy(frame, 0)
  frame.writeUInt8(FILES_PROTOCOL_VERSION, 4)
  frame.writeUInt8(header.kind === 'UPLOAD_CHUNK' ? 1 : 2, 5)
  frame.writeUInt16BE(headerBytes.byteLength, 6)
  headerBytes.copy(frame, FILE_BINARY_PREFIX_BYTES)
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).copy(
    frame,
    FILE_BINARY_PREFIX_BYTES + headerBytes.byteLength,
  )
  return frame
}

export function decodeFileBinaryFrame(raw: Uint8Array): DecodedFileBinaryFrame {
  if (raw.byteLength > MAX_FILE_BINARY_FRAME_BYTES) {
    throw new FileProtocolError('FILE_FRAME_TOO_LARGE', 'File binary frame exceeds its limit.')
  }
  if (raw.byteLength < FILE_BINARY_PREFIX_BYTES) {
    throw new FileProtocolError('FILE_FRAME_MALFORMED', 'File binary frame is truncated.')
  }
  const frame = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
  if (!timingSafeEqual(frame.subarray(0, FILE_BINARY_MAGIC.byteLength), FILE_BINARY_MAGIC)) {
    throw new FileProtocolError('FILE_FRAME_MALFORMED', 'File binary frame has an invalid magic value.')
  }
  if (frame.readUInt8(4) !== FILES_PROTOCOL_VERSION) {
    throw new FileProtocolError('FILE_FRAME_UNSUPPORTED', 'File binary frame version is unsupported.')
  }
  const kindByte = frame.readUInt8(5)
  const headerLength = frame.readUInt16BE(6)
  if (
    (kindByte !== 1 && kindByte !== 2) ||
    headerLength < 2 ||
    headerLength > MAX_FILE_BINARY_HEADER_BYTES ||
    FILE_BINARY_PREFIX_BYTES + headerLength > frame.byteLength
  ) {
    throw new FileProtocolError('FILE_FRAME_MALFORMED', 'File binary frame prefix is invalid.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(frame.subarray(FILE_BINARY_PREFIX_BYTES, FILE_BINARY_PREFIX_BYTES + headerLength).toString('utf8'))
  } catch {
    throw new FileProtocolError('FILE_FRAME_MALFORMED', 'File binary header is not valid JSON.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FileProtocolError('FILE_FRAME_MALFORMED', 'File binary header must be an object.')
  }
  const payload = frame.subarray(FILE_BINARY_PREFIX_BYTES + headerLength)
  const header = parsed as FileBinaryHeader
  const expectedKind: FileBinaryKind = kindByte === 1 ? 'UPLOAD_CHUNK' : 'DOWNLOAD_CHUNK'
  if (header.kind !== expectedKind) {
    throw new FileProtocolError('FILE_FRAME_MALFORMED', 'File binary kind disagrees with its header.')
  }
  validateFileBinaryHeader(header, payload.byteLength)
  const digest = createHash('sha256').update(payload).digest('hex')
  if (!constantTimeHexMatches(header.sha256, digest)) {
    throw new FileProtocolError('FILE_FRAME_INTEGRITY', 'File binary payload digest does not match.')
  }
  return { header, bytes: new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength) }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function isFileIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value)
}

export function isFileSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value)
}

export function isFileResourceReference(value: unknown): value is FileResourceReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const candidate = value as Partial<FileResourceReference>
  if (
    (candidate.ownershipType !== 'user' && candidate.ownershipType !== 'shared-vault') ||
    !isFileIdentifier(candidate.remoteIdentifier) ||
    (candidate.fileUuid !== undefined && !isFileIdentifier(candidate.fileUuid))
  ) {
    return false
  }
  if (candidate.ownershipType === 'user') {
    return candidate.sharedVaultUuid === undefined && candidate.sharedVaultOwnerUuid === undefined
  }
  return isFileIdentifier(candidate.sharedVaultUuid) && isFileIdentifier(candidate.sharedVaultOwnerUuid)
}

export function isFileTransferSize(value: unknown, allowZero = false): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= (allowZero ? 0 : 1) &&
    Number(value) <= MAX_FILE_TRANSFER_BYTES
  )
}

export function isFileMimeType(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= MAX_FILE_MIME_TYPE_BYTES &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  )
}

function validateFileBinaryHeader(header: FileBinaryHeader, actualByteLength: number): void {
  const exactKeys = [
    'kind',
    'requestId',
    'transferId',
    'generation',
    'index',
    'offset',
    'declaredSize',
    'byteLength',
    'sha256',
    'final',
  ]
  const actualKeys = Object.keys(header).sort()
  if (
    actualKeys.length !== exactKeys.length ||
    !actualKeys.every((key, index) => key === [...exactKeys].sort()[index]) ||
    (header.kind !== 'UPLOAD_CHUNK' && header.kind !== 'DOWNLOAD_CHUNK') ||
    !isFileIdentifier(header.requestId) ||
    !isFileIdentifier(header.transferId) ||
    !Number.isSafeInteger(header.generation) ||
    header.generation < 1 ||
    !Number.isSafeInteger(header.index) ||
    header.index < 0 ||
    !Number.isSafeInteger(header.offset) ||
    header.offset < 0 ||
    !isFileTransferSize(header.declaredSize) ||
    !Number.isSafeInteger(header.byteLength) ||
    header.byteLength < 1 ||
    header.byteLength > MAX_FILE_CHUNK_BYTES ||
    header.byteLength !== actualByteLength ||
    header.offset + header.byteLength > header.declaredSize ||
    !isFileSha256(header.sha256) ||
    typeof header.final !== 'boolean' ||
    header.final !== (header.offset + header.byteLength === header.declaredSize)
  ) {
    throw new FileProtocolError('FILE_FRAME_MALFORMED', 'File binary header is invalid.')
  }
}

function constantTimeHexMatches(left: string, right: string): boolean {
  if (!SHA256_PATTERN.test(left) || !SHA256_PATTERN.test(right)) {
    return false
  }
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}
