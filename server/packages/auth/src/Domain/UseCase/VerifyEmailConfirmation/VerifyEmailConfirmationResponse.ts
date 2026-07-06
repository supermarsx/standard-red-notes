export interface VerifyEmailConfirmationResponse {
  success: boolean
  /** True when the link was valid but the account was already confirmed. */
  alreadyConfirmed?: boolean
  /** User-facing error when success is false (invalid / expired / used). */
  errorMessage?: string
}
