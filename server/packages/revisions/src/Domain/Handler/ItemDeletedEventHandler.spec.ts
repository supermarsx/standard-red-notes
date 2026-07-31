import { Result } from '@standardnotes/domain-core'
import { ItemDeletedEvent } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { DeleteRevisions } from '../UseCase/DeleteRevisions/DeleteRevisions'
import { ItemDeletedEventHandler } from './ItemDeletedEventHandler'

describe('ItemDeletedEventHandler', () => {
  let deleteRevisions: DeleteRevisions
  let logger: Logger
  let event: ItemDeletedEvent

  const createHandler = () => new ItemDeletedEventHandler(deleteRevisions, logger)

  beforeEach(() => {
    deleteRevisions = {} as jest.Mocked<DeleteRevisions>
    deleteRevisions.execute = jest.fn().mockResolvedValue(Result.ok())

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()

    event = {} as jest.Mocked<ItemDeletedEvent>
    event.payload = {
      itemUuid: '00000000-0000-0000-0000-000000000000',
      userUuid: '84c0f8e8-544a-4c7e-9adf-26209303bc1d',
    } as ItemDeletedEvent['payload']
  })

  it('should delete the revisions of the deleted item', async () => {
    await createHandler().handle(event)

    expect(deleteRevisions.execute).toHaveBeenCalledWith({ itemUuid: '00000000-0000-0000-0000-000000000000' })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('should log a safe failure classification when the revisions cannot be deleted', async () => {
    deleteRevisions.execute = jest.fn().mockResolvedValue(Result.fail('Oops'))

    await createHandler().handle(event)

    expect(logger.error).toHaveBeenCalledWith(
      'Could not delete revisions for item 00000000-0000-0000-0000-000000000000.',
      expect.objectContaining({
        errorType: 'Error',
        userId: '84c0f8e8-544a-4c7e-9adf-26209303bc1d',
      }),
    )
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('Oops')
  })
})
