export type SessionDeviceObservation = {
  device_id: string
  last_seen_at: string
  active: boolean
}

export type SessionListEntry = {
  uuid: string
  current: boolean
  api_version: string
  created_at: string
  updated_at: string
  device_info: string
  ip_address?: string | null
  /** Authenticated activity, independent of session metadata/token updates. */
  last_seen_at?: string | null
  activity_checked_at?: string
  active?: boolean
  refresh_expiration?: string
  devices?: SessionDeviceObservation[]
}
