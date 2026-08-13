import { BackupAttachmentReference } from './BackupAttachmentStorageInterface'

export interface CompletedEmailBackupBatch {
  batchId: string
  deliveredAt: number
}

export interface PendingEmailBackupDelivery {
  deliveryId: string
  queueAccepted: boolean
  reference?: BackupAttachmentReference
}

export interface PendingEmailBackupBatch {
  batchId: string
  outcome: 'backup' | 'failure-notice'
  queuedAt: number
  deliveries: PendingEmailBackupDelivery[]
}

export interface EmailBackupDeliveryState {
  pending: PendingEmailBackupBatch[]
  completed: CompletedEmailBackupBatch[]
}

const MAX_BATCH_HISTORY = 32
const MAX_PENDING_BATCHES = 16
const MAX_DELIVERIES_PER_BATCH = 256
// MariaDB stores generic settings in TEXT (65,535 bytes). Keep ample room for
// the AES-GCM version envelope and encoding expansion applied by SettingCrypter.
export const MAX_EMAIL_BACKUP_DELIVERY_STATE_BYTES = 32_768
const DELIVERY_ID_PATTERN = /^backup(?:-event)?-[0-9a-f]{64}$/

export class InvalidEmailBackupDeliveryStateError extends Error {
  constructor() {
    super('Email backup delivery state is invalid')
    this.name = 'InvalidEmailBackupDeliveryStateError'
  }
}

export function emptyEmailBackupDeliveryState(): EmailBackupDeliveryState {
  return { pending: [], completed: [] }
}

/**
 * Parses server-owned receipt state strictly. Once a pending batch exists, a
 * permissive fallback could orphan its source files or allow a duplicate
 * backup to be generated, so malformed pending state must fail closed.
 */
export function parseEmailBackupDeliveryState(raw: string): EmailBackupDeliveryState {
  if (Buffer.byteLength(raw, 'utf8') > MAX_EMAIL_BACKUP_DELIVERY_STATE_BYTES) {
    throw new InvalidEmailBackupDeliveryStateError()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new InvalidEmailBackupDeliveryStateError()
  }

  if (!isRecord(parsed)) {
    throw new InvalidEmailBackupDeliveryStateError()
  }

  const completed = parsed.completed
  if (!Array.isArray(completed) || completed.length > MAX_BATCH_HISTORY) {
    throw new InvalidEmailBackupDeliveryStateError()
  }

  // Legacy rows used `{ completed }` and were plaintext. GetSetting can still
  // return their raw value after the setting classification becomes encrypted;
  // the next server-side write upgrades them to encrypted state.
  const pending = parsed.pending ?? []
  if (!Array.isArray(pending) || pending.length > MAX_PENDING_BATCHES) {
    throw new InvalidEmailBackupDeliveryStateError()
  }

  if (!completed.every(isCompletedBatch) || !pending.every(isPendingBatch)) {
    throw new InvalidEmailBackupDeliveryStateError()
  }

  return {
    completed: completed.slice(-MAX_BATCH_HISTORY),
    pending,
  }
}

export function serializeEmailBackupDeliveryState(state: EmailBackupDeliveryState): string {
  if (
    state.pending.length > MAX_PENDING_BATCHES ||
    !state.pending.every(isPendingBatch) ||
    !state.completed.every(isCompletedBatch)
  ) {
    throw new InvalidEmailBackupDeliveryStateError()
  }

  const pending = state.pending
  const completed = state.completed.slice(-MAX_BATCH_HISTORY)
  const serialized = JSON.stringify({
    ...(pending.length > 0 ? { pending } : {}),
    completed,
  })

  if (Buffer.byteLength(serialized, 'utf8') > MAX_EMAIL_BACKUP_DELIVERY_STATE_BYTES) {
    throw new InvalidEmailBackupDeliveryStateError()
  }

  return serialized
}

export function recordCompletedEmailBackupBatch(
  state: EmailBackupDeliveryState,
  batchId: string,
  deliveredAt: number,
): EmailBackupDeliveryState {
  return {
    pending: state.pending.filter((entry) => entry.batchId !== batchId),
    completed: [...state.completed.filter((entry) => entry.batchId !== batchId), { batchId, deliveredAt }].slice(
      -MAX_BATCH_HISTORY,
    ),
  }
}

