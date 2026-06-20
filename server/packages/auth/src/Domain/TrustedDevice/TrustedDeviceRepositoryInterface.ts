import { UniqueEntityId, Uuid } from '@standardnotes/domain-core'

import { TrustedDevice } from './TrustedDevice'

export interface TrustedDeviceRepositoryInterface {
  findByUserUuid(userUuid: Uuid): Promise<TrustedDevice[]>
  findById(id: UniqueEntityId): Promise<TrustedDevice | null>
  save(trustedDevice: TrustedDevice): Promise<void>
  remove(trustedDevice: TrustedDevice): Promise<void>
  removeByUserUuid(userUuid: Uuid): Promise<void>
}
