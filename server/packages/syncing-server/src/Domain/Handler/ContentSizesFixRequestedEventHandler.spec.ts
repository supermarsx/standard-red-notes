import 'reflect-metadata'
import { Result } from '@standardnotes/domain-core'
import { ContentSizesFixRequestedEvent } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { FixContentSizes } from '../UseCase/Syncing/FixContentSizes/FixContentSizes'

import { ContentSizesFixRequestedEventHandler } from './ContentSizesFixRequestedEventHandler'

describe('ContentSizesFixRequestedEventHandler', () => {
  let fixContentSizes: FixContentSizes
  let logger: Logger

  const userUuid = '00000000-0000-0000-0000-000000000001'

  const createHandler = () => new ContentSizesFixRequestedEventHandler(fixContentSizes, logger)

  const event = () => ({ payload: { userUuid } }) as jest.Mocked<ContentSizesFixRequestedEvent>

  beforeEach(() => {
    fixContentSizes = {} as jest.Mocked<FixContentSizes>
    fixContentSizes.execute = jest.fn().mockResolvedValue(Result.ok())

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
    logger.info = jest.fn()
  })

  it('fixes the content sizes for the user in the event', async () => {
    await createHandler().handle(event())

    expect(fixContentSizes.execute).toHaveBeenCalledWith({ userUuid })
    expect(logger.info).toHaveBeenCalledWith('Finished fixing content sizes', { userId: userUuid })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('does not report completion when fixing the content sizes failed', async () => {
    fixContentSizes.execute = jest.fn().mockResolvedValue(Result.fail('Oops'))

    await createHandler().handle(event())

    expect(logger.error).toHaveBeenCalledWith(
      'Failed to fix content sizes.',
      expect.objectContaining({ errorType: 'Error', userId: userUuid }),
    )
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('Oops')
    expect(logger.info).not.toHaveBeenCalled()
  })
})
