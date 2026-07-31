import { UserRemovedFromSharedVaultEvent } from '@standardnotes/domain-events'
import { Result } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { RemoveSharedVaultUser } from '../UseCase/RemoveSharedVaultUser/RemoveSharedVaultUser'

import { UserRemovedFromSharedVaultEventHandler } from './UserRemovedFromSharedVaultEventHandler'

describe('UserRemovedFromSharedVaultEventHandler', () => {
  let removeSharedVaultUser: RemoveSharedVaultUser
  let logger: Logger

  const userUuid = '00000000-0000-0000-0000-000000000000'
  const sharedVaultUuid = '11111111-1111-1111-1111-111111111111'

  const eventWith = (payload: Record<string, unknown>) =>
    ({ payload }) as unknown as jest.Mocked<UserRemovedFromSharedVaultEvent>

  const createHandler = () => new UserRemovedFromSharedVaultEventHandler(removeSharedVaultUser, logger)

  beforeEach(() => {
    removeSharedVaultUser = {} as jest.Mocked<RemoveSharedVaultUser>
    removeSharedVaultUser.execute = jest.fn().mockResolvedValue(Result.ok('removed'))

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
  })

  it('should remove the user from the shared vault', async () => {
    await createHandler().handle(eventWith({ userUuid, sharedVaultUuid }))

    expect(removeSharedVaultUser.execute).toHaveBeenCalledWith({ userUuid, sharedVaultUuid })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('should not call the use case when the shared vault uuid is missing from the event', async () => {
    await createHandler().handle(eventWith({ userUuid }))

    expect(removeSharedVaultUser.execute).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith('Shared-vault UUID is missing from the user-removed event.', {
      userId: userUuid,
    })
  })

  it('should log an error if the removal fails', async () => {
    removeSharedVaultUser.execute = jest.fn().mockResolvedValue(Result.fail('nope'))

    await createHandler().handle(eventWith({ userUuid, sharedVaultUuid }))

    expect(logger.error).toHaveBeenCalledWith('Failed to remove a user from a shared vault.')
  })
})
