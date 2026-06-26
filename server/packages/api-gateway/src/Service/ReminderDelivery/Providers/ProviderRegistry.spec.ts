import { ProviderRegistry } from './ProviderRegistry'
import { DeliveryChannel, ReminderDeliveryProvider } from '../Types'

const stub = (channel: DeliveryChannel): ReminderDeliveryProvider => ({
  channel,
  send: jest.fn().mockResolvedValue({ ok: true }),
})

describe('ProviderRegistry', () => {
  it('selects the provider matching a channel', () => {
    const telegram = stub('telegram')
    const email = stub('email')
    const whatsapp = stub('whatsapp')
    const registry = new ProviderRegistry([telegram, email, whatsapp])

    expect(registry.get('telegram')).toBe(telegram)
    expect(registry.get('email')).toBe(email)
    expect(registry.get('whatsapp')).toBe(whatsapp)
  })

  it('returns undefined for a channel with no registered adapter', () => {
    const registry = new ProviderRegistry([stub('telegram')])
    expect(registry.get('email')).toBeUndefined()
  })

  it('reports the registered channels', () => {
    const registry = new ProviderRegistry([stub('telegram'), stub('whatsapp')])
    expect(registry.channels().sort()).toEqual(['telegram', 'whatsapp'])
  })
})
