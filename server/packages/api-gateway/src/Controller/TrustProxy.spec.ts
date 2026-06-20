import { Application } from 'express'
import { configureTrustProxy, DEFAULT_TRUST_PROXY, parseTrustProxyValue } from './TrustProxy'

describe('parseTrustProxyValue', () => {
  it('returns the default when the value is undefined', () => {
    expect(parseTrustProxyValue(undefined)).toEqual(DEFAULT_TRUST_PROXY)
  })

  it('returns the default when the value is an empty or whitespace string', () => {
    expect(parseTrustProxyValue('')).toEqual(DEFAULT_TRUST_PROXY)
    expect(parseTrustProxyValue('   ')).toEqual(DEFAULT_TRUST_PROXY)
  })

  it('honors a caller-supplied default', () => {
    expect(parseTrustProxyValue(undefined, true)).toBe(true)
    expect(parseTrustProxyValue('', 1)).toBe(1)
  })

  it('parses boolean strings case-insensitively', () => {
    expect(parseTrustProxyValue('true')).toBe(true)
    expect(parseTrustProxyValue('TRUE')).toBe(true)
    expect(parseTrustProxyValue(' true ')).toBe(true)
    expect(parseTrustProxyValue('false')).toBe(false)
    expect(parseTrustProxyValue('False')).toBe(false)
  })

  it('parses a bare integer as a hop count', () => {
    expect(parseTrustProxyValue('1')).toBe(1)
    expect(parseTrustProxyValue('2')).toBe(2)
    expect(parseTrustProxyValue(' 3 ')).toBe(3)
  })

  it('passes through IP/subnet lists and preset names verbatim', () => {
    expect(parseTrustProxyValue('127.0.0.1')).toBe('127.0.0.1')
    expect(parseTrustProxyValue('loopback')).toBe('loopback')
    expect(parseTrustProxyValue('127.0.0.1, 172.16.0.0/12')).toBe('127.0.0.1, 172.16.0.0/12')
    expect(parseTrustProxyValue('  uniquelocal  ')).toBe('uniquelocal')
  })

  it('does not mistake an IP for a hop count', () => {
    expect(parseTrustProxyValue('10.0.0.1')).toBe('10.0.0.1')
  })
})

describe('configureTrustProxy', () => {
  const buildApp = (): { app: Application; set: jest.Mock } => {
    const set = jest.fn()
    const app = { set } as unknown as Application

    return { app, set }
  }

  it('sets the express "trust proxy" setting to the parsed value', () => {
    const { app, set } = buildApp()

    const value = configureTrustProxy(app, 'true')

    expect(value).toBe(true)
    expect(set).toHaveBeenCalledWith('trust proxy', true)
  })

  it('applies the default when no value is provided', () => {
    const { app, set } = buildApp()

    const value = configureTrustProxy(app, undefined)

    expect(value).toEqual(DEFAULT_TRUST_PROXY)
    expect(set).toHaveBeenCalledWith('trust proxy', DEFAULT_TRUST_PROXY)
  })

  it('can be explicitly disabled', () => {
    const { app, set } = buildApp()

    const value = configureTrustProxy(app, 'false')

    expect(value).toBe(false)
    expect(set).toHaveBeenCalledWith('trust proxy', false)
  })
})
