import 'reflect-metadata'
import { Request, Response } from 'express'

import { PluginsController, contentTypeForPath } from './PluginsController'
import { PluginsProxyService } from '../../Service/Plugins/PluginsProxyService'
import { ServerSettingsResolver } from '../../Service/ServerSettings/ServerSettingsResolver'

const BASE = 'https://raw.githubusercontent.com/standardnotes/plugins/main/cdn/dist'

/** A response double capturing status/json/send/header. */
const makeResponse = (): {
  response: Response
  status: jest.Mock
  json: jest.Mock
  send: jest.Mock
  headers: Record<string, string>
  removedHeaders: string[]
} => {
  const headers: Record<string, string> = {}
  const removedHeaders: string[] = []
  const json = jest.fn()
  const send = jest.fn()
  const status = jest.fn(() => ({ json, send }))
  const response = {
    status,
    json,
    send,
    setHeader: (name: string, value: string) => {
      headers[name] = value
    },
    removeHeader: (name: string) => {
      removedHeaders.push(name)
      delete headers[name]
    },
  } as unknown as Response

  return { response, status, json, send, headers, removedHeaders }
}

describe('contentTypeForPath', () => {
  it('maps known extensions to browser content types (never upstream text/plain)', () => {
    expect(contentTypeForPath('org.foo/dist/index.html')).toBe('text/html; charset=utf-8')
    expect(contentTypeForPath('a/b/main.js')).toBe('text/javascript; charset=utf-8')
    expect(contentTypeForPath('a/b/style.css')).toBe('text/css; charset=utf-8')
    expect(contentTypeForPath('a/b/font.woff2')).toBe('font/woff2')
    expect(contentTypeForPath('a/b/icon.svg')).toBe('image/svg+xml')
  })

  it('falls back to octet-stream for unknown/extensionless files (never mislabels)', () => {
    expect(contentTypeForPath('a/b/LICENSE')).toBe('application/octet-stream')
    expect(contentTypeForPath('a/b/weird.xyz')).toBe('application/octet-stream')
  })
})

describe('PluginsController', () => {
  const makeController = (overrides: {
    fetchFile?: PluginsProxyService['fetchFile']
    fetchIndex?: PluginsProxyService['fetchIndex']
    sameOriginRendering?: boolean
    repoUrl?: string
  }) => {
    const proxy = {
      fetchFile: overrides.fetchFile ?? jest.fn(),
      fetchIndex: overrides.fetchIndex ?? jest.fn(),
    } as unknown as PluginsProxyService
    const resolver = {
      resolvePluginsRepoUrl: jest.fn(async () => overrides.repoUrl ?? BASE),
      resolvePluginsSameOriginRendering: jest.fn(async () => overrides.sameOriginRendering ?? false),
    } as unknown as ServerSettingsResolver

    return { controller: new PluginsController(proxy, resolver), proxy, resolver }
  }

  describe('GET /config', () => {
    it('returns the effective repoUrl + sameOriginRendering', async () => {
      const { controller } = makeController({ sameOriginRendering: true, repoUrl: 'https://mirror.example.com/p' })
      const { response, status, json } = makeResponse()

      await controller.config({} as Request, response)

      expect(status).toHaveBeenCalledWith(200)
      expect(json).toHaveBeenCalledWith({ repoUrl: 'https://mirror.example.com/p', sameOriginRendering: true })
    })
  })

  describe('GET /component/* (opt-in gate)', () => {
    it('returns 404 without fetching when same-origin rendering is OFF (back-compat)', async () => {
      const fetchFile = jest.fn()
      const { controller } = makeController({ sameOriginRendering: false, fetchFile })
      const { response, status } = makeResponse()

      await controller.component({ params: { splat:'org.foo/dist/index.html' } } as unknown as Request, response)

      expect(status).toHaveBeenCalledWith(404)
      expect(fetchFile).not.toHaveBeenCalled()
    })

    it('serves an index file with an extension-derived content type + hardening headers when ON', async () => {
      const fetchFile = jest.fn(async () => ({
        status: 200,
        contentType: 'text/plain', // upstream (raw.githubusercontent) — must be overridden
        body: Buffer.from('<html></html>'),
      }))
      const { controller, proxy } = makeController({ sameOriginRendering: true, fetchFile })
      const { response, status, send, headers } = makeResponse()

      await controller.component(
        { params: { splat:'org.foo/1.2.3/dist/index.html' } } as unknown as Request,
        response,
      )

      expect((proxy.fetchFile as jest.Mock)).toHaveBeenCalledWith('org.foo/1.2.3/dist/index.html')
      expect(status).toHaveBeenCalledWith(200)
      expect(headers['Content-Type']).toBe('text/html; charset=utf-8')
      expect(headers['X-Content-Type-Options']).toBe('nosniff')
      expect(headers['Access-Control-Allow-Origin']).toBe('*')
      expect(send).toHaveBeenCalledWith(Buffer.from('<html></html>'))
    })

    it('forces an OPAQUE origin + blocks framing: sandbox CSP (no allow-same-origin) overriding helmet, X-Frame-Options', async () => {
      const fetchFile = jest.fn(async () => ({
        status: 200,
        contentType: 'text/plain',
        body: Buffer.from('<html><script src="./main.js"></script></html>'),
      }))
      const { controller } = makeController({ sameOriginRendering: true, fetchFile })
      const { response, headers, removedHeaders } = makeResponse()

      await controller.component(
        { params: { splat:'org.foo/1.2.3/dist/index.html' } } as unknown as Request,
        response,
      )

      const csp = headers['Content-Security-Policy']
      // OVERRIDES helmet's global CSP for this route (removeHeader → setHeader).
      expect(removedHeaders).toContain('Content-Security-Policy')
      // sandbox WITHOUT allow-same-origin => opaque origin under ANY load path.
      expect(csp).toContain('sandbox')
      expect(csp).toContain('allow-scripts')
      expect(csp).not.toContain('allow-same-origin')
      // No script-src directive => the doc's own same-origin bundles still load.
      expect(csp).not.toContain('script-src')
      // Blocks cross-site framing two ways.
      expect(csp).toContain("frame-ancestors 'self'")
      expect(headers['X-Frame-Options']).toBe('SAMEORIGIN')
    })

    it('propagates the SSRF guard: an out-of-base path is rejected as 400 (never mislabeled)', async () => {
      const fetchFile = jest.fn(async () => ({ error: 'outside-base' as const }))
      const { controller } = makeController({ sameOriginRendering: true, fetchFile })
      const { response, status } = makeResponse()

      await controller.component(
        { params: { splat:'https://evil.example.com/x' } } as unknown as Request,
        response,
      )

      expect(status).toHaveBeenCalledWith(400)
    })

    it('rejects an empty component path as 400 when ON', async () => {
      const fetchFile = jest.fn()
      const { controller } = makeController({ sameOriginRendering: true, fetchFile })
      const { response, status } = makeResponse()

      await controller.component({ params: {} } as unknown as Request, response)

      expect(status).toHaveBeenCalledWith(400)
      expect(fetchFile).not.toHaveBeenCalled()
    })
  })
})
