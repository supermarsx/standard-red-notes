import { WebApplication } from '@/Application/WebApplication'
import {
  channelLabel,
  destinationHint,
  destinationLabel,
  destinationPlaceholder,
  isDeliveryChannel,
  maybePublishReminderForDelivery,
  maybeUnpublishReminderForDelivery,
  resetReminderDeliveryStateCacheForTests,
  validateDestination,
} from './reminderDelivery'

/**
 * Standard Red Notes: tests for the pure reminder-delivery helpers (channel
 * labels + destination validation) and for the automatic publish/unpublish gate
 * NotesController fires on every reminder save/clear. The remaining API/settings
 * wrappers are thin error-swallowing pass-throughs.
 */

describe('reminderDelivery pure helpers', () => {
  describe('channelLabel', () => {
    it('maps each channel to a human label', () => {
      expect(channelLabel('whatsapp')).toBe('WhatsApp')
      expect(channelLabel('telegram')).toBe('Telegram')
      expect(channelLabel('email')).toBe('Email')
    })
  })

  describe('destinationLabel / destinationPlaceholder', () => {
    it('gives a channel-appropriate label', () => {
      expect(destinationLabel('whatsapp')).toBe('Phone number')
      expect(destinationLabel('telegram')).toBe('Telegram chat ID')
      expect(destinationLabel('email')).toBe('Email address')
    })

    it('gives a channel-appropriate placeholder', () => {
      expect(destinationPlaceholder('whatsapp')).toContain('+')
      expect(destinationPlaceholder('email')).toContain('@')
      expect(destinationPlaceholder('telegram')).toMatch(/[0-9]/)
    })
  })

  describe('isDeliveryChannel', () => {
    it('accepts the three real channels and rejects anything else', () => {
      expect(isDeliveryChannel('whatsapp')).toBe(true)
      expect(isDeliveryChannel('telegram')).toBe(true)
      expect(isDeliveryChannel('email')).toBe(true)
      expect(isDeliveryChannel('sms')).toBe(false)
      expect(isDeliveryChannel(undefined)).toBe(false)
      expect(isDeliveryChannel(42)).toBe(false)
    })
  })

  describe('validateDestination', () => {
    it('requires a non-empty destination', () => {
      expect(validateDestination('whatsapp', '')).toMatch(/required/i)
      expect(validateDestination('email', '   ')).toMatch(/required/i)
    })

    it('validates WhatsApp phone numbers', () => {
      expect(validateDestination('whatsapp', '+15551234567')).toBeNull()
      expect(validateDestination('whatsapp', '15551234567')).toBeNull()
      expect(validateDestination('whatsapp', '+1 555 123')).not.toBeNull()
      expect(validateDestination('whatsapp', 'abc')).not.toBeNull()
      expect(validateDestination('whatsapp', '123')).not.toBeNull()
    })

    it('validates Telegram chat ids as numeric (optionally negative)', () => {
      expect(validateDestination('telegram', '123456789')).toBeNull()
      expect(validateDestination('telegram', '-1001234567890')).toBeNull()
      expect(validateDestination('telegram', '@handle')).not.toBeNull()
      expect(validateDestination('telegram', '12.3')).not.toBeNull()
    })

    it('validates email addresses', () => {
      expect(validateDestination('email', 'you@example.com')).toBeNull()
      expect(validateDestination('email', 'not-an-email')).not.toBeNull()
      expect(validateDestination('email', 'a@b')).not.toBeNull()
    })
  })

  describe('destinationHint', () => {
    it('gives a channel-appropriate hint', () => {
      expect(destinationHint('whatsapp')).toMatch(/country code/i)
      expect(destinationHint('telegram')).toMatch(/chat id/i)
      expect(destinationHint('email')).toMatch(/email address/i)
    })
  })
})

