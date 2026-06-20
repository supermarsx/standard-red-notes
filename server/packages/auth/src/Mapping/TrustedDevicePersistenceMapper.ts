import { MapperInterface, UniqueEntityId } from '@standardnotes/domain-core'

import { TrustedDevice } from '../Domain/TrustedDevice/TrustedDevice'
import { TypeORMTrustedDevice } from '../Infra/TypeORM/TypeORMTrustedDevice'

export class TrustedDevicePersistenceMapper implements MapperInterface<TrustedDevice, TypeORMTrustedDevice> {
  toDomain(projection: TypeORMTrustedDevice): TrustedDevice {
    const deviceOrError = TrustedDevice.create(
      {
        userUuid: projection.userUuid,
        hashedToken: projection.hashedToken,
        label: projection.label,
        createdAt: new Date(Number(projection.createdAt)),
        lastUsedAt: projection.lastUsedAt === null ? null : new Date(Number(projection.lastUsedAt)),
        expiresAt: new Date(Number(projection.expiresAt)),
      },
      new UniqueEntityId(projection.uuid),
    )
    if (deviceOrError.isFailed()) {
      throw new Error(`Failed to create trusted device from projection: ${deviceOrError.getError()}`)
    }

    return deviceOrError.getValue()
  }

  toProjection(domain: TrustedDevice): TypeORMTrustedDevice {
    const typeorm = new TypeORMTrustedDevice()

    typeorm.uuid = domain.id.toString()
    typeorm.userUuid = domain.props.userUuid
    typeorm.hashedToken = domain.props.hashedToken
    typeorm.label = domain.props.label
    typeorm.createdAt = domain.props.createdAt.getTime()
    typeorm.lastUsedAt = domain.props.lastUsedAt === null ? null : domain.props.lastUsedAt.getTime()
    typeorm.expiresAt = domain.props.expiresAt.getTime()

    return typeorm
  }
}
