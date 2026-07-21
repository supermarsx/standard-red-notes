import { Result } from '@standardnotes/domain-core'
import { SharedVaultRemovedEvent } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { RemoveRevisionsFromSharedVault } from '../UseCase/RemoveRevisionsFromSharedVault/RemoveRevisionsFromSharedVault'
import { SharedVaultRemovedEventHandler } from './SharedVaultRemovedEventHandler'

describe('SharedVaultRemovedEventHandler', () => {
  let removeRevisionsFromSharedVault: RemoveRevisionsFromSharedVault
  let logger: Logger
  let event: SharedVaultRemovedEvent

  const createHandler = () => new SharedVaultRemovedEventHandler(removeRevisionsFromSharedVault, logger)

  beforeEach(() => {
    removeRevisionsFromSharedVault = {} as jest.Mocked<RemoveRevisionsFromSharedVault>
    removeRevisionsFromSharedVault.execute = jest.fn().mockResolvedValue(Result.ok())

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()

    event = {} as jest.Mocked<SharedVaultRemovedEvent>
    event.payload = {
      sharedVaultUuid: '84c0f8e8-544a-4c7e-9adf-26209303bc1d',
    } as SharedVaultRemovedEvent['payload']
  })

  it('should remove the revisions of every item in the removed shared vault', async () => {
    await createHandler().handle(event)

    expect(removeRevisionsFromSharedVault.execute).toHaveBeenCalledWith({
      sharedVaultUuid: '84c0f8e8-544a-4c7e-9adf-26209303bc1d',
    })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('should not scope the removal to a single item', async () => {
    await createHandler().handle(event)

    const dto = (removeRevisionsFromSharedVault.execute as jest.Mock).mock.calls[0][0]
    expect(dto.itemUuid).toBeUndefined()
  })

  it('should log the failure reason when the revisions cannot be removed', async () => {
    removeRevisionsFromSharedVault.execute = jest.fn().mockResolvedValue(Result.fail('Oops'))

    await createHandler().handle(event)

    expect(logger.error).toHaveBeenCalledWith('Failed to remove revisions from shared vault: Oops')
  })
})
