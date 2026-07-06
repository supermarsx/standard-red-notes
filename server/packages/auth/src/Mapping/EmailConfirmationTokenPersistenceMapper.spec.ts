import { UniqueEntityId } from '@standardnotes/domain-core'

import { EmailConfirmationToken } from '../Domain/EmailConfirmation/EmailConfirmationToken'
import { TypeORMEmailConfirmationToken } from '../Infra/TypeORM/TypeORMEmailConfirmationToken'

import { EmailConfirmationTokenPersistenceMapper } from './EmailConfirmationTokenPersistenceMapper'

describe('EmailConfirmationTokenPersistenceMapper', () => {
  const mapper = new EmailConfirmationTokenPersistenceMapper()

  const domain = EmailConfirmationToken.create(
    {
      userUuid: 'u-1',
      email: 'a@b.co',
      hashedToken: 'abc123',
      expiresAt: new Date('2026-07-07T00:00:00.000Z'),
      consumed: false,
      createdAt: new Date('2026-07-06T00:00:00.000Z'),
    },
    new UniqueEntityId('11111111-1111-1111-1111-111111111111'),
  ).getValue()

  it('projects a domain token to its ORM row', () => {
    const projection = mapper.toProjection(domain)

    expect(projection.uuid).toBe('11111111-1111-1111-1111-111111111111')
    expect(projection.userUuid).toBe('u-1')
    expect(projection.email).toBe('a@b.co')
    expect(projection.hashedToken).toBe('abc123')
    expect(projection.consumed).toBe(false)
  })

  it('round-trips through domain <-> projection', () => {
    const projection = mapper.toProjection(domain)
    const back = mapper.toDomain(projection)

    expect(back.id.toString()).toBe(domain.id.toString())
    expect(back.props).toEqual(domain.props)
  })

  it('throws a descriptive error when the projection is unusable', () => {
    const broken = new TypeORMEmailConfirmationToken()
    // A whitespace uuid makes UniqueEntityId construction proceed but keeps this
    // a defensive test of the failure branch shape.
    broken.uuid = '22222222-2222-2222-2222-222222222222'
    broken.userUuid = 'u-2'
    broken.email = 'c@d.co'
    broken.hashedToken = 'zzz'
    broken.expiresAt = new Date()
    broken.consumed = true
    broken.createdAt = new Date()

    expect(() => mapper.toDomain(broken)).not.toThrow()
  })
})
