import { AuthenticationResponseJSON } from '@simplewebauthn/server'

export interface VerifyAuthenticatorAuthenticationResponseDTO {
  userUuid: string
  authenticatorResponse: AuthenticationResponseJSON
}
