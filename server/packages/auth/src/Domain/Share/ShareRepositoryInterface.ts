import { UniqueEntityId, Uuid } from '@standardnotes/domain-core'

import { Share } from './Share'

export interface ShareRepositoryInterface {
  findByUserUuid(userUuid: Uuid): Promise<Share[]>
  findById(id: UniqueEntityId): Promise<Share | null>
  save(share: Share): Promise<void>
  remove(share: Share): Promise<void>
  removeByUserUuid(userUuid: Uuid): Promise<void>
  /**
   * Atomically stamp `first_opened_at` on a share that has not yet been opened.
   * Returns true ONLY for the caller that won the race (i.e. the row was updated
   * from a NULL `first_opened_at` to `openedAt`). Subsequent / concurrent callers
   * get false. Used to make "burn after reading" consumption safe under two
   * near-simultaneous opens — the first wins.
   */
  markFirstOpenedAtomically(id: UniqueEntityId, openedAt: Date): Promise<boolean>
  /**
   * Atomically mark a share revoked. Used to consume a one-time-view share after
   * its (single) successful read.
   */
  markRevoked(id: UniqueEntityId): Promise<void>
}
