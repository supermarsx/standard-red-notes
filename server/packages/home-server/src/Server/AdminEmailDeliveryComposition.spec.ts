import { resolveBundledAdminEmailDeliveryService } from './AdminEmailDeliveryComposition'

describe('resolveBundledAdminEmailDeliveryService', () => {
  const identifier = Symbol.for('ApiGateway_AdminEmailDeliveryService')
  const service = { viewRelays: jest.fn(), listQueue: jest.fn() }

  it('hands over the service the bundle actually built', () => {
    // The mount used to pass a hardcoded `undefined`, so a bundle configured
    // with CACHE_TYPE=redis ran a real queue, a real worker and this service
    // while /relays, /queue and /logs all answered 501.
    const container = { isBound: jest.fn().mockReturnValue(true), get: jest.fn().mockReturnValue(service) }

    expect(resolveBundledAdminEmailDeliveryService(container, identifier)).toBe(service)
    expect(container.isBound).toHaveBeenCalledWith(identifier)
    expect(container.get).toHaveBeenCalledWith(identifier)
  })

  it('resolves to nothing when no service is bound, so 501 stays the true answer', () => {
    // On CACHE_TYPE=memory there genuinely is no queue.
    const container = { isBound: jest.fn().mockReturnValue(false), get: jest.fn() }

    expect(resolveBundledAdminEmailDeliveryService(container, identifier)).toBeUndefined()
    expect(container.get).not.toHaveBeenCalled()
  })
})
