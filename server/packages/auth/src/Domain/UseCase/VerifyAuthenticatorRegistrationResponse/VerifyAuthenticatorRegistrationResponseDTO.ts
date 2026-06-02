import { RegistrationResponseJSON } from '@simplewebauthn/server'
export interface VerifyAuthenticatorRegistrationResponseDTO {
  userUuid: string
  attestationResponse: RegistrationResponseJSON
}
