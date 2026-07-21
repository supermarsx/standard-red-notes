import 'reflect-metadata'
import { Result } from '@standardnotes/domain-core'
import { ItemRevisionCreationRequestedEvent } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { DumpItem } from '../UseCase/Syncing/DumpItem/DumpItem'

import { ItemRevisionCreationRequestedEventHandler } from './ItemRevisionCreationRequestedEventHandler'

describe('ItemRevisionCreationRequestedEventHandler', () => {
  let dumpItem: DumpItem
  let logger: Logger

  const itemUuid = '00000000-0000-0000-0000-000000000001'

  const createHandler = () => new ItemRevisionCreationRequestedEventHandler(dumpItem, logger)

  const event = () => ({ payload: { itemUuid } }) as jest.Mocked<ItemRevisionCreationRequestedEvent>

  beforeEach(() => {
    dumpItem = {} as jest.Mocked<DumpItem>
    dumpItem.execute = jest.fn().mockResolvedValue(Result.ok())

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
  })

  it('dumps the item the revision was requested for', async () => {
    await createHandler().handle(event())

    expect(dumpItem.execute).toHaveBeenCalledWith({ itemUuid })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('logs the failure when the item could not be dumped', async () => {
    dumpItem.execute = jest.fn().mockResolvedValue(Result.fail('Could not find item'))

    await createHandler().handle(event())

    expect(logger.error).toHaveBeenCalledWith('Item revision requested handler failed: Could not find item')
  })
})
