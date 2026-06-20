import { UniqueEntityId, Uuid } from '@standardnotes/domain-core'

import { McpToken } from './McpToken'

export interface McpTokenRepositoryInterface {
  findByUserUuid(userUuid: Uuid): Promise<McpToken[]>
  findById(id: UniqueEntityId): Promise<McpToken | null>
  save(mcpToken: McpToken): Promise<void>
  updateLastUsedAt(id: UniqueEntityId, lastUsedAt: Date): Promise<void>
  remove(mcpToken: McpToken): Promise<void>
  removeByUserUuid(userUuid: Uuid): Promise<void>
}
