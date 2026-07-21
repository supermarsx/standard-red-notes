import { Result } from '@standardnotes/domain-core'
import { ItemRemovedFromSharedVaultEvent } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { RemoveRevisionsFromSharedVault } from '../UseCase/RemoveRevisionsFromSharedVault/RemoveRevisionsFromSharedVault'
import { ItemRemovedFromSharedVaultEventHandler } from './ItemRemovedFromSharedVaultEventHandler'

describe('ItemRemovedFromSharedVaultEventHandler', () => {
  let removeRevisionsFromSharedVault: RemoveRevisionsFromSharedVault
  let logger: Logger
  let event: ItemRemovedFromSharedVaultEvent

  const createHandler = () => new ItemRemovedFromSharedVaultEventHandler(removeRevisionsFromSharedVault, logger)

  beforeEach(() => {
    removeRevisionsFromSharedVault = {} as jest.Mocked<RemoveRevisionsFromSharedVault>
    removeRevisionsFromSharedVault.execute = jest.fn().mockResolvedValue(Result.ok())

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()

    event = {} as jest.Mocked<ItemRemovedFromSharedVaultEvent>
    event.payload = {
      itemUuid: '00000000-0000-0000-0000-000000000000',
      sharedVaultUuid: '84c0f8e8-544a-4c7e-9adf-26209303bc1d',
    } as ItemRemovedFromSharedVaultEvent['payload']
  })

  it('should remove the revisions of the item from the shared vault', async () => {
    await createHandler().handle(event)

    expect(removeRevisionsFromSharedVault.execute).toHaveBeenCalledWith({
      itemUuid: '00000000-0000-0000-0000-000000000000',
      sharedVaultUuid: '84c0f8e8-544a-4c7e-9adf-26209303bc1d',
    })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('should not remove anything when the event carries no item uuid', async () => {
    event.payload = {
      sharedVaultUuid: '84c0f8e8-544a-4c7e-9adf-26209303bc1d',
    } as ItemRemovedFromSharedVaultEvent['payload']

    await createHandler().handle(event)

    expect(removeRevisionsFromSharedVault.execute).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith('ItemRemovedFromSharedVaultEvent is missing itemUuid')
  })

  it('should log the failure reason when the revisions cannot be removed', async () => {
    removeRevisionsFromSharedVault.execute = jest.fn().mockResolvedValue(Result.fail('Oops'))

    await createHandler().handle(event)

    expect(logger.error).toHaveBeenCalledWith('Failed to remove revisions from shared vault: Oops')
  })
})
