import { PaymentsAccountDeletedEvent } from '@standardnotes/domain-events'
import { Result } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { DeleteAccount } from '../UseCase/DeleteAccount/DeleteAccount'

import { PaymentsAccountDeletedEventHandler } from './PaymentsAccountDeletedEventHandler'

describe('PaymentsAccountDeletedEventHandler', () => {
  let deleteAccount: DeleteAccount
  let logger: Logger

  const username = 'user@example.com'

  const event = {
    payload: { username },
  } as jest.Mocked<PaymentsAccountDeletedEvent>

  const createHandler = () => new PaymentsAccountDeletedEventHandler(deleteAccount, logger)

  beforeEach(() => {
    deleteAccount = {} as jest.Mocked<DeleteAccount>
    deleteAccount.execute = jest.fn().mockResolvedValue(Result.ok('deleted'))

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
  })

  it('should delete the account identified by username', async () => {
    await createHandler().handle(event)

    expect(deleteAccount.execute).toHaveBeenCalledWith({ username })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('should log an error naming the user if the deletion fails', async () => {
    deleteAccount.execute = jest.fn().mockResolvedValue(Result.fail('could not delete'))

    await createHandler().handle(event)

    expect(logger.error).toHaveBeenCalledWith(`Failed to delete account for user ${username}: could not delete`)
  })
})
