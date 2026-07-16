import { UniqueEntityId } from '@standardnotes/domain-core'

import { EmailConfirmationToken } from './EmailConfirmationToken'
import { generateRawEmailConfirmationToken, hashEmailConfirmationToken } from './hashEmailConfirmationToken'

describe('EmailConfirmationToken + hashing', () => {
  const NOW = new Date('2026-07-06T00:00:00.000Z')

  const make = (over: { consumed?: boolean; expiresAt?: Date } = {}) =>
    EmailConfirmationToken.create(
      {
        userUuid: 'u-1',
        email: 'a@b.co',
        hashedToken: 'deadbeef',
        expiresAt: over.expiresAt ?? new Date(NOW.getTime() + 1000),
        consumed: over.consumed ?? false,
        createdAt: NOW,
      },
      new UniqueEntityId('11111111-1111-1111-1111-111111111111'),
    ).getValue()

  it('isExpired reflects the expiry boundary', () => {
    expect(make({ expiresAt: new Date(NOW.getTime() - 1) }).isExpired(NOW)).toBe(true)
    expect(make({ expiresAt: new Date(NOW.getTime() + 1) }).isExpired(NOW)).toBe(false)
  })

  it('isConsumed + isRedeemable combine expiry and consumption', () => {
    expect(make().isRedeemable(NOW)).toBe(true)
    expect(make({ consumed: true }).isConsumed()).toBe(true)
    expect(make({ consumed: true }).isRedeemable(NOW)).toBe(false)
    expect(make({ expiresAt: new Date(NOW.getTime() - 1) }).isRedeemable(NOW)).toBe(false)
  })

  it('hashEmailConfirmationToken is a deterministic sha256 hex digest', () => {
    const hash = hashEmailConfirmationToken('abc')
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
    expect(hashEmailConfirmationToken('abc')).toBe(hash)
    expect(hashEmailConfirmationToken('abd')).not.toBe(hash)
  })

  it('generateRawEmailConfirmationToken produces a unique 64-char hex token', () => {
    const a = generateRawEmailConfirmationToken()
    const b = generateRawEmailConfirmationToken()
    expect(a).toMatch(/^[a-f0-9]{64}$/)
    expect(a).not.toBe(b)
  })
})
