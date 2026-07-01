import { Webhook } from '../../Webhook/Webhook'
import { WebhookProps } from '../../Webhook/WebhookProps'
import { WebhookRepositoryInterface } from '../../Webhook/WebhookRepositoryInterface'

import { DeleteWebhook } from './DeleteWebhook'

describe('DeleteWebhook', () => {
  let webhookRepository: WebhookRepositoryInterface

  const userUuid = '00000000-0000-0000-0000-000000000000'
  const otherUserUuid = '11111111-1111-1111-1111-111111111111'
  const webhookId = 'webhook-1'

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

  const createUseCase = () => new DeleteWebhook(webhookRepository)

  beforeEach(() => {
    webhookRepository = {} as jest.Mocked<WebhookRepositoryInterface>
    webhookRepository.findById = jest.fn().mockResolvedValue(makeWebhook())
    webhookRepository.remove = jest.fn().mockResolvedValue(undefined)
  })

  it('should fail when the user uuid is invalid', async () => {
    const result = await createUseCase().execute({ userUuid: 'not-a-uuid', webhookId })

    expect(result.isFailed()).toBe(true)
    expect(webhookRepository.remove).not.toHaveBeenCalled()
  })

  it('should fail when the webhook does not exist', async () => {
    webhookRepository.findById = jest.fn().mockResolvedValue(null)

    const result = await createUseCase().execute({ userUuid, webhookId })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('Webhook not found')
    expect(webhookRepository.remove).not.toHaveBeenCalled()
  })

  it('should delete a webhook owned by the requesting user', async () => {
    const result = await createUseCase().execute({ userUuid, webhookId })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toEqual('Webhook deleted')
    expect(webhookRepository.remove).toHaveBeenCalledTimes(1)
  })

  it('should hide another user\'s webhook from a non-admin (reported as not found)', async () => {
    webhookRepository.findById = jest.fn().mockResolvedValue(makeWebhook({ userUuid: otherUserUuid }))

    const result = await createUseCase().execute({ userUuid, webhookId })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('Webhook not found')
    expect(webhookRepository.remove).not.toHaveBeenCalled()
  })

  it('should allow an admin to delete a webhook they do not own', async () => {
    webhookRepository.findById = jest.fn().mockResolvedValue(makeWebhook({ userUuid: otherUserUuid }))

    const result = await createUseCase().execute({ userUuid, webhookId, isAdmin: true })

    expect(result.isFailed()).toBe(false)
    expect(webhookRepository.remove).toHaveBeenCalledTimes(1)
  })

  it('should allow an admin to delete a global webhook', async () => {
    webhookRepository.findById = jest.fn().mockResolvedValue(makeWebhook({ userUuid: null }))

    const result = await createUseCase().execute({ userUuid, webhookId, isAdmin: true })

    expect(result.isFailed()).toBe(false)
    expect(webhookRepository.remove).toHaveBeenCalledTimes(1)
  })
})
