import * as http from 'http'
import { AddressInfo } from 'net'

import express, { Application, Request, Response } from 'express'
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

describe('nginx forwarding boundary with real Express trust-proxy resolution', () => {
  let server: http.Server

  const requestIp = (forwardedFor: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const address = server.address() as AddressInfo
      const request = http.request(
        {
          host: '127.0.0.1',
          port: address.port,
          path: '/',
          headers: { 'X-Forwarded-For': forwardedFor },
        },
        (response) => {
          let body = ''
          response.setEncoding('utf8')
          response.on('data', (chunk) => (body += chunk))
          response.on('end', () => resolve(body))
        },
      )
      request.on('error', reject)
      request.end()
    })

  beforeEach(async () => {
    const app = express()
    configureTrustProxy(app, undefined)
    app.get('/', (request: Request, response: Response) => response.type('text/plain').send(request.ip))
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => server.once('listening', resolve))
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      }),
    )
  })

  it('resolves the socket peer after direct nginx overwrites an attacker-supplied chain', async () => {
    const attackerClaim = '203.0.113.66'
    const publicSocketPeer = '198.51.100.24'

    // Direct/default nginx sends only $remote_addr. The attacker's inbound XFF
    // is absent from the header that reaches this real Express application.
    const resolved = await requestIp(publicSocketPeer)

    expect(resolved).toBe(publicSocketPeer)
    expect(resolved).not.toBe(attackerClaim)
  })

  it('resolves the real client through the exact sanitized trusted-proxy chain', async () => {
    const realClient = '198.51.100.25'
    const outerProxy = '10.20.30.40'

    // In validated trusted mode, the public proxy overwrites inbound XFF and
    // the app nginx appends that proxy's private address before forwarding.
    const resolved = await requestIp(`${realClient}, ${outerProxy}`)

    expect(resolved).toBe(realClient)
  })
})