export function recordPendingEmailBackupBatch(
  state: EmailBackupDeliveryState,
  batch: PendingEmailBackupBatch,
): EmailBackupDeliveryState {
  if (!isPendingBatch(batch)) {
    throw new InvalidEmailBackupDeliveryStateError()
  }

  const existing = state.pending.find((entry) => entry.batchId === batch.batchId)
  if (!existing && state.pending.length >= MAX_PENDING_BATCHES) {
    throw new InvalidEmailBackupDeliveryStateError()
  }

  return {
    pending: [...state.pending.filter((entry) => entry.batchId !== batch.batchId), batch],
    completed: state.completed,
  }
}

export function removePendingEmailBackupBatch(
  state: EmailBackupDeliveryState,
  batchId: string,
): EmailBackupDeliveryState {
  return {
    pending: state.pending.filter((entry) => entry.batchId !== batchId),
    completed: state.completed,
  }
}

export function pendingBatchMatches(pending: PendingEmailBackupBatch, expected: PendingEmailBackupBatch): boolean {
  return (
    pending.outcome === expected.outcome &&
    pending.deliveries.length === expected.deliveries.length &&
    pending.deliveries.every((delivery, index) => {
      const expectedDelivery = expected.deliveries[index]
      return (
        delivery.deliveryId === expectedDelivery.deliveryId &&
        JSON.stringify(delivery.reference) === JSON.stringify(expectedDelivery.reference)
      )
    })
  )
}

function isCompletedBatch(value: unknown): value is CompletedEmailBackupBatch {
  return (
    isRecord(value) &&
    isSafeBatchId(value.batchId) &&
    Number.isSafeInteger(value.deliveredAt) &&
    Number(value.deliveredAt) >= 0
  )
}

function isPendingBatch(value: unknown): value is PendingEmailBackupBatch {
  if (
    !isRecord(value) ||
    !isSafeBatchId(value.batchId) ||
    (value.outcome !== 'backup' && value.outcome !== 'failure-notice') ||
    !Number.isSafeInteger(value.queuedAt) ||
    Number(value.queuedAt) < 0 ||
    !Array.isArray(value.deliveries) ||
    value.deliveries.length === 0 ||
    value.deliveries.length > MAX_DELIVERIES_PER_BATCH
  ) {
    return false
  }

  if (!value.deliveries.every(isPendingDelivery)) {
    return false
  }

  const ids = value.deliveries.map((delivery) => delivery.deliveryId)
  if (new Set(ids).size !== ids.length) {
    return false
  }

  return value.outcome === 'backup'
    ? value.deliveries.every((delivery) => delivery.reference !== undefined)
    : value.deliveries.length === 1 && value.deliveries[0].reference === undefined
}

function isPendingDelivery(value: unknown): value is PendingEmailBackupDelivery {
  return (
    isRecord(value) &&
    typeof value.deliveryId === 'string' &&
    DELIVERY_ID_PATTERN.test(value.deliveryId) &&
    typeof value.queueAccepted === 'boolean' &&
    (value.reference === undefined || isAttachmentReference(value.reference))
  )
}

function isAttachmentReference(value: unknown): value is BackupAttachmentReference {
  if (!isRecord(value)) {
    return false
  }

  const hasValidBatchPosition =
    (value.batchIndex === undefined && value.batchCount === undefined) ||
    (Number.isSafeInteger(value.batchIndex) &&
      Number(value.batchIndex) >= 1 &&
      Number.isSafeInteger(value.batchCount) &&
      Number(value.batchCount) >= Number(value.batchIndex) &&
      Number(value.batchCount) <= MAX_DELIVERIES_PER_BATCH)

  return (
    isSafeFileName(value.fileName) &&
    isSafePathIdentifier(value.filePath) &&
    isSafeFileName(value.attachmentFileName) &&
    value.attachmentContentType === 'application/json' &&
    (value.emailSubject === undefined || isSafeSubject(value.emailSubject)) &&
    hasValidBatchPosition
  )
}

function isSafeBatchId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 300 && !/[\r\n\0]/.test(value)
}

function isSafeFileName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 255 &&
    !value.includes('..') &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
  )
}

function isSafePathIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2_048 && !/[\r\n\0]/.test(value)
}

function isSafeSubject(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 998 && !/[\r\n]/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
