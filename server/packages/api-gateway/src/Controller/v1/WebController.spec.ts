import 'reflect-metadata'

import { Request, Response } from 'express'

import { WebService, WebValidationError } from '../../Service/Web/WebService'
import { WebController } from './WebController'

const allowedPolicy = { resolveAssistantInternetAccessEnabled: async () => true }

describe('structured research access', () => {
  it.each([
    ['PDF_EXTRACTOR_BUSY', 429],
    ['PDF_EXTRACTION_NOT_CONFIGURED', 503],
  ])('reports %s without claiming app downtime', async (code, expected) => {
    const json = jest.fn()
    const status = jest.fn(() => ({ json }))
    const controller = new WebController({} as WebService, allowedPolicy as never, undefined, {
      execute: jest.fn().mockRejectedValue(new Error(String(code))),
    } as never)
    await controller.pdf(
      { body: { url: 'https://example.test/paper.pdf' } } as Request,
      { status, json } as unknown as Response,
    )
    expect(status).toHaveBeenCalledWith(expected)
  })
  it.each(['research', 'pdf'] as const)('checks server internet lockdown before %s', async (method) => {
    const execute = jest.fn()
    const json = jest.fn()
    const status = jest.fn(() => ({ json }))
    const controller = new WebController(
      {} as WebService,
      { resolveAssistantInternetAccessEnabled: async () => false } as never,
      { execute } as never,
      { execute } as never,
    )
    await controller[method](
      { body: { url: 'https://example.test/paper.pdf' } } as Request,
      { status, json } as unknown as Response,
    )
    expect(status).toHaveBeenCalledWith(403)
    expect(execute).not.toHaveBeenCalled()
  })

  it('forwards native research and PDF ranges after authorization', async () => {
    const research = { execute: jest.fn().mockResolvedValue({ data: { title: 'Paper' } }) }
    const pdf = { execute: jest.fn().mockResolvedValue({ pages: [{ pageNumber: 3, text: 'Evidence' }] }) }
    const json = jest.fn()
    const controller = new WebController({} as WebService, allowedPolicy as never, research as never, pdf as never)
    const body = { capability: 'academic', provider: 'crossref', action: 'search', query: 'topic' }
    await controller.research({ body } as Request, { json } as unknown as Response)
    expect(research.execute).toHaveBeenCalledWith(body)
    await controller.pdf(
      { body: { url: 'https://example.test/paper.pdf', startPage: 3, endPage: 5 } } as Request,
      { json } as unknown as Response,
    )
    expect(pdf.execute).toHaveBeenCalledWith({ url: 'https://example.test/paper.pdf', startPage: 3, endPage: 5 })
  })
})

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

    await new WebController(service, allowedPolicy as never).fetch(
      { body: { url: 'https://example.com/' } } as Request,
      response,
    )

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

    await new WebController(service, allowedPolicy as never).fetch(
      { body: { url: 'https://example.com/' } } as Request,
      response,
    )

    expect(status).toHaveBeenCalledWith(expectedStatus)
    expect(json).toHaveBeenCalledWith({ error: { tag, message } })
  })

  it('does not expose an unexpected implementation error', async () => {
    service.fetch.mockRejectedValue(new Error('socket failure with sensitive upstream details'))

    await new WebController(service, allowedPolicy as never).fetch(
      { body: { url: 'https://example.com/' } } as Request,
      response,
    )

    expect(status).toHaveBeenCalledWith(502)
    expect(json).toHaveBeenCalledWith({
      error: { tag: 'fetch-failed', message: 'Failed to fetch the URL.' },
    })
  })

  it('normalizes a missing or non-string URL before validation', async () => {
    service.fetch.mockRejectedValue(new WebValidationError('A URL is required.', 'missing-url'))

    await new WebController(service, allowedPolicy as never).fetch(
      { body: { url: 42 } } as unknown as Request,
      response,
    )

    expect(service.fetch).toHaveBeenCalledWith('')
    expect(status).toHaveBeenCalledWith(400)
  })
})

describe('WebController internet policy', () => {
  it('refuses outbound work if the policy resolver was not attached', async () => {
    const service = { fetch: jest.fn(), search: jest.fn() } as unknown as WebService
    const json = jest.fn()
    const status = jest.fn().mockReturnValue({ json })
    const response = { status, json } as unknown as Response
    const controller = new WebController(service)
    await controller.search({ body: { query: 'q' } } as Request, response)
    await controller.fetch({ body: { url: 'https://example.com' } } as Request, response)
    expect(status).toHaveBeenLastCalledWith(503)
    expect(service.search).not.toHaveBeenCalled()
    expect(service.fetch).not.toHaveBeenCalled()
  })

  it.each(['search', 'fetch'] as const)(
    'refuses %s before any outbound work when disabled and fails closed on unreadable policy',
    async (method) => {
      const service = { fetch: jest.fn(), search: jest.fn() } as unknown as WebService
      const resolver = { resolveAssistantInternetAccessEnabled: jest.fn().mockResolvedValue(false) }
      const json = jest.fn()
      const status = jest.fn().mockReturnValue({ json })
      const response = { status, json } as unknown as Response
      const controller = new WebController(service, resolver as never)
      await controller[method]({ body: { query: 'q', url: 'https://example.com/' } } as Request, response)
      expect(status).toHaveBeenLastCalledWith(403)
      expect(json).toHaveBeenLastCalledWith({
        error: { tag: 'internet-access-disabled', message: 'Internet access is disabled by this server.' },
      })
      expect(service[method]).not.toHaveBeenCalled()
      resolver.resolveAssistantInternetAccessEnabled.mockRejectedValueOnce(new Error('private storage details'))
      await controller[method]({ body: {} } as Request, response)
      expect(status).toHaveBeenLastCalledWith(503)
      expect(service[method]).not.toHaveBeenCalled()
      expect(JSON.stringify(json.mock.calls)).not.toContain('private storage')
      resolver.resolveAssistantInternetAccessEnabled.mockResolvedValueOnce(true)
      await controller[method]({ body: { query: 'q', url: 'https://example.com/' } } as Request, response)
      expect(service[method]).toHaveBeenCalledTimes(1)
    },
  )
})
