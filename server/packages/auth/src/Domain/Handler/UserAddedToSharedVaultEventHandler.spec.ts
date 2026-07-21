import { UserAddedToSharedVaultEvent } from '@standardnotes/domain-events'
import { Result } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { AddSharedVaultUser } from '../UseCase/AddSharedVaultUser/AddSharedVaultUser'

import { UserAddedToSharedVaultEventHandler } from './UserAddedToSharedVaultEventHandler'

describe('UserAddedToSharedVaultEventHandler', () => {
  let addSharedVaultUser: AddSharedVaultUser
  let logger: Logger

  const payload = {
    userUuid: '00000000-0000-0000-0000-000000000000',
    sharedVaultUuid: '11111111-1111-1111-1111-111111111111',
    permission: 'write',
    createdAt: 1,
    updatedAt: 2,
  }

  const event = { payload } as unknown as jest.Mocked<UserAddedToSharedVaultEvent>

  const createHandler = () => new UserAddedToSharedVaultEventHandler(addSharedVaultUser, logger)

  beforeEach(() => {
    addSharedVaultUser = {} as jest.Mocked<AddSharedVaultUser>
    addSharedVaultUser.execute = jest.fn().mockResolvedValue(Result.ok('added'))

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
  })

  it('should add the user to the shared vault with the granted permission', async () => {
    await createHandler().handle(event)

    expect(addSharedVaultUser.execute).toHaveBeenCalledWith(payload)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('should log an error if the user could not be added', async () => {
    addSharedVaultUser.execute = jest.fn().mockResolvedValue(Result.fail('nope'))

    await createHandler().handle(event)

    expect(logger.error).toHaveBeenCalledWith('Failed to add user to shared vault: nope')
  })
})
