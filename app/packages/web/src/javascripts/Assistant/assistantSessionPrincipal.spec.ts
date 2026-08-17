import { assistantSessionPrincipalMatches, captureAssistantSessionPrincipal } from './assistantSessionPrincipal'

describe('assistant session principal', () => {
  it('survives replacement User objects for the same account', () => {
    const first = captureAssistantSessionPrincipal({
      isSignedIn: () => true,
      getUser: () => ({ uuid: 'same-account' }) as never,
    })
    const refreshed = captureAssistantSessionPrincipal({
      isSignedIn: () => true,
      getUser: () => ({ uuid: 'same-account' }) as never,
    })
    expect(assistantSessionPrincipalMatches(first, refreshed)).toBe(true)
  })

  it('fails closed for another account, sign-out, or missing signed-in identity', () => {
    const expected = { valid: true, signedIn: true, userUuid: 'account-a' }
    expect(assistantSessionPrincipalMatches(expected, { valid: true, signedIn: true, userUuid: 'account-b' })).toBe(
      false,
    )
    expect(assistantSessionPrincipalMatches(expected, { valid: true, signedIn: false })).toBe(false)
    expect(assistantSessionPrincipalMatches(expected, { valid: false, signedIn: true })).toBe(false)
  })
})
