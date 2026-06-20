import { MapperInterface, UniqueEntityId, Uuid } from '@standardnotes/domain-core'
import { Repository } from 'typeorm'

import { EmailReminder } from '../../Domain/EmailReminder/EmailReminder'
import { EmailReminderRepositoryInterface } from '../../Domain/EmailReminder/EmailReminderRepositoryInterface'
import { TypeORMEmailReminder } from './TypeORMEmailReminder'

export class TypeORMEmailReminderRepository implements EmailReminderRepositoryInterface {
  constructor(
    private ormRepository: Repository<TypeORMEmailReminder>,
    private mapper: MapperInterface<EmailReminder, TypeORMEmailReminder>,
  ) {}

  async findByUserUuid(userUuid: Uuid): Promise<EmailReminder[]> {
    const typeOrm = await this.ormRepository
      .createQueryBuilder('email_reminder')
      .where('email_reminder.user_uuid = :userUuid', {
        userUuid: userUuid.value,
      })
      .orderBy('email_reminder.due_at', 'ASC')
      .getMany()

    return typeOrm.map((emailReminder) => this.mapper.toDomain(emailReminder))
  }

  async findById(id: UniqueEntityId): Promise<EmailReminder | null> {
    const persistence = await this.ormRepository
      .createQueryBuilder('email_reminder')
      .where('email_reminder.uuid = :id', {
        id: id.toString(),
      })
      .getOne()

    if (persistence === null) {
      return null
    }

    return this.mapper.toDomain(persistence)
  }

  async findDueUnsent(now: number): Promise<EmailReminder[]> {
    const typeOrm = await this.ormRepository
      .createQueryBuilder('email_reminder')
      .where('email_reminder.sent = :sent', { sent: false })
      .andWhere('email_reminder.due_at <= :now', { now })
      .getMany()

    return typeOrm.map((emailReminder) => this.mapper.toDomain(emailReminder))
  }

  async save(emailReminder: EmailReminder): Promise<void> {
    const persistence = this.mapper.toProjection(emailReminder)

    await this.ormRepository.save(persistence)
  }

  async remove(emailReminder: EmailReminder): Promise<void> {
    await this.ormRepository.remove(this.mapper.toProjection(emailReminder))
  }

  async removeByUserUuid(userUuid: Uuid): Promise<void> {
    await this.ormRepository
      .createQueryBuilder()
      .delete()
      .where('user_uuid = :userUuid', { userUuid: userUuid.value })
      .execute()
  }
}
