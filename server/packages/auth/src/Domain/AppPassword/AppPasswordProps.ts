export interface AppPasswordProps {
  userUuid: string
  label: string
  hashedPassword: string
  createdAt: Date
  lastUsedAt: Date | null
  // Optional expiry. When set and in the past, the app password no longer
  // satisfies the sign-in challenge (treated as a no-match by VerifyAppPassword).
  expiresAt: Date | null
  // Soft-revoke audit trail. When set, the app password is permanently rejected
  // by VerifyAppPassword but the row is retained so there is a record of it.
  revokedAt: Date | null
}
