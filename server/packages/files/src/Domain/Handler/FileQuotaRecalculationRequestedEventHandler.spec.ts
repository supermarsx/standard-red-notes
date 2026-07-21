import 'reflect-metadata'
import { Result } from '@standardnotes/domain-core'
import { FileQuotaRecalculationRequestedEvent } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { RecalculateQuota } from '../UseCase/RecalculateQuota/RecalculateQuota'

import { FileQuotaRecalculationRequestedEventHandler } from './FileQuotaRecalculationRequestedEventHandler'

describe('FileQuotaRecalculationRequestedEventHandler', () => {
  let recalculateQuota: RecalculateQuota
  let logger: Logger

  const userUuid = '00000000-0000-0000-0000-000000000001'

  const createHandler = () => new FileQuotaRecalculationRequestedEventHandler(recalculateQuota, logger)

  const event = () => ({ payload: { userUuid } }) as jest.Mocked<FileQuotaRecalculationRequestedEvent>

  beforeEach(() => {
    recalculateQuota = {} as jest.Mocked<RecalculateQuota>
    recalculateQuota.execute = jest.fn().mockResolvedValue(Result.ok())

    logger = {} as jest.Mocked<Logger>
    logger.info = jest.fn()
    logger.error = jest.fn()
  })

  it('recalculates the quota for the user in the event', async () => {
    await createHandler().handle(event())

    expect(recalculateQuota.execute).toHaveBeenCalledWith({ userUuid })
    expect(logger.info).toHaveBeenCalledWith('Quota recalculated', { userId: userUuid })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('does not report the quota as recalculated when the use case failed', async () => {
    recalculateQuota.execute = jest.fn().mockResolvedValue(Result.fail('Oops'))

    await createHandler().handle(event())

    expect(logger.error).toHaveBeenCalledWith('Could not recalculate quota', { userId: userUuid })
    expect(logger.info).not.toHaveBeenCalledWith('Quota recalculated', { userId: userUuid })
  })
})
