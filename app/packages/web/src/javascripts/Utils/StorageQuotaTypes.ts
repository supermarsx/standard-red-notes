/** Pure shared storage contracts: safe to import from workers and headless transports. */
export const HIGH_USAGE_THRESHOLD = 0.8

export type StorageEstimateResult = {
  /** Bytes currently used by this origin (IndexedDB, caches, etc). */
  usage: number
  /** Total bytes available to this origin. */
  quota: number
  /** usage / quota in [0, 1]. 0 when quota is unknown/zero. */
  usedFraction: number
}
