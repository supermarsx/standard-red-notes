export type VerifyMFADTO = {
  email: string
  /** Server-resolved account; null deliberately means no matching workspace. */
  resolvedUserUuid?: string | null
  requestParams: Record<string, unknown>
  preventOTPFromFurtherUsage: boolean
}
