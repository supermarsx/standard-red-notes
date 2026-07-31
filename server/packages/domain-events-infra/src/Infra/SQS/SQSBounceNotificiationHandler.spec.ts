import 'reflect-metadata'

import { Logger } from 'winston'

import { DomainEventHandlerInterface } from '@standardnotes/domain-events'

import { SQSBounceNotificiationHandler } from './SQSBounceNotificiationHandler'

describe('SQSBounceNotificiationHandler', () => {
  let handler: jest.Mocked<DomainEventHandlerInterface>
  let handlers: Map<string, DomainEventHandlerInterface>
  let logger: jest.Mocked<Logger>

  const createHandler = () => new SQSBounceNotificiationHandler(handlers, logger)

  /** An SES bounce notification as it arrives via SNS -> SQS. */
  const sesNotification = (notification: unknown): string => JSON.stringify({ Message: JSON.stringify(notification) })

  const bounceNotification = {
    notificationType: 'Bounce',
    bounce: {
      bounceType: 'Permanent',
      bounceSubType: 'General',
      bouncedRecipients: [{ emailAddress: 'bounced@example.com', diagnosticCode: 'smtp; 550 user unknown' }],
    },
  }

  beforeEach(() => {
    handler = {} as jest.Mocked<DomainEventHandlerInterface>
    handler.handle = jest.fn().mockResolvedValue(undefined)

    handlers = new Map([['EMAIL_BOUNCED', handler]])

    logger = {} as jest.Mocked<Logger>
    logger.debug = jest.fn()
    logger.error = jest.fn()
  })

  it('emits an EMAIL_BOUNCED event carrying the bounce classification and recipient', async () => {
    await createHandler().handleMessage(sesNotification(bounceNotification))

    expect(handler.handle).toHaveBeenCalledTimes(1)
    const event = handler.handle.mock.calls[0][0]
    expect(event.type).toEqual('EMAIL_BOUNCED')
    expect(event.payload).toEqual({
      bounceType: 'Permanent',
      bounceSubType: 'General',
      recipientEmail: 'bounced@example.com',
      diagnosticCode: 'smtp; 550 user unknown',
    })
  })

  it('correlates the event to the bounced address and marks SES as the origin', async () => {
    await createHandler().handleMessage(sesNotification(bounceNotification))

    const event = handler.handle.mock.calls[0][0]
    expect(event.meta.correlation).toEqual({
      userIdentifier: 'bounced@example.com',
      userIdentifierType: 'email',
    })
    expect(event.meta.origin).toEqual('ses')
    expect(event.createdAt).toBeInstanceOf(Date)
  })

  it('emits one event per bounced recipient', async () => {
    await createHandler().handleMessage(
      sesNotification({
        ...bounceNotification,
        bounce: {
          ...bounceNotification.bounce,
          bouncedRecipients: [
            { emailAddress: 'first@example.com', diagnosticCode: 'a' },
            { emailAddress: 'second@example.com', diagnosticCode: 'b' },
          ],
        },
      }),
    )

    expect(handler.handle).toHaveBeenCalledTimes(2)
    expect(handler.handle.mock.calls.map((call) => call[0].payload.recipientEmail)).toEqual([
      'first@example.com',
      'second@example.com',
    ])
  })

  it('rejects a notification type other than Bounce', async () => {
    await createHandler().handleMessage(sesNotification({ notificationType: 'Complaint' }))

    expect(handler.handle).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith('Received notification of type Complaint which is not allowed')
  })

  it('does nothing when there are no bounced recipients', async () => {
    await createHandler().handleMessage(
      sesNotification({ ...bounceNotification, bounce: { ...bounceNotification.bounce, bouncedRecipients: [] } }),
    )

    expect(handler.handle).not.toHaveBeenCalled()
  })

  it('logs and stops when no EMAIL_BOUNCED handler is registered', async () => {
    handlers = new Map()

    await createHandler().handleMessage(sesNotification(bounceNotification))

    expect(logger.debug).toHaveBeenCalledWith('Event handler for event type EMAIL_BOUNCED does not exist')
  })

  it('throws on a message that is not a valid SES envelope', async () => {
    await expect(createHandler().handleMessage('not-json')).rejects.toThrow()
  })

  it('logs a safe classification for an error passed to handleError', async () => {
    const error = new Error('subscriber failure')

    await createHandler().handleError(error)

    expect(logger.error).toHaveBeenCalledWith(
      'Error occurred while handling an SQS message.',
      expect.objectContaining({ errorType: 'Error' }),
    )
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('subscriber failure')
  })
})
