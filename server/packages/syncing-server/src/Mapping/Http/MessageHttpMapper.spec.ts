import { Timestamps, UniqueEntityId, Uuid } from '@standardnotes/domain-core'

import { Message } from '../../Domain/Message/Message'

import { MessageHttpMapper } from './MessageHttpMapper'

describe('MessageHttpMapper', () => {
  const messageUuid = '00000000-0000-0000-0000-000000000001'
  const recipientUuid = '00000000-0000-0000-0000-000000000002'
  const senderUuid = '00000000-0000-0000-0000-000000000003'

  const createMapper = () => new MessageHttpMapper()

  const createMessage = (replaceabilityIdentifier: string | null = 'replaceability-identifier') =>
    Message.create(
      {
        recipientUuid: Uuid.create(recipientUuid).getValue(),
        senderUuid: Uuid.create(senderUuid).getValue(),
        encryptedMessage: 'encrypted-message',
        replaceabilityIdentifier,
        timestamps: Timestamps.create(123, 456).getValue(),
      },
      new UniqueEntityId(messageUuid),
    ).getValue()

  it('maps a message onto its http representation', () => {
    expect(createMapper().toProjection(createMessage())).toEqual({
      uuid: messageUuid,
      recipient_uuid: recipientUuid,
      sender_uuid: senderUuid,
      encrypted_message: 'encrypted-message',
      replaceability_identifier: 'replaceability-identifier',
      created_at_timestamp: 123,
      updated_at_timestamp: 456,
    })
  })

  it('keeps a null replaceability identifier null', () => {
    expect(createMapper().toProjection(createMessage(null)).replaceability_identifier).toBeNull()
  })

  it('refuses to map an http representation back to the domain', () => {
    expect(() => createMapper().toDomain({} as never)).toThrow(
      'Mapping from http representation to domain is not implemented.',
    )
  })
})
