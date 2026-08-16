import {
  captureChecklistSessionPrincipal,
  checklistEncryptionIdentityMatches,
  checklistSessionPrincipalMatches,
} from './checklistSessionPrincipal'

describe('checklist session principal', () => {
  it('accepts replacement user objects for the same stable account UUID', () => {
    const first = captureChecklistSessionPrincipal({
      isSignedIn: () => true,
      getUser: () => ({ uuid: 'same-account' }) as never,
    })
    const replacement = captureChecklistSessionPrincipal({
      isSignedIn: () => true,
      getUser: () => ({ uuid: 'same-account' }) as never,
    })

    expect(checklistSessionPrincipalMatches(first, replacement)).toBe(true)
  })

  it('rejects a different account, sign-out, and incomplete signed-in identity', () => {
    const expected = { valid: true, signedIn: true, userUuid: 'expected-account' }

    expect(checklistSessionPrincipalMatches(expected, { valid: true, signedIn: true, userUuid: 'other-account' })).toBe(
      false,
    )
    expect(checklistSessionPrincipalMatches(expected, { valid: true, signedIn: false })).toBe(false)
    expect(checklistSessionPrincipalMatches(expected, { valid: false, signedIn: true })).toBe(false)
  })

  it('accepts only a same-account encryption identity when the User projection object is replaced', () => {
    const expected = {
      noteUuid: 'note-1',
      userUuid: 'user-1',
      sessionUser: { uuid: 'user-1' },
      sourceId: 'account-root-key-1',
      keySystemIdentifier: null,
      sharedVaultUuid: null,
    }
    const replacement = {
      ...expected,
      sessionUser: { uuid: 'user-1' },
    }

    expect(checklistEncryptionIdentityMatches(expected, replacement)).toBe(true)
    expect(checklistEncryptionIdentityMatches(expected, { ...replacement, userUuid: 'user-2' })).toBe(false)
    expect(checklistEncryptionIdentityMatches(expected, { ...replacement, sourceId: 'rotated-root-key' })).toBe(false)
    expect(checklistEncryptionIdentityMatches(expected, undefined)).toBe(false)
  })
})
