export interface AppPasswordHttpProjection {
  uuid: string
  label: string
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
  // Convenience flags derived server-side so clients don't have to reason about
  // clock skew when rendering status. Never includes the secret or its hash.
  expired: boolean
  revoked: boolean
}
