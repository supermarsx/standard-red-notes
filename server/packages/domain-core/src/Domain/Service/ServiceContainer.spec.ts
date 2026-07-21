import { ServiceContainer } from './ServiceContainer'
import { ServiceIdentifier } from './ServiceIdentifier'
import { ServiceInterface } from './ServiceInterface'

describe('ServiceContainer', () => {
  const identifier = (value: string) => ServiceIdentifier.create(value).getValue()

  const createService = (id: string): ServiceInterface => ({
    getContainer: jest.fn(),
    getId: jest.fn().mockReturnValue(identifier(id)),
    handleRequest: jest.fn(),
  })

  it('returns undefined for a service that was never registered', () => {
    expect(new ServiceContainer().get(identifier(ServiceIdentifier.NAMES.Auth))).toBeUndefined()
  })

  it('returns the service registered under an identifier', () => {
    const container = new ServiceContainer()
    const service = createService(ServiceIdentifier.NAMES.Auth)

    container.register(identifier(ServiceIdentifier.NAMES.Auth), service)

    expect(container.get(identifier(ServiceIdentifier.NAMES.Auth))).toBe(service)
  })

  it('keys on the identifier value, so an equal but distinct identifier instance still resolves', () => {
    const container = new ServiceContainer()
    const service = createService(ServiceIdentifier.NAMES.Auth)

    container.register(identifier(ServiceIdentifier.NAMES.Auth), service)

    const lookedUpWithAFreshInstance = container.get(identifier(ServiceIdentifier.NAMES.Auth))

    expect(lookedUpWithAFreshInstance).toBe(service)
  })

  it('keeps services registered under different identifiers separate', () => {
    const container = new ServiceContainer()
    const auth = createService(ServiceIdentifier.NAMES.Auth)
    const syncing = createService(ServiceIdentifier.NAMES.SyncingServer)

    container.register(identifier(ServiceIdentifier.NAMES.Auth), auth)
    container.register(identifier(ServiceIdentifier.NAMES.SyncingServer), syncing)

    expect(container.get(identifier(ServiceIdentifier.NAMES.Auth))).toBe(auth)
    expect(container.get(identifier(ServiceIdentifier.NAMES.SyncingServer))).toBe(syncing)
  })

  it('lets a later registration replace an earlier one for the same identifier', () => {
    const container = new ServiceContainer()
    const first = createService(ServiceIdentifier.NAMES.Auth)
    const second = createService(ServiceIdentifier.NAMES.Auth)

    container.register(identifier(ServiceIdentifier.NAMES.Auth), first)
    container.register(identifier(ServiceIdentifier.NAMES.Auth), second)

    expect(container.get(identifier(ServiceIdentifier.NAMES.Auth))).toBe(second)
  })

  it('does not share registrations between two container instances', () => {
    const container = new ServiceContainer()

    container.register(identifier(ServiceIdentifier.NAMES.Auth), createService(ServiceIdentifier.NAMES.Auth))

    expect(new ServiceContainer().get(identifier(ServiceIdentifier.NAMES.Auth))).toBeUndefined()
  })
})
