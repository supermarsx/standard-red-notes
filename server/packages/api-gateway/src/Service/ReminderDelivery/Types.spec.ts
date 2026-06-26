import { formatReminderMessage, isDeliveryChannel, isDue } from './Types'

describe('ReminderDelivery Types', () => {
  describe('isDue', () => {
    const now = new Date('2026-06-25T12:00:00.000Z')

    it('selects an unsent reminder whose dueAtUtc is in the past', () => {
      expect(isDue({ sent: false, dueAtUtc: '2026-06-25T11:59:00.000Z' }, now)).toBe(true)
    })

    it('selects an unsent reminder due exactly now', () => {
      expect(isDue({ sent: false, dueAtUtc: '2026-06-25T12:00:00.000Z' }, now)).toBe(true)
    })

    it('does NOT select a reminder due in the future', () => {
      expect(isDue({ sent: false, dueAtUtc: '2026-06-25T12:00:01.000Z' }, now)).toBe(false)
    })

    it('does NOT select an already-sent reminder even if past due', () => {
      expect(isDue({ sent: true, dueAtUtc: '2026-06-25T11:00:00.000Z' }, now)).toBe(false)
    })

    it('fails closed (not due) on an unparseable timestamp', () => {
      expect(isDue({ sent: false, dueAtUtc: 'not-a-date' }, now)).toBe(false)
    })
  })

  describe('formatReminderMessage', () => {
    it('includes the message and a normalized due time', () => {
      const text = formatReminderMessage({ message: 'Call Bob', dueAtUtc: '2026-06-25T09:30:00.000Z' })
      expect(text).toBe('Reminder (due 2026-06-25T09:30:00Z): Call Bob')
    })

    it('trims the message', () => {
      const text = formatReminderMessage({ message: '  spaced  ', dueAtUtc: '2026-06-25T09:30:00.000Z' })
      expect(text).toContain(': spaced')
    })

    it('omits the body when the message is empty', () => {
      const text = formatReminderMessage({ message: '', dueAtUtc: '2026-06-25T09:30:00.000Z' })
      expect(text).toBe('Reminder (due 2026-06-25T09:30:00Z)')
    })

    it('degrades gracefully on an unparseable due time', () => {
      const text = formatReminderMessage({ message: 'hi', dueAtUtc: 'bad' })
      expect(text).toBe('Reminder: hi')
    })
  })

  describe('isDeliveryChannel', () => {
    it('accepts the three supported channels', () => {
      expect(isDeliveryChannel('telegram')).toBe(true)
      expect(isDeliveryChannel('email')).toBe(true)
      expect(isDeliveryChannel('whatsapp')).toBe(true)
    })

    it('rejects anything else', () => {
      expect(isDeliveryChannel('sms')).toBe(false)
      expect(isDeliveryChannel(undefined)).toBe(false)
      expect(isDeliveryChannel(42)).toBe(false)
    })
  })
})
