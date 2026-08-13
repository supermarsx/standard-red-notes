import { MapperInterface } from '@standardnotes/domain-core'
import { Repository } from 'typeorm'

import { MagicLinkToken } from '../../Domain/MagicLink/MagicLinkToken'
import { MagicLinkTokenRepositoryInterface } from '../../Domain/MagicLink/MagicLinkTokenRepositoryInterface'

import { TypeORMMagicLinkToken } from './TypeORMMagicLinkToken'

export class TypeORMMagicLinkTokenRepository implements MagicLinkTokenRepositoryInterface {
  constructor(
    private ormRepository: Repository<TypeORMMagicLinkToken>,
    private mapper: MapperInterface<MagicLinkToken, TypeORMMagicLinkToken>,
  ) {}

  async save(magicLinkToken: MagicLinkToken): Promise<void> {
    const persistence = this.mapper.toProjection(magicLinkToken)

    await this.ormRepository.save(persistence)
  }

  async findLatestByUserIdentifier(userIdentifier: string): Promise<MagicLinkToken | null> {
    const persistence = await this.ormRepository
      .createQueryBuilder('magic_link_token')
      .where('magic_link_token.user_identifier = :userIdentifier', {
        userIdentifier,
      })
      .orderBy('magic_link_token.created_at', 'DESC')
      .addOrderBy('magic_link_token.uuid', 'DESC')
      .getOne()

    if (persistence === null) {
      return null
    }

    return this.mapper.toDomain(persistence)
  }

  /**
   * Resolve the token identified by the code the user actually received.
   * MySQL stores the legacy created_at column with whole-second precision, so
   * inferring identity from "latest" is ambiguous during rapid issuance. The
   * UUID tie-break also makes an unlikely repeated-code collision deterministic.
   */
  async findByUserIdentifierAndCode(userIdentifier: string, code: string): Promise<MagicLinkToken | null> {
    const persistence = await this.ormRepository
      .createQueryBuilder('magic_link_token')
      .where('magic_link_token.user_identifier = :userIdentifier', {
        userIdentifier,
      })
      .andWhere('magic_link_token.code = :code', { code })
      .orderBy('magic_link_token.created_at', 'DESC')
      .addOrderBy('magic_link_token.uuid', 'DESC')
      .getOne()

    return persistence === null ? null : this.mapper.toDomain(persistence)
  }
}
