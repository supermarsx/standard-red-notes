import 'reflect-metadata'

import { getMetadataArgsStorage } from 'typeorm'

import { TypeORMEmergencyAccessInvitation } from '../Infra/TypeORM/TypeORMEmergencyAccessInvitation'
import { Permission } from './Permission/Permission'
import { RevokedSession } from './Session/RevokedSession'
import { OfflineUserSubscription } from './Subscription/OfflineUserSubscription'
import { Role } from './Role/Role'
import { User } from './User/User'

const expectRelation = (
  owner: object,
  propertyName: string,
  expectedTarget: object,
  expectedInverseProperty?: string,
): void => {
  const relation = getMetadataArgsStorage().relations.find(
    (candidate) => candidate.target === owner && candidate.propertyName === propertyName,
  )

  expect(relation).toBeDefined()
  expect(typeof relation?.type).toBe('function')
  expect((relation?.type as () => object)()).toBe(expectedTarget)

  if (expectedInverseProperty !== undefined) {
    expect(typeof relation?.inverseSideProperty).toBe('function')
    const propertyProbe = new Proxy<Record<string, string>>({}, { get: (_target, property) => String(property) })
    expect((relation?.inverseSideProperty as (object: Record<string, string>) => string)(propertyProbe)).toBe(
      expectedInverseProperty,
    )
  }
}

describe('auth entity relations', () => {
  it('maps users to revoked sessions, roles, and both emergency-access directions', () => {
    expectRelation(User, 'revokedSessions', RevokedSession, 'user')
    expectRelation(User, 'roles', Role)
    expectRelation(User, 'emergencyAccessInvitationsCreated', TypeORMEmergencyAccessInvitation, 'grantor')
    expectRelation(User, 'emergencyAccessInvitationsReceived', TypeORMEmergencyAccessInvitation, 'grantee')
  })

  it('maps the inverse revoked-session relation back to its user', () => {
    expectRelation(RevokedSession, 'user', User, 'revokedSessions')
  })

  it('maps roles to users, permissions, and offline subscriptions', () => {
    expectRelation(Role, 'users', User)
    expectRelation(Role, 'permissions', Permission)
    expectRelation(Role, 'offlineUserSubscriptions', OfflineUserSubscription)
  })

  it('maps permission and offline-subscription role collections', () => {
    expectRelation(Permission, 'roles', Role)
    expectRelation(OfflineUserSubscription, 'roles', Role)
  })
})
