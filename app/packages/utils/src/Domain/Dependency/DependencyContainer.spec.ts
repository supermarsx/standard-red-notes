import { DependencyContainer } from './DependencyContainer'

describe('DependencyContainer', () => {
  let container: DependencyContainer

  beforeEach(() => {
    container = new DependencyContainer()
  })

  it('should build a bound dependency on first get', () => {
    const sym = Symbol('Service')
    const instance = { name: 'service' }
    container.bind(sym, () => instance)

    expect(container.get(sym)).toBe(instance)
  })

  it('should build each dependency only once', () => {
    const sym = Symbol('Service')
    const maker = jest.fn().mockReturnValue({ name: 'service' })
    container.bind(sym, maker)

    const first = container.get(sym)
    const second = container.get(sym)

    expect(first).toBe(second)
    expect(maker).toHaveBeenCalledTimes(1)
  })

  it('should throw when nothing is bound for the symbol', () => {
    expect(() => container.get(Symbol('Missing'))).toThrow('No dependency maker found for Symbol(Missing)')
  })

  it('should return undefined without caching when the maker yields nothing', () => {
    const sym = Symbol('Optional')
    const maker = jest.fn().mockReturnValue(undefined)
    container.bind(sym, maker)

    expect(container.get(sym)).toBeUndefined()
    expect(container.get(sym)).toBeUndefined()
    expect(maker).toHaveBeenCalledTimes(2)
  })

  it('should let a later bind replace an unresolved maker', () => {
    const sym = Symbol('Service')
    container.bind(sym, () => ({ version: 1 }))
    container.bind(sym, () => ({ version: 2 }))

    expect(container.get(sym)).toEqual({ version: 2 })
  })

  describe('getAll', () => {
    it('should be empty before anything is resolved', () => {
      container.bind(Symbol('Service'), () => ({}))

      expect(container.getAll()).toEqual([])
    })

    it('should return every resolved dependency', () => {
      const a = Symbol('A')
      const b = Symbol('B')
      container.bind(a, () => ({ id: 'a' }))
      container.bind(b, () => ({ id: 'b' }))

      container.get(a)
      container.get(b)

      expect(container.getAll()).toEqual([{ id: 'a' }, { id: 'b' }])
    })
  })

  describe('deinit', () => {
    it('should deinit every resolved dependency that supports it', () => {
      const deinitable = { deinit: jest.fn() }
      const plain = { id: 'plain' }
      const a = Symbol('A')
      const b = Symbol('B')
      container.bind(a, () => deinitable)
      container.bind(b, () => plain)
      container.get(a)
      container.get(b)

      container.deinit()

      expect(deinitable.deinit).toHaveBeenCalledTimes(1)
    })

    it('should drop resolved dependencies and bound makers', () => {
      const sym = Symbol('Service')
      container.bind(sym, () => ({ id: 'a' }))
      container.get(sym)

      container.deinit()

      expect(container.getAll()).toEqual([])
      expect(() => container.get(sym)).toThrow('No dependency maker found')
    })
  })
})
