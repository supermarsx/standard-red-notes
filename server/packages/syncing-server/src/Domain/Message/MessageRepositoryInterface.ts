import { Uuid } from '@standardnotes/domain-core'

import { Message } from './Message'

export interface MessageRepositoryInterface {
  findByUuid: (uuid: Uuid) => Promise<Message | null>
  findByRecipientUuid: (uuid: Uuid) => Promise<Message[]>
  findByRecipientUuidUpdatedAfter: (uuid: Uuid, updatedAtTimestamp: number) => Promise<Message[]>
  findBySenderUuid: (uuid: Uuid) => Promise<Message[]>
  /**
   * Scoped by BOTH sender and recipient on purpose. The replaceability identifier is deterministic
   * (`<type>:<sharedVaultUuid>:<keySystemIdentifier>`), so it is known to every current AND former
   * member of a shared vault. A recipient-only lookup therefore let any authenticated user replace —
   * i.e. delete — the owner's pending message to a specific member, which silently suppressed key
   * rotation: after a member removal plus rotation, the remaining members never learned the new key.
   * A message may only ever replace one from the same sender.
   */
  findByRecipientUuidAndSenderUuidAndReplaceabilityIdentifier: (dto: {
    recipientUuid: Uuid
    senderUuid: Uuid
    replaceabilityIdentifier: string
  }) => Promise<Message | null>
  save(message: Message): Promise<void>
  remove(message: Message): Promise<void>
}
