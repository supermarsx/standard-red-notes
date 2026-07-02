// Pure, React-free helpers for the user-configurable "Maximum storage usage"
// SOFT cap shown in the Storage preferences pane. The cap is advisory only —
// nothing here (or anywhere) blocks saving or syncing; it exists so the user can
// pick a budget for this device and get warned when they approach or exceed it.

import { formatBytes } from '@/Utils/StorageQuota'

export const BYTES_PER_MB = 1024 * 1024
export const BYTES_PER_GB = 1024 * BYTES_PER_MB

/** Cap value meaning "no user-configured limit" (measure against browser quota). */
export const STORAGE_CAP_UNLIMITED = 0

/** Fraction of the cap at/above which we start warning (matches quota threshold). */
export const STORAGE_CAP_WARNING_THRESHOLD = 0.8

export type StorageCapStatus = 'ok' | 'warning' | 'over'

export type StorageCapState = {
  /** usedBytes / capBytes. 0 when there is no (valid) cap. May exceed 1 when over. */
  ratio: number
  /** ratio as a percentage clamped to [0, 100] — safe to use directly as a bar width. */
  percent: number
  /** 'ok' below the warning threshold, 'warning' at/above it, 'over' past the cap. */
  status: StorageCapStatus
  /** e.g. "1.5 GB used of 5 GB limit (30.0%)"; "1.5 GB used" when Unlimited. */
  label: string
}

/**
 * Resolve everything the UI needs to render usage against the user's soft cap:
 * the used/cap ratio, a clamped bar percentage, an ok/warning/over status and a
 * human-readable label. A cap of 0 (or any non-finite / negative value) means
 * Unlimited: status is always 'ok' and the label omits the limit.
 */
export function resolveStorageCapState(usedBytes: number, capBytes: number): StorageCapState {
  const used = Number.isFinite(usedBytes) && usedBytes > 0 ? usedBytes : 0

  if (!Number.isFinite(capBytes) || capBytes <= 0) {
    return {
      ratio: 0,
      percent: 0,
      status: 'ok',
      label: `${formatBytes(used)} used`,
    }
  }

  const ratio = used / capBytes
  const percent = Math.min(100, Math.max(0, ratio * 100))
  const status: StorageCapStatus = ratio > 1 ? 'over' : ratio >= STORAGE_CAP_WARNING_THRESHOLD ? 'warning' : 'ok'

  return {
    ratio,
    percent,
    status,
    label: `${formatBytes(used)} used of ${formatBytes(capBytes)} limit (${(ratio * 100).toFixed(1)}%)`,
  }
}
