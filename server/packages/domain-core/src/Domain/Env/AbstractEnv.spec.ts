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

  /** Stand in for what `dotenv.config()` parsed out of a generated `.env`. */
  public loadFrom(values: { [key: string]: string }): void {
    this.env = values
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

    /**
     * Standard Red Notes: both Compose topologies pass optional variables as
     * `${FOO:-}`, so an unset one still reaches every process in the container
     * as `FOO=""`. `dotenv.config()` will not override a key that is already
     * present, so the generated `.env` could never fill it, and this method
     * reported it as "not set" while the value sat in the file.
     */
    it('falls back to the loaded file when process.env holds an empty value', () => {
      process.env.SOME_KEY = ''
      const fileBacked = new TestEnv()
      fileBacked.loadFrom({ SOME_KEY: 'from-file' })

      expect(fileBacked.get('SOME_KEY')).toBe('from-file')
    })

    it('falls back to the loaded file when process.env lacks the key entirely', () => {
      delete process.env.SOME_KEY
      const fileBacked = new TestEnv()
      fileBacked.loadFrom({ SOME_KEY: 'from-file' })

      expect(fileBacked.get('SOME_KEY')).toBe('from-file')
    })

    it('prefers a non-empty process.env value over the loaded file', () => {
      process.env.SOME_KEY = 'from-process'
      const fileBacked = new TestEnv()
      fileBacked.loadFrom({ SOME_KEY: 'from-file' })

      expect(fileBacked.get('SOME_KEY')).toBe('from-process')
    })

    it('treats an empty value in the loaded file as unset too', () => {
      process.env.SOME_KEY = ''
      const fileBacked = new TestEnv()
      fileBacked.loadFrom({ SOME_KEY: '' })

      expect(() => fileBacked.get('SOME_KEY')).toThrow('Environment variable SOME_KEY not set')
    })

    it('still throws for a required variable that is empty everywhere, naming the key', () => {
      process.env.EMPTY_KEY = ''

      expect(() => env.get('EMPTY_KEY')).toThrow('Environment variable EMPTY_KEY not set')
    })

    it('returns the empty value unchanged for an optional variable with no file entry', () => {
      process.env.EMPTY_KEY = ''

      expect(env.get('EMPTY_KEY', true)).toBe('')
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
