import { MapperInterface, Timestamps, UniqueEntityId, Uuid } from '@standardnotes/domain-core'
import { SubscriptionSetting } from '../../Domain/Setting/SubscriptionSetting'
import { TypeORMSubscriptionSetting } from '../../Infra/TypeORM/TypeORMSubscriptionSetting'

export class SubscriptionSettingPersistenceMapper implements MapperInterface<
  SubscriptionSetting,
  TypeORMSubscriptionSetting
> {
  toDomain(projection: TypeORMSubscriptionSetting): SubscriptionSetting {
    const timestampsOrError = Timestamps.create(projection.createdAt, projection.updatedAt)
    if (timestampsOrError.isFailed()) {
      throw new Error(`Failed to create subscription setting from projection: ${timestampsOrError.getError()}`)
    }
    const timestamps = timestampsOrError.getValue()

    const userSubscriptionUuidOrError = Uuid.create(projection.userSubscriptionUuid)
    if (userSubscriptionUuidOrError.isFailed()) {
      throw new Error(
        `Failed to create subscription setting from projection: ${userSubscriptionUuidOrError.getError()}`,
      )
    }
    const userSubscriptionUuid = userSubscriptionUuidOrError.getValue()

    const subscriptionSettingOrError = SubscriptionSetting.create(
      {
        name: projection.name,
        value: projection.value,
        serverEncryptionVersion: projection.serverEncryptionVersion,
        // The `sensitive` column is a tinyint(1): TypeORM hydrates it as the
        // NUMBER 0/1, not a boolean. Coerce so `props.sensitive` is a real
        // boolean (mirrors SettingPersistenceMapper) — otherwise a numeric 1
        // leaks into HTTP projections and `=== true` comparisons silently fail.
        sensitive: !!projection.sensitive,
        userSubscriptionUuid,
        timestamps,
      },
      new UniqueEntityId(projection.uuid),
    )
    if (subscriptionSettingOrError.isFailed()) {
      throw new Error(`Failed to create subscription setting from projection: ${subscriptionSettingOrError.getError()}`)
    }
    const subscriptionSetting = subscriptionSettingOrError.getValue()

    return subscriptionSetting
  }

  toProjection(domain: SubscriptionSetting): TypeORMSubscriptionSetting {
    const projection = new TypeORMSubscriptionSetting()

    projection.uuid = domain.id.toString()
    projection.name = domain.props.name
    projection.value = domain.props.value
    projection.serverEncryptionVersion = domain.props.serverEncryptionVersion
    projection.createdAt = domain.props.timestamps.createdAt
    projection.updatedAt = domain.props.timestamps.updatedAt
    projection.userSubscriptionUuid = domain.props.userSubscriptionUuid.value
    // Persist the `sensitive` flag (mirrors SettingPersistenceMapper). Without
    // this the column was never written and every subscription setting was saved
    // with the DB default (0/false), silently dropping the domain flag.
    projection.sensitive = !!domain.props.sensitive

    return projection
  }
}
