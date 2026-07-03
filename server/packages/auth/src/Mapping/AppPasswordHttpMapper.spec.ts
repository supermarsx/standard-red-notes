import { UniqueEntityId } from '@standardnotes/domain-core'

import { AppPassword } from '../Domain/AppPassword/AppPassword'

import { AppPasswordHttpMapper } from './AppPasswordHttpMapper'

describe('AppPasswordHttpMapper', () => {
  const createMapper = () => new AppPasswordHttpMapper()

  const createAppPassword = (overrides: { expiresAt?: Date | null; revokedAt?: Date | null } = {}): AppPassword =>
    AppPassword.create(
      {
        userUuid: '00000000-0000-0000-0000-000000000000',
        label: 'MCP Bridge',
        hashedPassword: 'super-secret-bcrypt-hash-value',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        lastUsedAt: new Date('2026-02-01T00:00:00.000Z'),
        expiresAt: overrides.expiresAt ?? null,
        revokedAt: overrides.revokedAt ?? null,
      },
      new UniqueEntityId('11111111-1111-1111-1111-111111111111'),
    ).getValue()

  it('should never leak the secret or its hash in the projection', () => {
    const projection = createMapper().toProjection(createAppPassword())

    const serialized = JSON.stringify(projection)
    expect(serialized).not.toContain('super-secret-bcrypt-hash-value')
    expect(Object.prototype.hasOwnProperty.call(projection, 'hashedPassword')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(projection, 'password')).toBe(false)
  })

  it('should surface expiry and revocation metadata', () => {
    const expiresAt = new Date('2026-06-01T00:00:00.000Z')
    const revokedAt = new Date('2026-03-01T00:00:00.000Z')
    const projection = createMapper().toProjection(createAppPassword({ expiresAt, revokedAt }))

    expect(projection.expiresAt).toEqual(expiresAt.toISOString())
    expect(projection.revokedAt).toEqual(revokedAt.toISOString())
    expect(projection.revoked).toBe(true)
    expect(projection.expired).toBe(true)
  })

  it('should report an active (never-expiring, not-revoked) app password', () => {
    const projection = createMapper().toProjection(createAppPassword())

    expect(projection.expiresAt).toBeNull()
    expect(projection.revokedAt).toBeNull()
    expect(projection.revoked).toBe(false)
    expect(projection.expired).toBe(false)
  })

  it('should mark a future expiry as not yet expired', () => {
    const projection = createMapper().toProjection(
      createAppPassword({ expiresAt: new Date(Date.now() + 60 * 60 * 1000) }),
    )

    expect(projection.expired).toBe(false)
  })
})
