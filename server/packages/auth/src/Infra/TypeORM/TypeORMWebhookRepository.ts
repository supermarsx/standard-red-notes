import { MapperInterface, UniqueEntityId, Uuid } from '@standardnotes/domain-core'
import { Repository } from 'typeorm'

import { Webhook } from '../../Domain/Webhook/Webhook'
import { WebhookRepositoryInterface } from '../../Domain/Webhook/WebhookRepositoryInterface'
import { TypeORMWebhook } from './TypeORMWebhook'

export class TypeORMWebhookRepository implements WebhookRepositoryInterface {
  constructor(
    private ormRepository: Repository<TypeORMWebhook>,
    private mapper: MapperInterface<Webhook, TypeORMWebhook>,
  ) {}

  async findByUserUuid(userUuid: Uuid): Promise<Webhook[]> {
    const typeOrm = await this.ormRepository
      .createQueryBuilder('webhook')
      .where('webhook.user_uuid = :userUuid', {
        userUuid: userUuid.value,
      })
      .orderBy('webhook.created_at', 'DESC')
      .getMany()

    return typeOrm.map((webhook) => this.mapper.toDomain(webhook))
  }

  async findGlobal(): Promise<Webhook[]> {
    const typeOrm = await this.ormRepository
      .createQueryBuilder('webhook')
      .where('webhook.user_uuid IS NULL')
      .orderBy('webhook.created_at', 'DESC')
      .getMany()

    return typeOrm.map((webhook) => this.mapper.toDomain(webhook))
  }

  async findAllEnabled(): Promise<Webhook[]> {
    const typeOrm = await this.ormRepository
      .createQueryBuilder('webhook')
      .where('webhook.enabled = :enabled', { enabled: true })
      .getMany()

    return typeOrm.map((webhook) => this.mapper.toDomain(webhook))
  }

  async findById(id: UniqueEntityId): Promise<Webhook | null> {
    const persistence = await this.ormRepository
      .createQueryBuilder('webhook')
      .where('webhook.uuid = :id', {
        id: id.toString(),
      })
      .getOne()

    if (persistence === null) {
      return null
    }

    return this.mapper.toDomain(persistence)
  }

  async save(webhook: Webhook): Promise<void> {
    const persistence = this.mapper.toProjection(webhook)

    await this.ormRepository.save(persistence)
  }

  async remove(webhook: Webhook): Promise<void> {
    await this.ormRepository.remove(this.mapper.toProjection(webhook))
  }

  async removeByUserUuid(userUuid: Uuid): Promise<void> {
    await this.ormRepository
      .createQueryBuilder()
      .delete()
      .where('user_uuid = :userUuid', { userUuid: userUuid.value })
      .execute()
  }
}
