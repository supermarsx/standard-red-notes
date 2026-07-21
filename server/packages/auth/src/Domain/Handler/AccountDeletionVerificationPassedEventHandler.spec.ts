import { AccountDeletionVerificationPassedEvent } from '@standardnotes/domain-events'
import { Result } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { DeleteAccount } from '../UseCase/DeleteAccount/DeleteAccount'

import { AccountDeletionVerificationPassedEventHandler } from './AccountDeletionVerificationPassedEventHandler'

describe('AccountDeletionVerificationPassedEventHandler', () => {
  let deleteAccount: DeleteAccount
  let logger: Logger

  const userUuid = '00000000-0000-0000-0000-000000000000'

  const event = {
    payload: { userUuid },
  } as jest.Mocked<AccountDeletionVerificationPassedEvent>

  const createHandler = () => new AccountDeletionVerificationPassedEventHandler(deleteAccount, logger)

  beforeEach(() => {
    deleteAccount = {} as jest.Mocked<DeleteAccount>
    deleteAccount.execute = jest.fn().mockResolvedValue(Result.ok('deleted'))

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
  })

  it('should delete the account of the verified user', async () => {
    await createHandler().handle(event)

    expect(deleteAccount.execute).toHaveBeenCalledWith({ userUuid })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('should log an error if the deletion fails', async () => {
    deleteAccount.execute = jest.fn().mockResolvedValue(Result.fail('could not delete'))

    await createHandler().handle(event)

    expect(logger.error).toHaveBeenCalledWith('AccountDeletionVerificationPassedEventHandler failed: could not delete')
  })
})
