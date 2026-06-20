import { MapperInterface, UniqueEntityId, Uuid } from '@standardnotes/domain-core'
import { Repository } from 'typeorm'

import { McpToken } from '../../Domain/McpToken/McpToken'
import { McpTokenRepositoryInterface } from '../../Domain/McpToken/McpTokenRepositoryInterface'
import { TypeORMMcpToken } from './TypeORMMcpToken'

export class TypeORMMcpTokenRepository implements McpTokenRepositoryInterface {
  constructor(
    private ormRepository: Repository<TypeORMMcpToken>,
    private mapper: MapperInterface<McpToken, TypeORMMcpToken>,
  ) {}

  async findByUserUuid(userUuid: Uuid): Promise<McpToken[]> {
    const typeOrm = await this.ormRepository
      .createQueryBuilder('mcp_token')
      .where('mcp_token.user_uuid = :userUuid', {
        userUuid: userUuid.value,
      })
      .orderBy('mcp_token.created_at', 'DESC')
      .getMany()

    return typeOrm.map((mcpToken) => this.mapper.toDomain(mcpToken))
  }

  async findById(id: UniqueEntityId): Promise<McpToken | null> {
    const persistence = await this.ormRepository
      .createQueryBuilder('mcp_token')
      .where('mcp_token.uuid = :id', {
        id: id.toString(),
      })
      .getOne()

    if (persistence === null) {
      return null
    }

    return this.mapper.toDomain(persistence)
  }

  async save(mcpToken: McpToken): Promise<void> {
    const persistence = this.mapper.toProjection(mcpToken)

    await this.ormRepository.save(persistence)
  }

  async updateLastUsedAt(id: UniqueEntityId, lastUsedAt: Date): Promise<void> {
    await this.ormRepository
      .createQueryBuilder()
      .update()
      .set({
        lastUsedAt: lastUsedAt.getTime(),
      })
      .where('uuid = :uuid', {
        uuid: id.toString(),
      })
      .execute()
  }

  async remove(mcpToken: McpToken): Promise<void> {
    await this.ormRepository.remove(this.mapper.toProjection(mcpToken))
  }

  async removeByUserUuid(userUuid: Uuid): Promise<void> {
    await this.ormRepository
      .createQueryBuilder()
      .delete()
      .where('user_uuid = :userUuid', { userUuid: userUuid.value })
      .execute()
  }
}
