import { createHash, timingSafeEqual } from 'crypto'

export const SYNC_COMMAND_ID_MAX_BYTES = 128
export const SYNC_COMMAND_DIGEST_PATTERN = /^[a-f0-9]{64}$/i

export type SyncCommandStatus = 'accepted' | 'committed'

export type SyncCommandMetadata = {
  id: string
  digest: string
}

export type SyncCommandResponseMetadata = SyncCommandMetadata & {
  status: SyncCommandStatus
}

export type SyncCommandResult<T extends Record<string, unknown>> = {
  response: T & { command: SyncCommandResponseMetadata }
  replayed: boolean
}

export class SyncCommandProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400,
  ) {
    super(message)
    this.name = 'SyncCommandProtocolError'
  }
}

export function validateSyncCommandMetadata(metadata: SyncCommandMetadata): void {
  const idBytes = Buffer.byteLength(metadata.id, 'utf8')
  if (idBytes === 0 || idBytes > SYNC_COMMAND_ID_MAX_BYTES || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(metadata.id)) {
    throw new SyncCommandProtocolError(
      'invalid_sync_command_id',
      `Sync command id must be 1-${SYNC_COMMAND_ID_MAX_BYTES} bytes of URL-safe opaque text.`,
    )
  }

  if (!SYNC_COMMAND_DIGEST_PATTERN.test(metadata.digest)) {
    throw new SyncCommandProtocolError(
      'invalid_sync_command_digest',
      'Sync command digest must be a hexadecimal SHA-256 digest.',
    )
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  }

  const object = value as Record<string, unknown>
  const keys = Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()

  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`
}

export function computeSyncCommandDigest(payload: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex')
}

export function syncCommandDigestsEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left.toLowerCase(), 'utf8')
  const rightBuffer = Buffer.from(right.toLowerCase(), 'utf8')
  const comparisonBuffer = rightBuffer.length === leftBuffer.length ? rightBuffer : Buffer.alloc(leftBuffer.length)
  const equal = timingSafeEqual(leftBuffer, comparisonBuffer)

  return equal && leftBuffer.length === rightBuffer.length
}

export function assertSyncCommandDigest(
  metadata: SyncCommandMetadata,
  canonicalPayload: Record<string, unknown>,
): void {
  assertSyncCommandDigestValue(metadata, computeSyncCommandDigest(canonicalPayload))
}

export function assertSyncCommandDigestValue(metadata: SyncCommandMetadata, serverDigest: string): void {
  validateSyncCommandMetadata(metadata)
  if (!SYNC_COMMAND_DIGEST_PATTERN.test(serverDigest)) {
    throw new SyncCommandProtocolError(
      'invalid_sync_command_digest',
      'Trusted sync command digest must be a hexadecimal SHA-256 digest.',
    )
  }
  if (!syncCommandDigestsEqual(metadata.digest, serverDigest)) {
    throw new SyncCommandProtocolError(
      'sync_command_digest_mismatch',
      'Sync command id was presented with a different request digest.',
      409,
    )
  }
}
