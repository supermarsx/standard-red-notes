import {
  channelLabel,
  destinationLabel,
  destinationPlaceholder,
  isDeliveryChannel,
  validateDestination,
} from './reminderDelivery'

/**
 * Standard Red Notes: tests for the pure reminder-delivery helpers (channel
 * labels + destination validation). The API/settings wrappers are thin
 * error-swallowing pass-throughs; the logic worth pinning down lives here.
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
})
