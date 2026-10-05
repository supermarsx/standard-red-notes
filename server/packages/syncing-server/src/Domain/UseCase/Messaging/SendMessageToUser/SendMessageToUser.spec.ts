import { TimerInterface } from '@standardnotes/time'
import { MessageRepositoryInterface } from '../../../Message/MessageRepositoryInterface'
import { SendMessageToUser } from './SendMessageToUser'
import { Message } from '../../../Message/Message'
import { Result, Timestamps, Uuid } from '@standardnotes/domain-core'
import { Logger } from 'winston'
import { DomainEventFactoryInterface } from '../../../Event/DomainEventFactoryInterface'
import { SendEventToClient } from '../../Syncing/SendEventToClient/SendEventToClient'
import { MessageSentToUserEvent } from '@standardnotes/domain-events'

describe('SendMessageToUser', () => {
  let messageRepository: MessageRepositoryInterface
  let timer: TimerInterface
  let existingMessage: Message
  let domainEventFactory: DomainEventFactoryInterface
  let sendEventToClientUseCase: SendEventToClient
  let logger: Logger

  const createUseCase = () =>
    new SendMessageToUser(messageRepository, timer, domainEventFactory, sendEventToClientUseCase, logger)

  beforeEach(() => {
    existingMessage = {} as jest.Mocked<Message>

    messageRepository = {} as jest.Mocked<MessageRepositoryInterface>
    messageRepository.findByRecipientUuidAndSenderUuidAndReplaceabilityIdentifier = jest.fn().mockReturnValue(null)
    messageRepository.remove = jest.fn()
    messageRepository.save = jest.fn()

    timer = {} as jest.Mocked<TimerInterface>
    timer.getTimestampInMicroseconds = jest.fn().mockReturnValue(123456789)

    domainEventFactory = {} as jest.Mocked<DomainEventFactoryInterface>
    domainEventFactory.createMessageSentToUserEvent = jest.fn().mockReturnValue({
      type: 'MESSAGE_SENT_TO_USER',
    } as jest.Mocked<MessageSentToUserEvent>)

    sendEventToClientUseCase = {} as jest.Mocked<SendEventToClient>
    sendEventToClientUseCase.execute = jest.fn().mockReturnValue(Result.ok())

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
  })

  it('saves a new message', async () => {
    const useCase = createUseCase()

    const result = await useCase.execute({
      recipientUuid: '00000000-0000-0000-0000-000000000000',
      senderUuid: '00000000-0000-0000-0000-000000000000',
      encryptedMessage: 'encrypted-message',
    })

    expect(result.isFailed()).toBeFalsy()
  })

  it('removes existing message with the same replaceability identifier', async () => {
    messageRepository.findByRecipientUuidAndSenderUuidAndReplaceabilityIdentifier = jest
      .fn()
      .mockReturnValue(existingMessage)
    const useCase = createUseCase()

    const result = await useCase.execute({
      recipientUuid: '00000000-0000-0000-0000-000000000000',
      senderUuid: '00000000-0000-0000-0000-000000000000',
      encryptedMessage: 'encrypted-message',
      replaceabilityIdentifier: 'replaceability-identifier',
    })

    expect(result.isFailed()).toBeFalsy()
    expect(messageRepository.remove).toHaveBeenCalledWith(existingMessage)
  })

  it('returns error when recipient uuid is invalid', async () => {
    const useCase = createUseCase()

    const result = await useCase.execute({
      recipientUuid: 'invalid-uuid',
      senderUuid: '00000000-0000-0000-0000-000000000000',
      encryptedMessage: 'encrypted-message',
    })

    expect(result.isFailed()).toBeTruthy()
  })

  it('returns error when sender uuid is invalid', async () => {
    const useCase = createUseCase()

    const result = await useCase.execute({
      recipientUuid: '00000000-0000-0000-0000-000000000000',
      senderUuid: 'invalid-uuid',
      encryptedMessage: 'encrypted-message',
    })

    expect(result.isFailed()).toBeTruthy()
  })

  it('returns error when message is empty', async () => {
    const useCase = createUseCase()

    const result = await useCase.execute({
      recipientUuid: '00000000-0000-0000-0000-000000000000',
      senderUuid: '00000000-0000-0000-0000-000000000000',
      encryptedMessage: '',
    })

    expect(result.isFailed()).toBeTruthy()
  })

  it('returns error when message fails to create', async () => {
    const mock = jest.spyOn(Message, 'create')
    mock.mockImplementation(() => {
      return Result.fail('Oops')
    })

    const useCase = createUseCase()

    const result = await useCase.execute({
      recipientUuid: '00000000-0000-0000-0000-000000000000',
      senderUuid: '00000000-0000-0000-0000-000000000000',
      encryptedMessage: 'encrypted-message',
    })

    expect(result.isFailed()).toBeTruthy()

    mock.mockRestore()
  })

  it('should log error if event could not be sent to user', async () => {
    sendEventToClientUseCase.execute = jest.fn().mockReturnValue(Result.fail('Oops'))

    const useCase = createUseCase()

    const result = await useCase.execute({
      recipientUuid: '00000000-0000-0000-0000-000000000000',
      senderUuid: '00000000-0000-0000-0000-000000000000',
      encryptedMessage: 'encrypted-message',
    })

    expect(result.isFailed()).toBeFalsy()
    expect(logger.error).toHaveBeenCalled()
  })

  describe('replacement is scoped to the sender as well as the recipient', () => {
    const OWNER = '11111111-1111-1111-1111-111111111111'
    const MEMBER = '22222222-2222-2222-2222-222222222222'
    const ATTACKER = '33333333-3333-3333-3333-333333333333'
    // Deterministic, therefore known to every current AND former member of the vault.
    const IDENTIFIER =
      'SharedVaultRootKeyChanged:44444444-4444-4444-4444-444444444444:55555555-5555-5555-5555-555555555555'

    const uuid = (value: string) => Uuid.create(value).getValue()

    const createMessage = (senderUuid: string, recipientUuid: string, replaceabilityIdentifier: string): Message =>
      Message.create({
        recipientUuid: uuid(recipientUuid),
        senderUuid: uuid(senderUuid),
        encryptedMessage: 'pending-root-key-rotation',
        replaceabilityIdentifier,
        timestamps: Timestamps.create(1, 1).getValue(),
      }).getValue()

    /**
     * Mirrors TypeORMMessageRepository: a row matches only when recipient AND sender AND identifier
     * all match. `remove` throws if handed a row that is not in the store, so neither assertion
     * below can pass over an empty or mismatched fixture.
     */
    const createStore = (seeded: Message[]) => {
      const rows = [...seeded]

      const lookup = jest.fn(
        async (dto: {
          recipientUuid: Uuid
          senderUuid: Uuid
          replaceabilityIdentifier: string
        }): Promise<Message | null> =>
          rows.find(
            (row) =>
              row.props.recipientUuid.equals(dto.recipientUuid) &&
              row.props.senderUuid.equals(dto.senderUuid) &&
              row.props.replaceabilityIdentifier === dto.replaceabilityIdentifier,
          ) ?? null,
      )

      const remove = jest.fn(async (message: Message): Promise<void> => {
        const index = rows.indexOf(message)
        if (index === -1) {
          throw new Error('remove() was called with a message that is not in the store')
        }
        rows.splice(index, 1)
      })

      return { rows, lookup, remove }
    }

    it('does not delete the owner pending rotation message when a different sender reuses the identifier', async () => {
      const ownersPendingRotation = createMessage(OWNER, MEMBER, IDENTIFIER)
      const store = createStore([ownersPendingRotation])

      // Precondition: the seeded row really is reachable through this lookup when the sender matches.
      // Without this, a store that never held the row would produce the same "not removed" result.
      await expect(
        store.lookup({ recipientUuid: uuid(MEMBER), senderUuid: uuid(OWNER), replaceabilityIdentifier: IDENTIFIER }),
      ).resolves.toBe(ownersPendingRotation)
      store.lookup.mockClear()

      messageRepository.findByRecipientUuidAndSenderUuidAndReplaceabilityIdentifier = store.lookup
      messageRepository.remove = store.remove

      const result = await createUseCase().execute({
        recipientUuid: MEMBER,
        senderUuid: ATTACKER,
        encryptedMessage: 'message-from-an-unrelated-account',
        replaceabilityIdentifier: IDENTIFIER,
      })

      expect(result.isFailed()).toBeFalsy()

      // The replacement lookup really was attempted, and it carried the attacker as the sender.
      expect(store.lookup).toHaveBeenCalledTimes(1)
      const lookupArguments = store.lookup.mock.calls[0][0]
      expect(lookupArguments.recipientUuid.value).toEqual(MEMBER)
      expect(lookupArguments.senderUuid.value).toEqual(ATTACKER)
      expect(lookupArguments.replaceabilityIdentifier).toEqual(IDENTIFIER)

      expect(store.remove).not.toHaveBeenCalled()
      expect(store.rows).toContain(ownersPendingRotation)
    })

    it('still replaces the sender own previous message with the same identifier', async () => {
      const ownersPendingRotation = createMessage(OWNER, MEMBER, IDENTIFIER)
      const store = createStore([ownersPendingRotation])

      messageRepository.findByRecipientUuidAndSenderUuidAndReplaceabilityIdentifier = store.lookup
      messageRepository.remove = store.remove

      const result = await createUseCase().execute({
        recipientUuid: MEMBER,
        senderUuid: OWNER,
        encryptedMessage: 'newer-root-key-rotation',
        replaceabilityIdentifier: IDENTIFIER,
      })

      expect(result.isFailed()).toBeFalsy()
      expect(store.lookup).toHaveBeenCalledTimes(1)
      expect(store.remove).toHaveBeenCalledWith(ownersPendingRotation)
      expect(store.rows).not.toContain(ownersPendingRotation)
      expect(messageRepository.save).toHaveBeenCalled()
    })
  })
})
