/** Per authenticated sync socket, independent of HTTP/authentication limits. */
export const SYNC_TRAFFIC_DEFAULTS = {
  frameCapacity: 1024,
  frameRefillPerSecond: 256,
  byteCapacity: 32 * 1024 * 1024,
  byteRefillPerSecond: 8 * 1024 * 1024,
  maxQueuedFrames: 64,
  maxQueuedBytes: 16 * 1024 * 1024,
} as const
export type SyncTrafficLimits = { -readonly [K in keyof typeof SYNC_TRAFFIC_DEFAULTS]: number }
export const SYNC_TRAFFIC_BOUNDS: Record<keyof SyncTrafficLimits, readonly [number, number]> = {
  frameCapacity: [1, 65536],
  frameRefillPerSecond: [1, 16384],
  byteCapacity: [512 * 1024, 256 * 1024 * 1024],
  byteRefillPerSecond: [1, 64 * 1024 * 1024],
  maxQueuedFrames: [1, 256],
  maxQueuedBytes: [512 * 1024, 64 * 1024 * 1024],
}
export const SYNC_TRAFFIC_ENV: Record<keyof SyncTrafficLimits, string> = {
  frameCapacity: 'WEBSOCKET_SYNC_INGRESS_FRAME_BURST',
  frameRefillPerSecond: 'WEBSOCKET_SYNC_INGRESS_FRAMES_PER_SECOND',
  byteCapacity: 'WEBSOCKET_SYNC_INGRESS_BYTE_BURST',
  byteRefillPerSecond: 'WEBSOCKET_SYNC_INGRESS_BYTES_PER_SECOND',
  maxQueuedFrames: 'WEBSOCKET_SYNC_QUEUE_FRAMES',
  maxQueuedBytes: 'WEBSOCKET_SYNC_QUEUE_BYTES',
}
export function validSyncTrafficValue(key: keyof SyncTrafficLimits, value: unknown): value is number {
  const [min, max] = SYNC_TRAFFIC_BOUNDS[key]
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}
export function resolveSyncTrafficLimits(
  environment: Readonly<Record<string, string | undefined>> = {},
  overlay: Partial<SyncTrafficLimits> = {},
): SyncTrafficLimits {
  const resolved: SyncTrafficLimits = { ...SYNC_TRAFFIC_DEFAULTS }
  for (const key of Object.keys(resolved) as Array<keyof SyncTrafficLimits>) {
    const raw = environment[SYNC_TRAFFIC_ENV[key]]?.trim()
    if (raw) {
      const value = /^\d+$/.test(raw) ? Number(raw) : NaN
      if (!validSyncTrafficValue(key, value)) {
        throw new Error(`Invalid ${SYNC_TRAFFIC_ENV[key]}.`)
      }
      resolved[key] = value
    }
    if (overlay[key] !== undefined) {
      if (!validSyncTrafficValue(key, overlay[key])) {
        throw new Error(`Invalid websocket traffic limit ${key}.`)
      }
      resolved[key] = overlay[key]!
    }
  }
  return resolved
}
