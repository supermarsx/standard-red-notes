import { deepFreeze } from '@standardnotes/utils'

/** Bound work between objects; one large object's recursive freeze is still atomic. */
export const DEFERRED_FREEZE_BATCH_SIZE = 128
export const DEFERRED_FREEZE_BUDGET_MS = 4

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

const pending: Array<object | undefined> = []
let offset = 0
let scheduled = false

function drain(): void {
  const end = Math.min(pending.length, offset + DEFERRED_FREEZE_BATCH_SIZE)
  const startedAt = now()
  try {
    while (offset < end) {
      const object = pending[offset]
      pending[offset++] = undefined
      if (object && !Object.isFrozen(object)) {
        deepFreeze(object)
      }
      if (now() - startedAt >= DEFERRED_FREEZE_BUDGET_MS) {
        break
      }
    }
  } finally {
    // Keep an exceptional freeze observable as before, while ensuring it cannot
    // strand later objects. A head index avoids quadratic array shifts; cleared
    // slots release each frozen object without waiting for the whole load.
    if (offset < pending.length) {
      // A continuously replenished queue may never become empty. Compact only
      // after consuming at least half, amortizing copies across drained roots.
      if (offset >= 1_024 && offset >= pending.length / 2) {
        pending.splice(0, offset)
        offset = 0
      }
      setTimeout(drain, 0)
    } else {
      pending.length = 0
      offset = 0
      scheduled = false
    }
  }
}

/** Freeze after all synchronous subclass constructors finish, sharing one timer. */
export function deferDeepFreeze(object: object): void {
  pending.push(object)
  if (!scheduled) {
    scheduled = true
    setTimeout(drain, 0)
  }
}
