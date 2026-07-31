import { Result } from '@standardnotes/domain-core'
import { ItemDumpedEvent } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { CreateRevisionFromDump } from '../UseCase/CreateRevisionFromDump/CreateRevisionFromDump'
import { ItemDumpedEventHandler } from './ItemDumpedEventHandler'

describe('ItemDumpedEventHandler', () => {
  let createRevisionFromDump: CreateRevisionFromDump
  let logger: Logger
  let event: ItemDumpedEvent

  const createHandler = () => new ItemDumpedEventHandler(createRevisionFromDump, logger)

  beforeEach(() => {
    createRevisionFromDump = {} as jest.Mocked<CreateRevisionFromDump>
    createRevisionFromDump.execute = jest.fn().mockResolvedValue(Result.ok())

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()

    event = {} as jest.Mocked<ItemDumpedEvent>
    event.payload = {
      fileDumpPath: '/tmp/dumps/item.json',
    } as ItemDumpedEvent['payload']
  })

  it('should create a revision from the dumped file', async () => {
    await createHandler().handle(event)

    expect(createRevisionFromDump.execute).toHaveBeenCalledWith({ filePath: '/tmp/dumps/item.json' })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('should log a safe failure classification when the revision cannot be created', async () => {
    createRevisionFromDump.execute = jest.fn().mockResolvedValue(Result.fail('Could not read the dump'))

    await createHandler().handle(event)

    expect(logger.error).toHaveBeenCalledWith(
      'Item dumped event handler failed.',
      expect.objectContaining({ errorType: 'Error' }),
    )
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('Could not read the dump')
  })
})
