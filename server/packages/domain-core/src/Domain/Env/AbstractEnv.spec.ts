import { AbstractEnv } from './AbstractEnv'

class TestEnv extends AbstractEnv {
  public loadCalls = 0

  load(): void {
    this.loadCalls++
    this.env = { LOADED: 'yes' }
  }

  public unload(): void {
    this.env = undefined
  }
}

describe('AbstractEnv', () => {
  const originalEnv = process.env
  let env: TestEnv

  beforeEach(() => {
    process.env = { ...originalEnv }
    env = new TestEnv()
  })

  afterAll(() => {
    process.env = originalEnv
  })

  describe('get', () => {
    it('reads the variable from process.env', () => {
      process.env.SOME_KEY = 'some-value'

      expect(env.get('SOME_KEY')).toBe('some-value')
    })

    it('throws for a missing required variable, naming the key', () => {
      delete process.env.MISSING_KEY

      expect(() => env.get('MISSING_KEY')).toThrow('Environment variable MISSING_KEY not set')
    })

    it('returns undefined instead of throwing for a missing optional variable', () => {
      delete process.env.MISSING_KEY

      expect(env.get('MISSING_KEY', true)).toBeUndefined()
    })

    it('prefers a constructor override over process.env', () => {
      process.env.SOME_KEY = 'from-process'

      expect(new TestEnv({ SOME_KEY: 'from-override' }).get('SOME_KEY')).toBe('from-override')
    })

    it('serves an override even when the variable is absent from process.env', () => {
      delete process.env.SOME_KEY

      expect(new TestEnv({ SOME_KEY: 'from-override' }).get('SOME_KEY')).toBe('from-override')
    })

    it('does not load when env has already been populated', () => {
      env.get('PATH', true)

      expect(env.loadCalls).toBe(0)
    })

    it('loads lazily when env is undefined', () => {
      env.unload()

      env.get('PATH', true)

      expect(env.loadCalls).toBe(1)
    })
  })

  describe('getAll', () => {
    it('returns the loaded env map', () => {
      env.unload()

      expect(env.getAll()).toEqual({ LOADED: 'yes' })
    })

    it('loads once when env is undefined', () => {
      env.unload()

      env.getAll()

      expect(env.loadCalls).toBe(1)
    })

    it('does not reload when env is already populated', () => {
      env.getAll()

      expect(env.loadCalls).toBe(0)
    })

    it('defaults to an empty map before any load', () => {
      expect(env.getAll()).toEqual({})
    })
  })
})
