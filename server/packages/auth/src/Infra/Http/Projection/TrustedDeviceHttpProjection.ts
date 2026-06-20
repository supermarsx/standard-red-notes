export interface TrustedDeviceHttpProjection {
  uuid: string
  label: string
  createdAt: number
  lastUsedAt: number | null
  expiresAt: number
}
