import { MapperInterface } from '@standardnotes/domain-core'

import { AppPassword } from '../Domain/AppPassword/AppPassword'
import { AppPasswordHttpProjection } from '../Infra/Http/Projection/AppPasswordHttpProjection'

export class AppPasswordHttpMapper implements MapperInterface<AppPassword, AppPasswordHttpProjection> {
  toDomain(_projection: AppPasswordHttpProjection): AppPassword {
    throw new Error('Not implemented yet.')
  }

  toProjection(domain: AppPassword): AppPasswordHttpProjection {
    // Never include the secret or its hash in the HTTP projection.
    return {
      uuid: domain.id.toString(),
      label: domain.props.label,
      createdAt: domain.props.createdAt.toISOString(),
      lastUsedAt: domain.props.lastUsedAt ? domain.props.lastUsedAt.toISOString() : null,
      expiresAt: domain.props.expiresAt ? domain.props.expiresAt.toISOString() : null,
      revokedAt: domain.props.revokedAt ? domain.props.revokedAt.toISOString() : null,
      expired: domain.isExpired(),
      revoked: domain.isRevoked(),
    }
  }
}
