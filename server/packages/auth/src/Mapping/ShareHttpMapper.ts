import { MapperInterface } from '@standardnotes/domain-core'

import { Share } from '../Domain/Share/Share'
import { ShareHttpProjection } from '../Infra/Http/Projection/ShareHttpProjection'

export class ShareHttpMapper implements MapperInterface<Share, ShareHttpProjection> {
  toDomain(_projection: ShareHttpProjection): Share {
    throw new Error('Not implemented yet.')
  }

  toProjection(domain: Share): ShareHttpProjection {
    // List metadata only. NEVER include the encrypted payload in the list
    // projection; the ciphertext is served exclusively from the public GET route.
    return {
      uuid: domain.id.toString(),
      type: domain.props.type,
      nickname: domain.props.nickname,
      createdAt: domain.props.createdAt.toISOString(),
      revoked: domain.props.revoked,
      oneTimeView: domain.props.oneTimeView,
      viewExpiresMinutes: domain.props.viewExpiresMinutes,
      firstOpenedAt: domain.props.firstOpenedAt === null ? null : domain.props.firstOpenedAt.toISOString(),
    }
  }
}
