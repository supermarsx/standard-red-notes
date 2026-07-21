import { ControllerContainer } from './ControllerContainer'

describe('ControllerContainer', () => {
  const binding = () => Promise.resolve('handled')

  it('returns undefined for an identifier that was never registered', () => {
    expect(new ControllerContainer().get('auth.users.get')).toBeUndefined()
  })

  it('returns the binding registered under an identifier', () => {
    const container = new ControllerContainer()

    container.register('auth.users.get', binding)

    expect(container.get('auth.users.get')).toBe(binding)
  })

  it('keeps bindings for different identifiers separate', () => {
    const container = new ControllerContainer()
    const other = () => Promise.resolve('other')

    container.register('auth.users.get', binding)
    container.register('auth.users.delete', other)

    expect(container.get('auth.users.get')).toBe(binding)
    expect(container.get('auth.users.delete')).toBe(other)
  })

  it('lets a later registration replace an earlier one for the same identifier', () => {
    const container = new ControllerContainer()
    const replacement = () => Promise.resolve('replacement')

    container.register('auth.users.get', binding)
    container.register('auth.users.get', replacement)

    expect(container.get('auth.users.get')).toBe(replacement)
  })

  it('matches identifiers exactly, not by prefix', () => {
    const container = new ControllerContainer()

    container.register('auth.users.get', binding)

    expect(container.get('auth.users')).toBeUndefined()
    expect(container.get('auth.users.get.extra')).toBeUndefined()
  })

  it('does not share registrations between two container instances', () => {
    const container = new ControllerContainer()

    container.register('auth.users.get', binding)

    expect(new ControllerContainer().get('auth.users.get')).toBeUndefined()
  })

  it('returns a binding that is still invocable', async () => {
    const container = new ControllerContainer()

    container.register('auth.users.get', binding)

    await expect((container.get('auth.users.get') as () => Promise<unknown>)()).resolves.toBe('handled')
  })
})
