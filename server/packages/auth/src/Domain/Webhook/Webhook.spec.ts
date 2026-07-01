import { WebhookProps } from './WebhookProps'
import { Webhook } from './Webhook'

describe('Webhook', () => {
  const userUuid = '00000000-0000-0000-0000-000000000000'

  const validProps = (overrides: Partial<WebhookProps> = {}): WebhookProps => ({
    userUuid,
    targetUrl: 'https://example.com/hook',
    events: ['item.created', 'item.updated'],
    secret: 'a-secret',
    enabled: true,
    createdAt: new Date(),
    ...overrides,
  })

  describe('create', () => {
    it('should create a valid webhook', () => {
      const result = Webhook.create(validProps())

      expect(result.isFailed()).toBe(false)
      expect(result.getValue().props.targetUrl).toEqual('https://example.com/hook')
    })

    it('should fail when the target URL is empty', () => {
      const result = Webhook.create(validProps({ targetUrl: '' }))

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toEqual('Webhook target URL cannot be empty')
    })

    it('should fail when the target URL is longer than 2048 characters', () => {
      const result = Webhook.create(validProps({ targetUrl: `https://example.com/${'a'.repeat(2048)}` }))

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toEqual('Webhook target URL cannot be longer than 2048 characters')
    })

    it('should fail when the target URL is not an http(s) URL', () => {
      const result = Webhook.create(validProps({ targetUrl: 'file:///etc/passwd' }))

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toEqual('Webhook target URL must be an http(s) URL')
    })

    it('should accept an http target URL', () => {
      const result = Webhook.create(validProps({ targetUrl: 'http://example.com/hook' }))

      expect(result.isFailed()).toBe(false)
    })

    it('should fail when there are no events', () => {
      const result = Webhook.create(validProps({ events: [] }))

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toEqual('Webhook must subscribe to at least one event')
    })

    it('should fail when an event is unknown', () => {
      const result = Webhook.create(validProps({ events: ['item.created', 'not.a.real.event'] }))

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toEqual('Unknown webhook event: not.a.real.event')
    })

    it('should fail when the secret is empty', () => {
      const result = Webhook.create(validProps({ secret: '' }))

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toEqual('Webhook secret cannot be empty')
    })
  })

  describe('isSubscribedTo', () => {
    it('should be true for a subscribed event when enabled', () => {
      const webhook = Webhook.create(validProps()).getValue()

      expect(webhook.isSubscribedTo('item.created')).toBe(true)
    })

    it('should be false for an event it is not subscribed to', () => {
      const webhook = Webhook.create(validProps()).getValue()

      expect(webhook.isSubscribedTo('user.login')).toBe(false)
    })

    it('should be false when the webhook is disabled even if subscribed', () => {
      const webhook = Webhook.create(validProps({ enabled: false })).getValue()

      expect(webhook.isSubscribedTo('item.created')).toBe(false)
    })
  })

  describe('isGlobal', () => {
    it('should be true when the user uuid is null', () => {
      const webhook = Webhook.create(validProps({ userUuid: null })).getValue()

      expect(webhook.isGlobal()).toBe(true)
    })

    it('should be false when the webhook is scoped to a user', () => {
      const webhook = Webhook.create(validProps()).getValue()

      expect(webhook.isGlobal()).toBe(false)
    })
  })
})
