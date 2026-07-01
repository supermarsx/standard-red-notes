import { Webhook } from '../../Webhook/Webhook'
import { WebhookProps } from '../../Webhook/WebhookProps'
import { WebhookRepositoryInterface } from '../../Webhook/WebhookRepositoryInterface'

import { ListWebhooks } from './ListWebhooks'

describe('ListWebhooks', () => {
  let webhookRepository: WebhookRepositoryInterface

  const userUuid = '00000000-0000-0000-0000-000000000000'

  const makeWebhook = (overrides: Partial<WebhookProps> = {}): Webhook =>
    Webhook.create({
      userUuid,
      targetUrl: 'https://example.com/hook',
      events: ['item.created'],
      secret: 'secret',
      enabled: true,
      createdAt: new Date(),
      ...overrides,
    }).getValue()

  const createUseCase = () => new ListWebhooks(webhookRepository)

  beforeEach(() => {
    webhookRepository = {} as jest.Mocked<WebhookRepositoryInterface>
    webhookRepository.findByUserUuid = jest.fn().mockResolvedValue([])
    webhookRepository.findGlobal = jest.fn().mockResolvedValue([])
  })

  it('should fail when the user uuid is invalid', async () => {
    const result = await createUseCase().execute({ userUuid: 'not-a-uuid' })

    expect(result.isFailed()).toBe(true)
  })

  it("should return the user's own webhooks and not query global ones by default", async () => {
    const userWebhook = makeWebhook()
    webhookRepository.findByUserUuid = jest.fn().mockResolvedValue([userWebhook])

    const result = await createUseCase().execute({ userUuid })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toEqual([userWebhook])
    expect(webhookRepository.findGlobal).not.toHaveBeenCalled()
  })

  it('should include global webhooks ahead of user webhooks when includeGlobal is true', async () => {
    const userWebhook = makeWebhook({ targetUrl: 'https://user.example.com' })
    const globalWebhook = makeWebhook({ targetUrl: 'https://global.example.com', userUuid: null })

    webhookRepository.findByUserUuid = jest.fn().mockResolvedValue([userWebhook])
    webhookRepository.findGlobal = jest.fn().mockResolvedValue([globalWebhook])

    const result = await createUseCase().execute({ userUuid, includeGlobal: true })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toEqual([globalWebhook, userWebhook])
    expect(webhookRepository.findGlobal).toHaveBeenCalledTimes(1)
  })
})
