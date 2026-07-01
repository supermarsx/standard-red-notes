jest.mock('@standardnotes/domain-core', () => {
  const actual = jest.requireActual('@standardnotes/domain-core')

  return {
    ...actual,
    assertPublicHttpUrl: jest.fn(),
  }
})

import { assertPublicHttpUrl, SsrfValidationError } from '@standardnotes/domain-core'

import { Webhook } from '../../Webhook/Webhook'
import { WebhookRepositoryInterface } from '../../Webhook/WebhookRepositoryInterface'

import { RegisterWebhook } from './RegisterWebhook'
import { RegisterWebhookDTO } from './RegisterWebhookDTO'

describe('RegisterWebhook', () => {
  let webhookRepository: WebhookRepositoryInterface

  const userUuid = '00000000-0000-0000-0000-000000000000'

  const validDto: RegisterWebhookDTO = {
    userUuid,
    targetUrl: 'https://example.com/hook',
    events: ['item.created'],
  }

  const createUseCase = () => new RegisterWebhook(webhookRepository)

  beforeEach(() => {
    ;(assertPublicHttpUrl as jest.Mock).mockReset()
    ;(assertPublicHttpUrl as jest.Mock).mockResolvedValue(undefined)

    webhookRepository = {} as jest.Mocked<WebhookRepositoryInterface>
    webhookRepository.save = jest.fn().mockResolvedValue(undefined)
  })

  it('should fail when the user uuid is invalid', async () => {
    const result = await createUseCase().execute({ ...validDto, userUuid: 'not-a-uuid' })

    expect(result.isFailed()).toBe(true)
    expect(webhookRepository.save).not.toHaveBeenCalled()
  })

  it('should fail when the target URL is empty or whitespace', async () => {
    const result = await createUseCase().execute({ ...validDto, targetUrl: '   ' })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('Could not register webhook: a target URL is required.')
  })

  it('should fail when no events are provided', async () => {
    const result = await createUseCase().execute({ ...validDto, events: [] })

    expect(result.isFailed()).toBe(true)
    expect(webhookRepository.save).not.toHaveBeenCalled()
  })

  it('should fail when an event is unknown', async () => {
    const result = await createUseCase().execute({ ...validDto, events: ['item.created', 'bogus'] })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual("Could not register webhook: unknown event 'bogus'.")
  })

  it('should fail with a safe message when the SSRF guard rejects the target', async () => {
    ;(assertPublicHttpUrl as jest.Mock).mockRejectedValue(new SsrfValidationError('The requested host is not allowed.', 'blocked-host'))

    const result = await createUseCase().execute(validDto)

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('Could not register webhook: The requested host is not allowed.')
    expect(webhookRepository.save).not.toHaveBeenCalled()
  })

  it('should fail generically when the target URL validation throws a non-SSRF error', async () => {
    ;(assertPublicHttpUrl as jest.Mock).mockRejectedValue(new Error('boom'))

    const result = await createUseCase().execute(validDto)

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('Could not register webhook: the target URL could not be validated.')
  })

  it('should register a user-scoped webhook and return the one-time secret', async () => {
    const result = await createUseCase().execute(validDto)

    expect(result.isFailed()).toBe(false)
    const value = result.getValue()

    expect(webhookRepository.save).toHaveBeenCalledTimes(1)
    const saved = (webhookRepository.save as jest.Mock).mock.calls[0][0] as Webhook

    expect(value.uuid).toEqual(saved.id.toString())
    expect(value.userUuid).toEqual(userUuid)
    expect(value.targetUrl).toEqual('https://example.com/hook')
    expect(value.events).toEqual(['item.created'])
    expect(value.enabled).toBe(true)
    // 32 bytes hex-encoded => 64 hex chars.
    expect(value.secret).toMatch(/^[0-9a-f]{64}$/)
    expect(saved.props.secret).toEqual(value.secret)
  })

  it('should trim the target URL before persisting', async () => {
    const result = await createUseCase().execute({ ...validDto, targetUrl: '  https://example.com/hook  ' })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue().targetUrl).toEqual('https://example.com/hook')
  })

  it('should persist a null user uuid for a global webhook', async () => {
    const result = await createUseCase().execute({ ...validDto, global: true })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue().userUuid).toBeNull()

    const saved = (webhookRepository.save as jest.Mock).mock.calls[0][0] as Webhook
    expect(saved.props.userUuid).toBeNull()
  })

  it('should generate a distinct secret on each registration', async () => {
    const first = (await createUseCase().execute(validDto)).getValue()
    const second = (await createUseCase().execute(validDto)).getValue()

    expect(first.secret).not.toEqual(second.secret)
  })
})
