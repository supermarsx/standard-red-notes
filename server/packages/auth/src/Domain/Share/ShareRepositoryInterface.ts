import { UniqueEntityId, Uuid } from '@standardnotes/domain-core'

import { Share } from './Share'

export interface ShareRepositoryInterface {
  findByUserUuid(userUuid: Uuid): Promise<Share[]>
  findById(id: UniqueEntityId): Promise<Share | null>
  save(share: Share): Promise<void>
  remove(share: Share): Promise<void>
  removeByUserUuid(userUuid: Uuid): Promise<void>
}
