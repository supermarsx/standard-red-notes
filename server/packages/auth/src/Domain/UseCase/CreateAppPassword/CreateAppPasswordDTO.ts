export interface CreateAppPasswordDTO {
  userUuid: string
  label: string
  // Optional absolute expiry. When provided it must be in the future; the app
  // password stops satisfying the sign-in challenge once this instant passes.
  expiresAt?: Date | null
}
