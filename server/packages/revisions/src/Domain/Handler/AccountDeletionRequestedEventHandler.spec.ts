import { AccountDeletionRequestedEvent } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { RevisionRepositoryInterface } from '../Revision/RevisionRepositoryInterface'
import { AccountDeletionRequestedEventHandler } from './AccountDeletionRequestedEventHandler'

describe('AccountDeletionRequestedEventHandler', () => {
  let revisionRepository: RevisionRepositoryInterface
  let logger: Logger
  let event: AccountDeletionRequestedEvent

  const createHandler = () => new AccountDeletionRequestedEventHandler(revisionRepository, logger)

  beforeEach(() => {
    revisionRepository = {} as jest.Mocked<RevisionRepositoryInterface>
    revisionRepository.removeByUserUuid = jest.fn()

    logger = {} as jest.Mocked<Logger>
    logger.info = jest.fn()
    logger.warn = jest.fn()

    event = {} as jest.Mocked<AccountDeletionRequestedEvent>
    event.payload = {
      userUuid: '84c0f8e8-544a-4c7e-9adf-26209303bc1d',
    } as AccountDeletionRequestedEvent['payload']
  })

  it('should remove the revisions of the deleted user', async () => {
    await createHandler().handle(event)

    expect(revisionRepository.removeByUserUuid).toHaveBeenCalledTimes(1)

    const userUuid = (revisionRepository.removeByUserUuid as jest.Mock).mock.calls[0][0]
    expect(userUuid.value).toEqual('84c0f8e8-544a-4c7e-9adf-26209303bc1d')

    expect(logger.info).toHaveBeenCalled()
  })

  it('should not remove anything if the user uuid on the event is invalid', async () => {
    event.payload.userUuid = 'not-a-uuid'

    await createHandler().handle(event)

    expect(revisionRepository.removeByUserUuid).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
    expect(logger.info).not.toHaveBeenCalled()
  })
})
