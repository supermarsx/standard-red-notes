export const SECURITY_STEP_UP_UPDATE_REQUIRED_MESSAGE = 'Please update your application to the latest version.'

export const SECURITY_STEP_UP_VALIDATION_FAILED_MESSAGE = 'Unable to validate the security code. Please try again.'

export function supportsPasswordStepUp(authTokenVersion: number | undefined): boolean {
  return authTokenVersion !== undefined && authTokenVersion >= 2
}

export function supportsTotpStepUp(authTokenVersion: number | undefined): boolean {
  return authTokenVersion !== undefined && authTokenVersion >= 3
}
