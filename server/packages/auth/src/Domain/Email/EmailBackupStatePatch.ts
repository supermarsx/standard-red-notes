import {
  EmailBackupDeliveryState,
  PendingEmailBackupBatch,
  pendingBatchMatches,
  recordCompletedEmailBackupBatch,
  recordPendingEmailBackupBatch,
  removePendingEmailBackupBatch,
  serializeEmailBackupDeliveryState,
} from './EmailBackupDeliveryState'

/** Applies a caller's snapshot-to-next transition to the latest locked state. */
export function applyEmailBackupStatePatch(
  current: EmailBackupDeliveryState,
  previous: EmailBackupDeliveryState,
  next: EmailBackupDeliveryState,
): EmailBackupDeliveryState {
  let merged = current

  for (const previousBatch of previous.pending) {
    if (!next.pending.some((entry) => entry.batchId === previousBatch.batchId)) {
      merged = removePendingEmailBackupBatch(merged, previousBatch.batchId)
    }
  }

  for (const nextBatch of next.pending) {
    const previousBatch = previous.pending.find((entry) => entry.batchId === nextBatch.batchId)
    if (previousBatch && JSON.stringify(previousBatch) === JSON.stringify(nextBatch)) {
      continue
    }
    if (merged.completed.some((entry) => entry.batchId === nextBatch.batchId)) {
      continue
    }

    const currentBatch = merged.pending.find((entry) => entry.batchId === nextBatch.batchId)
    merged = recordPendingEmailBackupBatch(
      merged,
      currentBatch ? mergePendingBatch(currentBatch, nextBatch) : nextBatch,
    )
  }

  for (const completed of next.completed) {
    const previousCompleted = previous.completed.find((entry) => entry.batchId === completed.batchId)
    if (!previousCompleted || previousCompleted.deliveredAt !== completed.deliveredAt) {
      merged = recordCompletedEmailBackupBatch(merged, completed.batchId, completed.deliveredAt)
    }
  }

  // Validate capacity and the MariaDB TEXT-safe serialized bound before the
  // transaction can persist anything.
  serializeEmailBackupDeliveryState(merged)

  return merged
}

function mergePendingBatch(current: PendingEmailBackupBatch, next: PendingEmailBackupBatch): PendingEmailBackupBatch {
  if (!pendingBatchMatches(current, next)) {
    throw new Error('Email backup pending batch identity changed')
  }

  return {
    ...current,
    deliveries: current.deliveries.map((delivery, index) => ({
      ...delivery,
      queueAccepted: delivery.queueAccepted || next.deliveries[index].queueAccepted,
    })),
  }
}
