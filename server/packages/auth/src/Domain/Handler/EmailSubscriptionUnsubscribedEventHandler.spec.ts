import { EmailSubscriptionUnsubscribedEvent } from '@standardnotes/domain-events'
import { Result } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { DisableEmailSettingBasedOnEmailSubscription } from '../UseCase/DisableEmailSettingBasedOnEmailSubscription/DisableEmailSettingBasedOnEmailSubscription'

import { EmailSubscriptionUnsubscribedEventHandler } from './EmailSubscriptionUnsubscribedEventHandler'

describe('EmailSubscriptionUnsubscribedEventHandler', () => {
  let disableEmailSettingBasedOnEmailSubscription: DisableEmailSettingBasedOnEmailSubscription
  let logger: Logger

  const userEmail = 'user@example.com'
  const level = 'system'

  const event = {
    payload: { userEmail, level },
  } as unknown as jest.Mocked<EmailSubscriptionUnsubscribedEvent>

  const createHandler = () =>
    new EmailSubscriptionUnsubscribedEventHandler(disableEmailSettingBasedOnEmailSubscription, logger)

  beforeEach(() => {
    disableEmailSettingBasedOnEmailSubscription = {} as jest.Mocked<DisableEmailSettingBasedOnEmailSubscription>
    disableEmailSettingBasedOnEmailSubscription.execute = jest.fn().mockResolvedValue(Result.ok('disabled'))

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
  })

  it('should disable the email setting for the unsubscribed level', async () => {
    await createHandler().handle(event)

    expect(disableEmailSettingBasedOnEmailSubscription.execute).toHaveBeenCalledWith({ userEmail, level })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('should log an error if the setting could not be disabled', async () => {
    disableEmailSettingBasedOnEmailSubscription.execute = jest.fn().mockResolvedValue(Result.fail('nope'))

    await createHandler().handle(event)

    expect(logger.error).toHaveBeenCalledWith('Failed to disable email setting for user: nope', { userId: userEmail })
  })
})
