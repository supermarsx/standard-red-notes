import { WebSocketMessageRequestedEvent } from '@standardnotes/domain-events'
import { Logger } from 'winston'
import { Result } from '@standardnotes/domain-core'

import { SendMessageToClient } from '../UseCase/SendMessageToClient/SendMessageToClient'
import { WebSocketMessageRequestedEventHandler } from './WebSocketMessageRequestedEventHandler'

describe('WebSocketMessageRequestedEventHandler', () => {
  let sendMessageToClient: SendMessageToClient
  let logger: Logger

  const createHandler = () => new WebSocketMessageRequestedEventHandler(sendMessageToClient, logger)

  const createEvent = (payload: Partial<WebSocketMessageRequestedEvent['payload']> = {}) =>
    ({
      payload: {
        userUuid: '00000000-0000-0000-0000-000000000000',
        message: 'message',
        originatingSessionUuid: '11111111-1111-1111-1111-111111111111',
        ...payload,
      },
    }) as WebSocketMessageRequestedEvent

  beforeEach(() => {
    sendMessageToClient = {} as jest.Mocked<SendMessageToClient>
    sendMessageToClient.execute = jest.fn().mockResolvedValue(Result.ok())

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
  })

  it('forwards the user, message and originating session from the event payload to the use case', async () => {
    await createHandler().handle(createEvent())

    expect(sendMessageToClient.execute).toHaveBeenCalledWith({
      userUuid: '00000000-0000-0000-0000-000000000000',
      message: 'message',
      originatingSessionUuid: '11111111-1111-1111-1111-111111111111',
    })
  })

  it('does not log an error when the message is delivered', async () => {
    await createHandler().handle(createEvent())

    expect(logger.error).not.toHaveBeenCalled()
  })

  it('logs a safe error classification together with the user id when delivery fails', async () => {
    sendMessageToClient.execute = jest.fn().mockResolvedValue(Result.fail('connection is gone'))

    await createHandler().handle(createEvent({ userUuid: '22222222-2222-2222-2222-222222222222' }))

    expect(logger.error).toHaveBeenCalledWith(
      'Could not send message to user.',
      expect.objectContaining({
        errorType: 'Error',
        userId: '22222222-2222-2222-2222-222222222222',
      }),
    )
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('connection is gone')
  })

  it('resolves rather than rejecting when the use case fails', async () => {
    sendMessageToClient.execute = jest.fn().mockResolvedValue(Result.fail('boom'))

    await expect(createHandler().handle(createEvent())).resolves.toBeUndefined()
  })
})
