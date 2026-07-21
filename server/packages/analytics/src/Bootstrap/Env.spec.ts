import 'reflect-metadata'

import { config } from 'dotenv'

import { Env } from './Env'

jest.mock('dotenv', () => ({
  config: jest.fn(),
}))

describe('Env', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(config as jest.Mock).mockReturnValue({ parsed: { FOO: 'bar' } })
  })

  it('exposes the variables parsed out of the dotenv file', () => {
    const env = new Env()
    env.load()

    expect(config).toHaveBeenCalledTimes(1)
    expect(env.getAll()).toEqual({ FOO: 'bar' })
  })

  it('reads a value from the process environment', () => {
    process.env.ANALYTICS_ENV_SPEC_VALUE = 'set'

    expect(new Env().get('ANALYTICS_ENV_SPEC_VALUE')).toEqual('set')

    delete process.env.ANALYTICS_ENV_SPEC_VALUE
  })

  it('throws for a missing required variable and tolerates a missing optional one', () => {
    const env = new Env()

    expect(() => env.get('ANALYTICS_ENV_SPEC_MISSING')).toThrow(
      'Environment variable ANALYTICS_ENV_SPEC_MISSING not set',
    )
    expect(env.get('ANALYTICS_ENV_SPEC_MISSING', true)).toBeUndefined()
  })
})
