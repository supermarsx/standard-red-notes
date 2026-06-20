import { MapperInterface } from '@standardnotes/domain-core'

import { TrustedDevice } from '../Domain/TrustedDevice/TrustedDevice'
import { TrustedDeviceHttpProjection } from '../Infra/Http/Projection/TrustedDeviceHttpProjection'

export class TrustedDeviceHttpMapper implements MapperInterface<TrustedDevice, TrustedDeviceHttpProjection> {
  toDomain(_projection: TrustedDeviceHttpProjection): TrustedDevice {
    throw new Error('Not implemented yet.')
  }

  toProjection(domain: TrustedDevice): TrustedDeviceHttpProjection {
    // Metadata only. NEVER include the token hash; the plaintext token is held
    // only by the client and the hash never leaves the server.
    return {
      uuid: domain.id.toString(),
      label: domain.props.label,
      createdAt: domain.props.createdAt.getTime(),
      lastUsedAt: domain.props.lastUsedAt === null ? null : domain.props.lastUsedAt.getTime(),
      expiresAt: domain.props.expiresAt.getTime(),
    }
  }
}
