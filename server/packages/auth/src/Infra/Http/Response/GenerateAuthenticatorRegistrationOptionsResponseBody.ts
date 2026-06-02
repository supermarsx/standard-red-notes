import { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/server'

export interface GenerateAuthenticatorRegistrationOptionsResponseBody {
  options: PublicKeyCredentialCreationOptionsJSON
}
