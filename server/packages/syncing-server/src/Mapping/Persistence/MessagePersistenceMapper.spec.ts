import { Timestamps, UniqueEntityId, Uuid } from '@standardnotes/domain-core'

import { Message } from '../../Domain/Message/Message'
import { TypeORMMessage } from '../../Infra/TypeORM/TypeORMMessage'

import { MessagePersistenceMapper } from './MessagePersistenceMapper'

describe('MessagePersistenceMapper', () => {
  const messageUuid = '00000000-0000-0000-0000-000000000001'
  const recipientUuid = '00000000-0000-0000-0000-000000000002'
  const senderUuid = '00000000-0000-0000-0000-000000000003'

  const createMapper = () => new MessagePersistenceMapper()

  const createProjection = (overrides: Partial<TypeORMMessage> = {}): TypeORMMessage => {
    const typeorm = new TypeORMMessage()
    typeorm.uuid = messageUuid
    typeorm.recipientUuid = recipientUuid
    typeorm.senderUuid = senderUuid
    typeorm.encryptedMessage = 'encrypted-message'
    typeorm.replaceabilityIdentifier = 'replaceability-identifier'
    typeorm.createdAtTimestamp = 123
    typeorm.updatedAtTimestamp = 456

    return Object.assign(typeorm, overrides)
  }

  const createDomain = () =>
    Message.create(
      {
        recipientUuid: Uuid.create(recipientUuid).getValue(),
        senderUuid: Uuid.create(senderUuid).getValue(),
        encryptedMessage: 'encrypted-message',
        replaceabilityIdentifier: 'replaceability-identifier',
        timestamps: Timestamps.create(123, 456).getValue(),
      },
      new UniqueEntityId(messageUuid),
    ).getValue()

  it('rebuilds the message from its persisted row', () => {
    const message = createMapper().toDomain(createProjection())

    expect(message.id.toString()).toEqual(messageUuid)
    expect(message.props.recipientUuid.value).toEqual(recipientUuid)
    expect(message.props.senderUuid.value).toEqual(senderUuid)
    expect(message.props.encryptedMessage).toEqual('encrypted-message')
    expect(message.props.replaceabilityIdentifier).toEqual('replaceability-identifier')
    expect(message.props.timestamps.createdAt).toEqual(123)
    expect(message.props.timestamps.updatedAt).toEqual(456)
  })

  it('rejects a row with a malformed recipient uuid', () => {
    expect(() => createMapper().toDomain(createProjection({ recipientUuid: 'not-a-uuid' }))).toThrow(
      /^Failed to create message from projection:/,
    )
  })

  it('rejects a row with a malformed sender uuid', () => {
    expect(() => createMapper().toDomain(createProjection({ senderUuid: 'not-a-uuid' }))).toThrow(
      /^Failed to create message from projection:/,
    )
  })

  it('rejects a row whose timestamps are not numbers', () => {
    expect(() => createMapper().toDomain(createProjection({ createdAtTimestamp: '123' as unknown as number }))).toThrow(
      /^Failed to create message from projection:/,
    )
  })

  it('rejects a row with an empty encrypted message', () => {
    expect(() => createMapper().toDomain(createProjection({ encryptedMessage: '' }))).toThrow(
      /^Failed to create message from projection:/,
    )
  })

  it('maps a message onto its persisted row', () => {
    const projection = createMapper().toProjection(createDomain())

    expect(projection).toBeInstanceOf(TypeORMMessage)
    expect(projection.uuid).toEqual(messageUuid)
    expect(projection.recipientUuid).toEqual(recipientUuid)
    expect(projection.senderUuid).toEqual(senderUuid)
    expect(projection.encryptedMessage).toEqual('encrypted-message')
    expect(projection.replaceabilityIdentifier).toEqual('replaceability-identifier')
    expect(projection.createdAtTimestamp).toEqual(123)
    expect(projection.updatedAtTimestamp).toEqual(456)
  })

  it('round trips a message without altering it', () => {
    const mapper = createMapper()

    expect(mapper.toProjection(mapper.toDomain(createProjection()))).toEqual(createProjection())
  })
})
