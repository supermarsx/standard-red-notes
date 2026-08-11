import { getAccountPasskeyRegistrationUnavailableReason, getWebAuthnUnavailableReason } from './passkeyAvailability'

describe('passkey availability', () => {
  it('explains insecure and unsupported WebAuthn runtimes', () => {
    expect(getWebAuthnUnavailableReason(null)).toContain('loaded')
    expect(getWebAuthnUnavailableReason({ isSecureContext: false, PublicKeyCredential: {} })).toContain('HTTPS')
    expect(getWebAuthnUnavailableReason({ isSecureContext: true })).toContain('does not provide WebAuthn')
    expect(getWebAuthnUnavailableReason({ isSecureContext: true, PublicKeyCredential: {} })).toBeUndefined()
  })

  it.each([
    [{ isSignedIn: false, isFullU2FClient: true, is2FAEnabled: true }, 'Sign in'],
    [{ isSignedIn: true, isFullU2FClient: false, is2FAEnabled: true }, 'web app'],
    [{ isSignedIn: true, isFullU2FClient: true, is2FAEnabled: false }, 'two-factor authentication'],
  ])('explains the account registration blocker', (state, expectedText) => {
    expect(
      getAccountPasskeyRegistrationUnavailableReason({
        ...state,
        webAuthnUnavailableReason: undefined,
      }),
    ).toContain(expectedText)
  })

  it('surfaces a browser prerequisite before the 2FA prerequisite', () => {
    expect(
      getAccountPasskeyRegistrationUnavailableReason({
        isSignedIn: true,
        isFullU2FClient: true,
        is2FAEnabled: false,
        webAuthnUnavailableReason: 'Secure context required.',
      }),
    ).toBe('Secure context required.')
  })

  it('allows account registration only when every prerequisite is met', () => {
    expect(
      getAccountPasskeyRegistrationUnavailableReason({
        isSignedIn: true,
        isFullU2FClient: true,
        is2FAEnabled: true,
        webAuthnUnavailableReason: undefined,
      }),
    ).toBeUndefined()
  })
})
