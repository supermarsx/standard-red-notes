import type { SessionListEntry } from '@standardnotes/responses'

export const SESSION_ACTIVITY_WINDOW_MS = 120_000

type Activity = { last_seen_at?: string | null; active?: boolean; activity_checked_at?: string }

export function formatSessionDate(value?: string | null): string {
  const date = value ? new Date(value) : undefined
  return date && Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Unavailable'
}

/** Age the server snapshot with elapsed local time, never compare two clocks. */
export function presentActivity(activity: Activity, now: number, receivedAt = now) {
  const seen = activity.last_seen_at ? Date.parse(activity.last_seen_at) : NaN
  const checked = activity.activity_checked_at ? Date.parse(activity.activity_checked_at) : NaN
  const available = Number.isFinite(seen) && Number.isFinite(checked)
  const age = available ? Math.max(0, checked - seen) + Math.max(0, now - receivedAt) : undefined
  const active = activity.active === true && age !== undefined && age <= SESSION_ACTIVITY_WINDOW_MS
  const lastSeenText =
    activity.last_seen_at === null
      ? 'Not yet observed'
      : !available
        ? 'Activity unavailable'
        : age! < 60_000
          ? 'Just now'
          : age! < 3_600_000
            ? `${Math.floor(age! / 60_000)} minutes ago`
            : formatSessionDate(activity.last_seen_at)
  return {
    active,
    statusLabel: !available ? 'Activity unavailable' : active ? 'Active recently' : 'Inactive',
    lastSeenText,
  }
}

export function presentSessionActivity(session: SessionListEntry, now: number, receivedAt = now) {
  return presentActivity(session, now, receivedAt)
}

export function countSessionDevices(sessions: SessionListEntry[]): number {
  return new Set(sessions.flatMap((session) => session.devices?.map((device) => device.device_id) ?? [])).size
}

export function sessionDeviceLabel(session: SessionListEntry): string {
  return session.device_info?.trim() || 'Unknown device'
}
