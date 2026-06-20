import { MapperInterface } from '@standardnotes/domain-core'

import { McpToken } from '../Domain/McpToken/McpToken'
import { McpTokenHttpProjection } from '../Infra/Http/Projection/McpTokenHttpProjection'

export class McpTokenHttpMapper implements MapperInterface<McpToken, McpTokenHttpProjection> {
  toDomain(_projection: McpTokenHttpProjection): McpToken {
    throw new Error('Not implemented yet.')
  }

  toProjection(domain: McpToken): McpTokenHttpProjection {
    // Never include the plaintext secret, its hash, or the wrapped key material
    // in the list projection. Only metadata.
    return {
      uuid: domain.id.toString(),
      label: domain.props.label,
      scope: domain.props.scope,
      scopeTagUuids: domain.props.scopeTagUuids,
      createdAt: domain.props.createdAt.toISOString(),
      lastUsedAt: domain.props.lastUsedAt ? domain.props.lastUsedAt.toISOString() : null,
      expiresAt: domain.props.expiresAt ? domain.props.expiresAt.toISOString() : null,
    }
  }
}
