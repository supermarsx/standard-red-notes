import { Timestamps, Uuid } from '@standardnotes/domain-core'

import { SubscriptionSetting } from '../../Domain/Setting/SubscriptionSetting'
import { TypeORMSubscriptionSetting } from '../../Infra/TypeORM/TypeORMSubscriptionSetting'

import { SubscriptionSettingPersistenceMapper } from './SubscriptionSettingPersistenceMapper'

describe('SubscriptionSettingPersistenceMapper', () => {
  const createMapper = () => new SubscriptionSettingPersistenceMapper()

  const buildProjection = (sensitive: unknown): TypeORMSubscriptionSetting => {
    const projection = new TypeORMSubscriptionSetting()
    projection.uuid = '00000000-0000-0000-0000-000000000000'
    projection.name = 'MUTE_FAILED_BACKUPS_EMAILS'
    projection.value = 'value'
    projection.serverEncryptionVersion = 1
    projection.createdAt = 123
    projection.updatedAt = 123
    projection.userSubscriptionUuid = '11111111-1111-1111-1111-111111111111'
    projection.sensitive = sensitive as boolean

    return projection
  }

  it('hydrates the tinyint `sensitive` column into a real boolean (number 1 -> true)', () => {
    // TypeORM hydrates a tinyint(1) column as the NUMBER 0/1. Without coercion
    // `props.sensitive` would be a number and `=== true` comparisons / HTTP
    // projections would silently misbehave.
    const domain = createMapper().toDomain(buildProjection(1))

    expect(domain.props.sensitive).toBe(true)
  })

  it('hydrates numeric 0 into boolean false', () => {
    const domain = createMapper().toDomain(buildProjection(0))

    expect(domain.props.sensitive).toBe(false)
  })

  it('persists the `sensitive` flag onto the projection (not dropped to the DB default)', () => {
    const timestamps = Timestamps.create(123, 123).getValue()
    const userSubscriptionUuid = Uuid.create('11111111-1111-1111-1111-111111111111').getValue()

    const domain = SubscriptionSetting.create({
      name: 'MUTE_FAILED_BACKUPS_EMAILS',
      value: 'value',
      serverEncryptionVersion: 1,
      sensitive: true,
      timestamps,
      userSubscriptionUuid,
    }).getValue()

    const projection = createMapper().toProjection(domain)

    expect(projection.sensitive).toBe(true)
  })
})
