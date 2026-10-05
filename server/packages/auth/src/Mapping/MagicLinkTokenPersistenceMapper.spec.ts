import { UniqueEntityId } from '@standardnotes/domain-core'

import { MagicLinkToken } from '../Domain/MagicLink/MagicLinkToken'
import { TypeORMMagicLinkToken } from '../Infra/TypeORM/TypeORMMagicLinkToken'

import { MagicLinkTokenPersistenceMapper } from './MagicLinkTokenPersistenceMapper'

/**
 * Standard Red Notes: the per-code attempt counter is only a brake if it crosses
 * the persistence boundary. If the mapper drops `failedAttempts` in either
 * direction, every wrong guess is forgotten the moment the request ends — the
 * counter would increment in memory, the use-case unit tests would all still
 * pass, and the cap would be worth nothing against a real attacker, who makes
 * each guess in a new request. Hence a round trip, in both directions, with a
 * NON-ZERO value (a zero would survive a dropped field by accident).
 *
 * `/Mapping/` is in this package's `coveragePathIgnorePatterns`, so no coverage
 * gate would ever have noticed the gap either.
 */
describe('MagicLinkTokenPersistenceMapper', () => {
  const mapper = new MagicLinkTokenPersistenceMapper()

  const domain = (failedAttempts: number): MagicLinkToken =>
    MagicLinkToken.create(
      {
        userIdentifier: 'test@test.te',
        code: '123456',
        expiresAt: new Date('2026-10-05T12:15:00.000Z'),
        consumed: false,
        failedAttempts,
        createdAt: new Date('2026-10-05T12:00:00.000Z'),
      },
      new UniqueEntityId('11111111-1111-1111-1111-111111111111'),
    ).getValue()

  it('projects the attempt counter onto the ORM row', () => {
    const projection = mapper.toProjection(domain(3))

    expect(projection.uuid).toEqual('11111111-1111-1111-1111-111111111111')
    expect(projection.userIdentifier).toEqual('test@test.te')
    expect(projection.code).toEqual('123456')
    expect(projection.consumed).toBe(false)
    expect(projection.failedAttempts).toEqual(3)
  })

  it('reads the attempt counter back off the ORM row', () => {
    const projection = new TypeORMMagicLinkToken()
    projection.uuid = '22222222-2222-2222-2222-222222222222'
    projection.userIdentifier = 'test@test.te'
    projection.code = '654321'
    projection.expiresAt = new Date('2026-10-05T12:15:00.000Z')
    projection.consumed = false
    projection.failedAttempts = MagicLinkToken.MAX_FAILED_ATTEMPTS
    projection.createdAt = new Date('2026-10-05T12:00:00.000Z')

    const back = mapper.toDomain(projection)

    expect(back.props.failedAttempts).toEqual(MagicLinkToken.MAX_FAILED_ATTEMPTS)
    // The state the stored number actually encodes, not just the number.
    expect(back.hasExhaustedAttempts()).toBe(true)
  })

  it('round-trips a charged token without losing the count', () => {
    const charged = domain(0)
    charged.registerFailedAttempt()
    charged.registerFailedAttempt()
    expect(charged.props.failedAttempts).toEqual(2)

    const back = mapper.toDomain(mapper.toProjection(charged))

    expect(back.id.toString()).toEqual(charged.id.toString())
    expect(back.props).toEqual(charged.props)
    expect(back.props.failedAttempts).toEqual(2)
  })
})
