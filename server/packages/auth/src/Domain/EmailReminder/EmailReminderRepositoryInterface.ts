import { UniqueEntityId, Uuid } from '@standardnotes/domain-core'

import { EmailReminder } from './EmailReminder'

export interface EmailReminderRepositoryInterface {
  findByUserUuid(userUuid: Uuid): Promise<EmailReminder[]>
  findById(id: UniqueEntityId): Promise<EmailReminder | null>
  // All reminders that are due (dueAt <= now) and have not yet been sent.
  findDueUnsent(now: number): Promise<EmailReminder[]>
  save(emailReminder: EmailReminder): Promise<void>
  remove(emailReminder: EmailReminder): Promise<void>
  removeByUserUuid(userUuid: Uuid): Promise<void>
}
