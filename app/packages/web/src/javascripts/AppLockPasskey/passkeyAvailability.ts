export type WebAuthnRuntime = {
  isSecureContext?: boolean
  PublicKeyCredential?: unknown
}

/**
 * Return the concrete browser prerequisite that prevents a WebAuthn ceremony.
 * `isSecureContext` may be absent in a test/legacy runtime; modern browsers
 * expose an explicit false value on insecure origins.
 */
export function getWebAuthnUnavailableReason(
  runtime: WebAuthnRuntime | null = typeof window === 'undefined' ? null : window,
): string | undefined {
  if (runtime === null) {
    return 'Passkey registration is available only after the app has loaded in a browser or desktop window.'
  }

  if (runtime.isSecureContext === false) {
    return 'Passkeys require a secure HTTPS connection (or localhost). Open this server over HTTPS and try again.'
  }

  if (runtime.PublicKeyCredential === undefined) {
    return 'This browser or device does not provide WebAuthn passkey support. Try a current browser with passkeys enabled.'
  }

  return undefined
}

export function getAccountPasskeyRegistrationUnavailableReason({
  isSignedIn,
  isFullU2FClient,
  is2FAEnabled,
  webAuthnUnavailableReason,
}: {
  isSignedIn: boolean
  isFullU2FClient: boolean
  is2FAEnabled: boolean
  webAuthnUnavailableReason: string | undefined
}): string | undefined {
  if (!isSignedIn) {
    return 'Sign in or register for an account before adding a passkey or security key.'
  }

  if (!isFullU2FClient) {
    return 'Account passkeys and security keys can currently be added only from the web app.'
  }

  if (webAuthnUnavailableReason) {
    return webAuthnUnavailableReason
  }

  if (!is2FAEnabled) {
    return 'Enable two-factor authentication before adding a passkey or security key.'
  }

  return undefined
}
