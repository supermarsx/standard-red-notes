import { MapperInterface } from '@standardnotes/domain-core'
import { Repository } from 'typeorm'

import { EmailConfirmationToken } from '../../Domain/EmailConfirmation/EmailConfirmationToken'
import { EmailConfirmationTokenRepositoryInterface } from '../../Domain/EmailConfirmation/EmailConfirmationTokenRepositoryInterface'

import { TypeORMEmailConfirmationToken } from './TypeORMEmailConfirmationToken'

export class TypeORMEmailConfirmationTokenRepository implements EmailConfirmationTokenRepositoryInterface {
  constructor(
    private ormRepository: Repository<TypeORMEmailConfirmationToken>,
    private mapper: MapperInterface<EmailConfirmationToken, TypeORMEmailConfirmationToken>,
  ) {}

  async save(token: EmailConfirmationToken): Promise<void> {
    const persistence = this.mapper.toProjection(token)

    await this.ormRepository.save(persistence)
  }

  async findByHashedToken(hashedToken: string): Promise<EmailConfirmationToken | null> {
    const persistence = await this.ormRepository
      .createQueryBuilder('email_confirmation_token')
      .where('email_confirmation_token.hashed_token = :hashedToken', { hashedToken })
      .getOne()

    if (persistence === null) {
      return null
    }

    return this.mapper.toDomain(persistence)
  }
}