describe('automatic publish/unpublish gate', () => {
  const okResponse = (data: unknown) => ({ status: 200, data })
  const errorResponse = () => ({ status: 403, data: { error: { message: 'nope' } } })

  type LegacyApiMock = {
    getReminderDeliveryDeliveryConfig: jest.Mock
    publishReminderDelivery: jest.Mock
    deleteReminderDelivery: jest.Mock
  }

  const makeApplication = (opts: { hasAccount?: boolean; legacyApi?: Partial<LegacyApiMock> }): WebApplication =>
    ({
      hasAccount: () => opts.hasAccount ?? true,
      legacyApi: {
        getReminderDeliveryDeliveryConfig: jest.fn(),
        publishReminderDelivery: jest.fn(),
        deleteReminderDelivery: jest.fn(),
        ...opts.legacyApi,
      },
    }) as unknown as WebApplication

  const enabledConfig = { config: { channel: 'telegram', destination: '123', enabled: true } }
  const disabledConfig = { config: { channel: 'telegram', destination: '123', enabled: false } }
  const reminder = { id: 'r1', dueAt: '2026-07-02T12:00:00.000Z', message: 'Call Bob' }

  beforeEach(() => {
    resetReminderDeliveryStateCacheForTests()
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  it('publishes when the delivery config is enabled', async () => {
    const app = makeApplication({
      legacyApi: {
        getReminderDeliveryDeliveryConfig: jest.fn().mockResolvedValue(okResponse(enabledConfig)),
        publishReminderDelivery: jest.fn().mockResolvedValue(okResponse({ reminder: {} })),
      },
    })
    await expect(maybePublishReminderForDelivery(app, reminder)).resolves.toBe(true)
    expect(app.legacyApi.publishReminderDelivery).toHaveBeenCalledWith({
      id: 'r1',
      message: 'Call Bob',
      dueAtUtc: '2026-07-02T12:00:00.000Z',
    })
  })

  it('defaults an empty message to "Reminder"', async () => {
    const app = makeApplication({
      legacyApi: {
        getReminderDeliveryDeliveryConfig: jest.fn().mockResolvedValue(okResponse(enabledConfig)),
        publishReminderDelivery: jest.fn().mockResolvedValue(okResponse({ reminder: {} })),
      },
    })
    await maybePublishReminderForDelivery(app, { id: 'r1', dueAt: '2026-07-02T12:00:00.000Z' })
    expect(app.legacyApi.publishReminderDelivery).toHaveBeenCalledWith(expect.objectContaining({ message: 'Reminder' }))
  })

  it('does not publish when the delivery config is disabled', async () => {
    const app = makeApplication({
      legacyApi: {
        getReminderDeliveryDeliveryConfig: jest.fn().mockResolvedValue(okResponse(disabledConfig)),
      },
    })
    await expect(maybePublishReminderForDelivery(app, reminder)).resolves.toBe(false)
    expect(app.legacyApi.publishReminderDelivery).not.toHaveBeenCalled()
  })

  it('does not publish when the config route errors (feature off / not opted in)', async () => {
    const app = makeApplication({
      legacyApi: {
        getReminderDeliveryDeliveryConfig: jest.fn().mockResolvedValue(errorResponse()),
      },
    })
    await expect(maybePublishReminderForDelivery(app, reminder)).resolves.toBe(false)
    expect(app.legacyApi.publishReminderDelivery).not.toHaveBeenCalled()
  })

  it('does nothing without an account', async () => {
    const app = makeApplication({ hasAccount: false })
    await expect(maybePublishReminderForDelivery(app, reminder)).resolves.toBe(false)
    expect(app.legacyApi.getReminderDeliveryDeliveryConfig).not.toHaveBeenCalled()
  })

  it('caches the config decision across calls', async () => {
    const getConfig = jest.fn().mockResolvedValue(okResponse(enabledConfig))
    const app = makeApplication({
      legacyApi: {
        getReminderDeliveryDeliveryConfig: getConfig,
        publishReminderDelivery: jest.fn().mockResolvedValue(okResponse({ reminder: {} })),
      },
    })
    await maybePublishReminderForDelivery(app, reminder)
    await maybePublishReminderForDelivery(app, reminder)
    expect(getConfig).toHaveBeenCalledTimes(1)
    expect(app.legacyApi.publishReminderDelivery).toHaveBeenCalledTimes(2)
  })

  it('degrades silently when everything throws', async () => {
    const app = makeApplication({
      legacyApi: {
        getReminderDeliveryDeliveryConfig: jest.fn().mockRejectedValue(new Error('network')),
      },
    })
    await expect(maybePublishReminderForDelivery(app, reminder)).resolves.toBe(false)
  })

  it('unpublishes when a delivery config exists, even if disabled', async () => {
    const app = makeApplication({
      legacyApi: {
        getReminderDeliveryDeliveryConfig: jest.fn().mockResolvedValue(okResponse(disabledConfig)),
        deleteReminderDelivery: jest.fn().mockResolvedValue(okResponse({ removed: true })),
      },
    })
    await expect(maybeUnpublishReminderForDelivery(app, 'r1')).resolves.toBe(true)
    expect(app.legacyApi.deleteReminderDelivery).toHaveBeenCalledWith('r1')
  })

  it('does not unpublish when no delivery config exists', async () => {
    const app = makeApplication({
      legacyApi: {
        getReminderDeliveryDeliveryConfig: jest.fn().mockResolvedValue(okResponse({ config: null })),
      },
    })
    await expect(maybeUnpublishReminderForDelivery(app, 'r1')).resolves.toBe(false)
    expect(app.legacyApi.deleteReminderDelivery).not.toHaveBeenCalled()
  })
})
