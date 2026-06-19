import { UniqueEntityId, Uuid } from '@standardnotes/domain-core'

import { AppPassword } from './AppPassword'

export interface AppPasswordRepositoryInterface {
  findByUserUuid(userUuid: Uuid): Promise<AppPassword[]>
  findById(id: UniqueEntityId): Promise<AppPassword | null>
  save(appPassword: AppPassword): Promise<void>
  updateLastUsedAt(id: UniqueEntityId, lastUsedAt: Date): Promise<void>
  remove(appPassword: AppPassword): Promise<void>
  removeByUserUuid(userUuid: Uuid): Promise<void>
}
