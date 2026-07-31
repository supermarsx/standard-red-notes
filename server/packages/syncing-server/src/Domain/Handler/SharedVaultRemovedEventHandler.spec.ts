import 'reflect-metadata'
import { Result } from '@standardnotes/domain-core'
import { SharedVaultRemovedEvent } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { RemoveItemsFromSharedVault } from '../UseCase/SharedVaults/RemoveItemsFromSharedVault/RemoveItemsFromSharedVault'

import { SharedVaultRemovedEventHandler } from './SharedVaultRemovedEventHandler'

describe('SharedVaultRemovedEventHandler', () => {
  let removeItemsFromSharedVault: RemoveItemsFromSharedVault
  let logger: Logger

  const sharedVaultUuid = '00000000-0000-0000-0000-000000000001'

  const createHandler = () => new SharedVaultRemovedEventHandler(removeItemsFromSharedVault, logger)

  const event = () => ({ payload: { sharedVaultUuid } }) as jest.Mocked<SharedVaultRemovedEvent>

  beforeEach(() => {
    removeItemsFromSharedVault = {} as jest.Mocked<RemoveItemsFromSharedVault>
    removeItemsFromSharedVault.execute = jest.fn().mockResolvedValue(Result.ok())

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
  })

  it('removes the items belonging to the removed shared vault', async () => {
    await createHandler().handle(event())

    expect(removeItemsFromSharedVault.execute).toHaveBeenCalledWith({ sharedVaultUuid })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('logs the failure when the items could not be removed', async () => {
    removeItemsFromSharedVault.execute = jest.fn().mockResolvedValue(Result.fail('Oops'))

    await createHandler().handle(event())

    expect(logger.error).toHaveBeenCalledWith(
      `Failed to remove items from shared vault ${sharedVaultUuid}.`,
      expect.objectContaining({ errorType: 'Error' }),
    )
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('Oops')
  })
})
