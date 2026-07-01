import { AxiosInstance } from 'axios'
import { Logger } from 'winston'

jest.mock('@standardnotes/domain-core', () => {
  const actual = jest.requireActual('@standardnotes/domain-core')

  return {
    ...actual,
    assertPublicHttpUrl: jest.fn(),
  }
})

import { assertPublicHttpUrl, SsrfValidationError } from '@standardnotes/domain-core'

import { Webhook } from '../../Domain/Webhook/Webhook'
import { WebhookProps } from '../../Domain/Webhook/WebhookProps'
import { WebhookRepositoryInterface } from '../../Domain/Webhook/WebhookRepositoryInterface'
import { computeWebhookSignature, verifyWebhookSignature } from '../../Domain/Webhook/WebhookSignature'

import { WebhookDispatcher } from './WebhookDispatcher'

describe('WebhookDispatcher', () => {
  let webhookRepository: WebhookRepositoryInterface
  let httpClient: AxiosInstance
  let logger: Logger

  const userA = '00000000-0000-0000-0000-00000000000a'
  const userB = '00000000-0000-0000-0000-00000000000b'

  const makeWebhook = (overrides: Partial<WebhookProps> = {}): Webhook =>
    Webhook.create({
      userUuid: userA,
      targetUrl: 'https://example.com/hook',
      events: ['item.created'],
      secret: 'shared-secret',
      enabled: true,
      createdAt: new Date(),
      ...overrides,
    }).getValue()

  const createDispatcher = () => new WebhookDispatcher(webhookRepository, httpClient, logger)

  beforeEach(() => {
    ;(assertPublicHttpUrl as jest.Mock).mockReset()
    ;(assertPublicHttpUrl as jest.Mock).mockResolvedValue(undefined)

    webhookRepository = {} as jest.Mocked<WebhookRepositoryInterface>
    webhookRepository.findAllEnabled = jest.fn().mockResolvedValue([])

    httpClient = { request: jest.fn().mockResolvedValue({ status: 200 }) } as unknown as AxiosInstance

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
    logger.warn = jest.fn()
    logger.info = jest.fn()
  })

  it('should not call the http client when there are no matching webhooks', async () => {
    webhookRepository.findAllEnabled = jest.fn().mockResolvedValue([makeWebhook({ events: ['user.login'] })])

    await createDispatcher().dispatch('item.created', { userUuid: userA })

    expect(httpClient.request).not.toHaveBeenCalled()
  })

  it('should log and swallow a repository failure without calling the http client', async () => {
    webhookRepository.findAllEnabled = jest.fn().mockRejectedValue(new Error('db down'))

    await expect(createDispatcher().dispatch('item.created', { userUuid: userA })).resolves.toBeUndefined()

    expect(logger.error).toHaveBeenCalled()
    expect(httpClient.request).not.toHaveBeenCalled()
  })

  it('should deliver only to enabled, subscribed and matching webhooks', async () => {
    const matching = makeWebhook({ targetUrl: 'https://match.example.com' })
    const wrongEvent = makeWebhook({ targetUrl: 'https://wrong-event.example.com', events: ['user.login'] })
    const otherUser = makeWebhook({ targetUrl: 'https://other-user.example.com', userUuid: userB })

    webhookRepository.findAllEnabled = jest.fn().mockResolvedValue([matching, wrongEvent, otherUser])

    await createDispatcher().dispatch('item.created', { userUuid: userA })

    expect(httpClient.request).toHaveBeenCalledTimes(1)
    expect((httpClient.request as jest.Mock).mock.calls[0][0].url).toEqual('https://match.example.com')
  })

  it('should deliver to a global webhook regardless of the originating user', async () => {
    const globalWebhook = makeWebhook({ targetUrl: 'https://global.example.com', userUuid: null })

    webhookRepository.findAllEnabled = jest.fn().mockResolvedValue([globalWebhook])

    await createDispatcher().dispatch('item.created', { userUuid: userB })

    expect(httpClient.request).toHaveBeenCalledTimes(1)
    expect((httpClient.request as jest.Mock).mock.calls[0][0].url).toEqual('https://global.example.com')
  })

  it('should POST a signed payload with the SRN headers, no redirects and a 5s timeout', async () => {
    const webhook = makeWebhook()
    webhookRepository.findAllEnabled = jest.fn().mockResolvedValue([webhook])

    await createDispatcher().dispatch('item.created', { userUuid: userA, metadata: { timestamp: 123 } })

    const request = (httpClient.request as jest.Mock).mock.calls[0][0]

    expect(request.method).toEqual('POST')
    expect(request.url).toEqual('https://example.com/hook')
    expect(request.maxRedirects).toEqual(0)
    expect(request.timeout).toEqual(5000)
    expect(request.headers['Content-Type']).toEqual('application/json')
    expect(request.headers['X-SRN-Event']).toEqual('item.created')
    expect(request.headers['X-SRN-Webhook-Id']).toEqual(webhook.id.toString())

    // The signature is computed over the exact serialized body sent.
    const body = request.data as string
    expect(request.headers['X-SRN-Signature']).toEqual(computeWebhookSignature('shared-secret', body))
    expect(verifyWebhookSignature('shared-secret', body, request.headers['X-SRN-Signature'])).toBe(true)

    const payload = JSON.parse(body)
    expect(payload.event).toEqual('item.created')
    expect(payload.userUuid).toEqual(userA)
    expect(payload.data).toEqual({ timestamp: 123 })
    expect(typeof payload.deliveredAt).toEqual('string')
  })

  it('should skip delivery and warn when the SSRF guard rejects the target at delivery time', async () => {
    const webhook = makeWebhook()
    webhookRepository.findAllEnabled = jest.fn().mockResolvedValue([webhook])
    ;(assertPublicHttpUrl as jest.Mock).mockRejectedValue(new SsrfValidationError('blocked', 'blocked-host'))

    await createDispatcher().dispatch('item.created', { userUuid: userA })

    expect(httpClient.request).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('should retry up to MAX_ATTEMPTS=3 and then give up', async () => {
    const webhook = makeWebhook()
    webhookRepository.findAllEnabled = jest.fn().mockResolvedValue([webhook])
    httpClient.request = jest.fn().mockRejectedValue(new Error('connection refused'))

    await createDispatcher().dispatch('item.created', { userUuid: userA })

    expect(httpClient.request).toHaveBeenCalledTimes(3)
    expect(logger.error).toHaveBeenCalled()
  })

  it('should stop retrying once a delivery succeeds', async () => {
    const webhook = makeWebhook()
    webhookRepository.findAllEnabled = jest.fn().mockResolvedValue([webhook])
    httpClient.request = jest
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ status: 200 })

    await createDispatcher().dispatch('item.created', { userUuid: userA })

    expect(httpClient.request).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.error).not.toHaveBeenCalled()
  })
})
