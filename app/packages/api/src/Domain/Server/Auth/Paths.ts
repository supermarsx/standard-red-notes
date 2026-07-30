const SessionPaths = {
  refreshSession: '/v1/sessions/refresh',
}

const RecoveryPaths = {
  accountRecoveryLookup: '/v1/account-recovery/lookup',
  generateRecoveryCodes: '/v1/recovery/codes',
  recoveryKeyParams: '/v1/recovery/login-params',
  signInWithRecoveryCodes: '/v1/recovery/login',
}

export const Paths = {
  v1: {
    ...SessionPaths,
    ...RecoveryPaths,
  },
}
