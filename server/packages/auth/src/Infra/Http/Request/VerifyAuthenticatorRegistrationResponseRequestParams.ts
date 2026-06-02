import { RegistrationResponseJSON } from '@simplewebauthn/server'

export interface VerifyAuthenticatorRegistrationResponseRequestParams {
  userUuid: string
  attestationResponse: RegistrationResponseJSON
}
