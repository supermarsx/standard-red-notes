/**
 * Per-key log throttle for REFUSAL paths.
 *
 * A refusal is exactly the thing an operator needs in the log, and exactly the
 * thing a retrying client can emit thousands of times a minute. Neither
 * "log every time" nor "log once and never again" is right: the first floods,
 * the second hides a condition that came back. So the first occurrence of a key
 * is always emitted, subsequent ones inside the window are counted, and the next
 * emission after the window carries that suppressed count -- the operator sees
 * the condition promptly, sees how often it is happening, and the log stays
 * bounded at one line per key per window.
 *
 * Deliberately NOT for hot paths: this gateway carries every sync frame, and no
 * per-message code path may call a logger at all.
 */
export interface LogThrottleDecision {
  /** True when the caller should emit a log line now. */
  emit: boolean
  /** Occurrences suppressed since the previous emission for this key. */
  suppressed: number
}

export interface LogThrottleOptions {
  /** Minimum gap between emissions for one key. Defaults to 60s. */
  intervalMs?: number
  /**
   * Bound on distinct tracked keys, so an attacker-influenced key space cannot
   * grow the map without limit. Oldest entries are dropped first; a dropped key
   * simply logs again on its next occurrence. Defaults to 64.
   */
  maxKeys?: number
  now?: () => number
}

export interface LogThrottle {
  consider(key: string): LogThrottleDecision
}

export function createLogThrottle(options: LogThrottleOptions = {}): LogThrottle {
  const intervalMs = options.intervalMs ?? 60_000
  const maxKeys = options.maxKeys ?? 64
  const now = options.now ?? (() => Date.now())

  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new Error('Invalid log throttle interval: expected a finite non-negative number.')
  }
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) {
    throw new Error('Invalid log throttle key budget: expected a positive safe integer.')
  }

  // Insertion-ordered, so the first Map key is the least recently created entry.
  const lastEmittedAt = new Map<string, { at: number; suppressed: number }>()

  return {
    consider(key: string): LogThrottleDecision {
      const timestamp = now()
      const existing = lastEmittedAt.get(key)

      if (existing && timestamp - existing.at < intervalMs) {
        existing.suppressed += 1
        return { emit: false, suppressed: existing.suppressed }
      }

      const suppressed = existing?.suppressed ?? 0
      if (!existing && lastEmittedAt.size >= maxKeys) {
        const oldest = lastEmittedAt.keys().next()
        if (!oldest.done) {
          lastEmittedAt.delete(oldest.value)
        }
      }
      lastEmittedAt.delete(key)
      lastEmittedAt.set(key, { at: timestamp, suppressed: 0 })
      return { emit: true, suppressed }
    },
  }
}
