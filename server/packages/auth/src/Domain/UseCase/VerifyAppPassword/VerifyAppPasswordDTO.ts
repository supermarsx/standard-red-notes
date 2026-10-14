export interface VerifyAppPasswordDTO {
  email: string
  resolvedUserUuid?: string | null
  appPassword: string
}
