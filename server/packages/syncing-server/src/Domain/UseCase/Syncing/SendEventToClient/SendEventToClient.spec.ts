import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  DomainEventInterface,
  DomainEventPublisherInterface,
  WebSocketMessageRequestedEvent,
} from '@standardnotes/domain-events'
import { DomainEventFactoryInterface } from '../../../Event/DomainEventFactoryInterface'
import { SendEventToClient } from './SendEventToClient'
import { Logger } from 'winston'

describe('SendEventToClient', () => {
  let domainEventFactory: DomainEventFactoryInterface
  let domainEventPublisher: DomainEventPublisherInterface
  let logger: Logger

  const createUseCase = () => new SendEventToClient(domainEventFactory, domainEventPublisher, logger)

  beforeEach(() => {
    logger = {} as jest.Mocked<Logger>
    logger.info = jest.fn()
    logger.debug = jest.fn()
    logger.error = jest.fn()

    domainEventFactory = {} as jest.Mocked<DomainEventFactoryInterface>
    domainEventFactory.createWebSocketMessageRequestedEvent = jest
      .fn()
      .mockReturnValue({} as jest.Mocked<WebSocketMessageRequestedEvent>)

    domainEventPublisher = {} as jest.Mocked<DomainEventPublisherInterface>
    domainEventPublisher.publish = jest.fn()
  })

  it('should publish a WebSocketMessageRequestedEvent', async () => {
    const useCase = createUseCase()

    await useCase.execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      event: {
        type: 'test',
      } as jest.Mocked<DomainEventInterface>,
    })

    expect(domainEventFactory.createWebSocketMessageRequestedEvent).toHaveBeenCalledWith({
      userUuid: '00000000-0000-0000-0000-000000000000',
      message: JSON.stringify({
        type: 'test',
      }),
    })
    expect(domainEventPublisher.publish).toHaveBeenCalledWith({} as jest.Mocked<WebSocketMessageRequestedEvent>)
  })

  it('should return a failed result if user uuid is invalid', async () => {
    const useCase = createUseCase()

    const result = await useCase.execute({
      userUuid: 'invalid',
      event: {
        type: 'test',
      } as jest.Mocked<DomainEventInterface>,
    })

    expect(result.isFailed()).toBe(true)
  })

  it('should return a failed result if error is thrown', async () => {
    const useCase = createUseCase()

    domainEventFactory.createWebSocketMessageRequestedEvent = jest.fn().mockImplementation(() => {
      throw new Error('test')
    })

    const result = await useCase.execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      event: {
        type: 'test',
      } as jest.Mocked<DomainEventInterface>,
    })

    expect(result.isFailed()).toBe(true)
  })
})

describe('WEB_SOCKET_MESSAGE_REQUESTED wire contract', () => {
  // The producer leg of the shared fixture. The home-server bridge publishes
  // this payload verbatim and the websocket-gateway parses it, and both assert
  // the same file, so no package on the push path can drift alone.
  const fixture = JSON.parse(
    readFileSync(
      resolve(__dirname, '../../../../../../websocket-gateway/test/fixtures/websocket-message-requested.json'),
      'utf8',
    ),
  ) as {
    type: string
    channel: string
    payload: { userUuid: string; message: string; originatingSessionUuid: string }
  }

  it('asks the factory for the exact payload the gateway consumes', async () => {
    const logger = { info: jest.fn(), debug: jest.fn(), error: jest.fn() } as unknown as jest.Mocked<Logger>
    const domainEventFactory = {
      createWebSocketMessageRequestedEvent: jest.fn().mockReturnValue({} as WebSocketMessageRequestedEvent),
    } as unknown as jest.Mocked<DomainEventFactoryInterface>
    const domainEventPublisher = { publish: jest.fn() } as unknown as jest.Mocked<DomainEventPublisherInterface>

    const result = await new SendEventToClient(domainEventFactory, domainEventPublisher, logger).execute({
      userUuid: fixture.payload.userUuid,
      event: JSON.parse(fixture.payload.message) as DomainEventInterface,
    })

    expect(result.isFailed()).toBe(false)
    // `message` is the serialized inner event; the gateway forwards this string
    // to the socket untouched, so its exact shape is the contract.
    expect(domainEventFactory.createWebSocketMessageRequestedEvent).toHaveBeenCalledWith({
      userUuid: fixture.payload.userUuid,
      message: fixture.payload.message,
    })
  })

  it('pins the fixture to the event type and payload keys the push path agrees on', () => {
    // Without these the test above would only prove the fixture is consistent
    // with itself: it feeds the producer from the same file it asserts against.
    expect(fixture.type).toBe('WEB_SOCKET_MESSAGE_REQUESTED')
    expect(fixture.channel).toBe('websocket-messages')
    expect(Object.keys(fixture.payload).sort()).toEqual(['message', 'originatingSessionUuid', 'userUuid'])
    // The producer hands the factory exactly two of those three keys; the
    // originating session is added by the caller that knows the session.
    expect(Object.keys(JSON.parse(fixture.payload.message))).toEqual(['type'])
    expect(JSON.parse(fixture.payload.message).type).toBe('ITEMS_CHANGED_ON_SERVER')
  })
})
