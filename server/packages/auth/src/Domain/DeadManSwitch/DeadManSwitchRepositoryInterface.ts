import { UniqueEntityId, Uuid } from '@standardnotes/domain-core'

import { DeadManSwitch } from './DeadManSwitch'

export interface DeadManSwitchRepositoryInterface {
  findByUserUuid(userUuid: Uuid): Promise<DeadManSwitch[]>
  findById(id: UniqueEntityId): Promise<DeadManSwitch | null>
  // All switches that are still armed and whose deadline has elapsed.
  findDue(now: number): Promise<DeadManSwitch[]>
  save(deadManSwitch: DeadManSwitch): Promise<void>
  remove(deadManSwitch: DeadManSwitch): Promise<void>
  removeByUserUuid(userUuid: Uuid): Promise<void>
}
