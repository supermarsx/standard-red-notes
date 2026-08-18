import { createHash, timingSafeEqual } from 'crypto'

export function canonicalSyncCommandJson(value: unknown): string {
  if (value === undefined) {
    return 'null'
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalSyncCommandJson(entry)).join(',')}]`
  }

  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalSyncCommandJson(object[key])}`)
    .join(',')}}`
}

export function logicalSyncCommandPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const { command: _command, ...logicalPayload } = payload
  return logicalPayload
}

export function computeSyncCommandDigest(payload: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalSyncCommandJson(payload), 'utf8').digest('hex')
}

export function syncCommandDigestsEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left.toLowerCase(), 'utf8')
  const rightBuffer = Buffer.from(right.toLowerCase(), 'utf8')
  const comparison = rightBuffer.length === leftBuffer.length ? rightBuffer : Buffer.alloc(leftBuffer.length)

  return timingSafeEqual(leftBuffer, comparison) && leftBuffer.length === rightBuffer.length
}
