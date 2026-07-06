import 'reflect-metadata'

import { AxiosInstance } from 'axios'
import { Request, Response } from 'express'

import { HttpServiceProxy } from './HttpServiceProxy'

describe('HttpServiceProxy x-origin-ip', () => {
  const buildProxy = (httpClient: AxiosInstance, clientIpHeader = ''): HttpServiceProxy =>
    new HttpServiceProxy(
      httpClient,
      'http://auth',
      'http://syncing',
      'http://payments',
      'http://files',
      'http://ws',
      'http://revisions',
      'http://email',
      1000,
      { get: jest.fn(), set: jest.fn(), invalidate: jest.fn() } as never,
      { error: jest.fn(), debug: jest.fn(), info: jest.fn() } as never,
      { sleep: jest.fn() } as never,
      clientIpHeader,
    )

  const buildRequest = (overrides: Partial<Request> = {}): Request =>
    ({
      method: 'POST',
      url: '/v1/items',
      headers: {},
      query: {},
      socket: { remoteAddress: '1.1.1.1' },
      ...overrides,
    }) as unknown as Request

  const buildResponse = (): Response =>
    ({
      locals: {},
      setHeader: jest.fn(),
      status: jest.fn().mockReturnValue({ send: jest.fn() }),
      send: jest.fn(),
    }) as unknown as Response

  const captureHeaders = (): { client: AxiosInstance; sent: () => Record<string, string> } => {
    let captured: Record<string, string> = {}
    const client = {
      request: jest.fn((config: { headers: Record<string, string> }) => {
        captured = config.headers
        return Promise.resolve({ status: 200, data: {}, headers: { 'content-type': 'application/json' } })
      }),
    } as unknown as AxiosInstance
    return { client, sent: () => captured }
  }

  it('sets x-origin-ip from the TRUST_PROXY-resolved request.ip, IGNORING a spoofed X-Forwarded-For', async () => {
    const { client, sent } = captureHeaders()
    const proxy = buildProxy(client)
    await proxy.callSyncingServer(
      buildRequest({ ip: '2.2.2.2', headers: { 'x-forwarded-for': '9.9.9.9, 8.8.8.8' } as never }),
      buildResponse(),
      'items',
    )
    expect(sent()['x-origin-ip']).toBe('2.2.2.2')
  })

  it('honors CLIENT_IP_HEADER for x-origin-ip when configured', async () => {
    const { client, sent } = captureHeaders()
    const proxy = buildProxy(client, 'x-real-ip')
    await proxy.callSyncingServer(
      buildRequest({ ip: '2.2.2.2', headers: { 'x-real-ip': '203.0.113.5' } as never }),
      buildResponse(),
      'items',
    )
    expect(sent()['x-origin-ip']).toBe('203.0.113.5')
  })
})
