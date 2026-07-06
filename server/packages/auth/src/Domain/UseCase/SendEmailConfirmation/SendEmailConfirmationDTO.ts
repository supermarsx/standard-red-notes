import { RegistrationConfig } from '../../Registration/RegistrationConfig'

export interface SendEmailConfirmationDTO {
  userUuid: string
  email: string
  /** The already-resolved registration policy (carries the templates + base URL). */
  registrationConfig: RegistrationConfig
}
