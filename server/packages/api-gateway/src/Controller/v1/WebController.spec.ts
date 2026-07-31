import 'reflect-metadata'

import { Request, Response } from 'express'

import { WebService, WebValidationError } from '../../Service/Web/WebService'
import { WebController } from './WebController'

describe('WebController.fetch', () => {
  let service: jest.Mocked<WebService>
  let json: jest.Mock
  let status: jest.Mock
  let response: Response

  beforeEach(() => {
    service = {
      fetch: jest.fn(),
      search: jest.fn(),
    } as unknown as jest.Mocked<WebService>
    json = jest.fn()
    status = jest.fn(() => ({ json }))
    response = { json, status } as unknown as Response
  })

  it('returns the bounded fetch result', async () => {
    service.fetch.mockResolvedValue({
      status: 200,
      contentType: 'text/plain',
      title: '',
      text: 'safe body',
    })

    await new WebController(service).fetch({ body: { url: 'https://example.com/' } } as Request, response)

    expect(service.fetch).toHaveBeenCalledWith('https://example.com/')
    expect(json).toHaveBeenCalledWith({
      status: 200,
      contentType: 'text/plain',
      title: '',
      text: 'safe body',
    })
    expect(status).not.toHaveBeenCalled()
  })

  it.each([
    ['response-too-large', 'The fetched response exceeds the allowed size.', 413],
    ['fetch-timeout', 'The request timed out.', 504],
    ['fetch-failed', 'Failed to fetch the URL.', 502],
    ['blocked-host', 'The requested host is not allowed.', 400],
    ['invalid-url', 'The URL is malformed.', 400],
  ])('maps the safe %s error to its HTTP status', async (tag, message, expectedStatus) => {
    service.fetch.mockRejectedValue(new WebValidationError(message, tag))

    await new WebController(service).fetch({ body: { url: 'https://example.com/' } } as Request, response)

    expect(status).toHaveBeenCalledWith(expectedStatus)
    expect(json).toHaveBeenCalledWith({ error: { tag, message } })
  })

  it('does not expose an unexpected implementation error', async () => {
    service.fetch.mockRejectedValue(new Error('socket failure with sensitive upstream details'))

    await new WebController(service).fetch({ body: { url: 'https://example.com/' } } as Request, response)

    expect(status).toHaveBeenCalledWith(502)
    expect(json).toHaveBeenCalledWith({
      error: { tag: 'fetch-failed', message: 'Failed to fetch the URL.' },
    })
  })

  it('normalizes a missing or non-string URL before validation', async () => {
    service.fetch.mockRejectedValue(new WebValidationError('A URL is required.', 'missing-url'))

    await new WebController(service).fetch({ body: { url: 42 } } as unknown as Request, response)

    expect(service.fetch).toHaveBeenCalledWith('')
    expect(status).toHaveBeenCalledWith(400)
  })
})
