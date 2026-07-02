import * as http from 'http'
import * as https from 'https'
import { URL } from 'url'
import { Application, Request, Response } from 'express'
import { Container } from 'inversify'
import { Logger } from 'winston'

import { TYPES } from '../Bootstrap/Types'
import { WORKFLOWS_UI_COOKIE_NAME, WorkflowsService } from '../Service/Workflows/WorkflowsService'

/**
 * Standard Red Notes: authenticated same-origin reverse proxy for the embedded
 * n8n editor UI, mounted at WORKFLOWS_UI_BASE_PATH (default /workflows-ui).
 *
 * SECURITY MODEL — every request through here is gated THREE ways, all
 * fail-closed:
 *   1. operator master switch WORKFLOWS_ENABLED (off => 404, feature invisible),
 *   2. a valid, unexpired, purpose-scoped UI-access token (HttpOnly cookie
 *      minted ONLY by the session-authed /v1/workflows status/pair endpoints,
 *      which re-validate the session AND the admin-managed per-user
 *      entitlement server-side),
 *   3. an ACTIVE pairing record for that user (unpair revokes access on the
 *      very next request).
 * The n8n container itself sits on the internal docker network with no host
 * port, so this proxy is the ONLY way to reach it. Per-user access enforcement
 * lives HERE at the SRN boundary (see docs/WORKFLOWS_PLAN.md §6.2): n8n
 * community edition runs in shared single-owner mode.
 *
 * TRANSPORT: a plain streaming pipe over node http — request and response
 * bodies are never buffered, so large assets and the editor's Server-Sent-
 * Events push channel work. Deploy n8n with N8N_PUSH_BACKEND=sse (see
 * docker-compose.yml) so no WebSocket upgrade handling is needed, and with
 * N8N_PATH set to this base path so its assets resolve without rewriting.
 */

/** Hop-by-hop headers that must not be forwarded either direction (RFC 7230). */
const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]

const readCookie = (request: Request, name: string): string | undefined => {
  // cookie-parser is mounted in both deployments, but fall back to parsing the
  // raw header so this gate never accidentally opens when it is not.
  const parsed = (request as Request & { cookies?: Record<string, string> }).cookies
  if (parsed && typeof parsed[name] === 'string') {
    return parsed[name]
  }
  for (const cookie of (request.headers.cookie ?? '').split(';')) {
    const separatorIndex = cookie.indexOf('=')
    if (separatorIndex > 0 && cookie.substring(0, separatorIndex).trim() === name) {
      return cookie.substring(separatorIndex + 1).trim()
    }
  }
  return undefined
}

export function registerWorkflowsUiProxy(app: Application, container: Container): boolean {
  const service = container.get<WorkflowsService>(TYPES.ApiGateway_WorkflowsService)
  const logger = container.get<Logger>(TYPES.ApiGateway_Logger)

  const basePath = service.uiBasePath
  const target = new URL(service.n8nUrl)
  const transport = target.protocol === 'https:' ? https : http

  app.use(basePath, async (request: Request, response: Response) => {
    try {
      // Gate 1: master switch. 404 keeps the feature invisible when off.
      if (!service.isEnabled()) {
        response.status(404).send('Not found.')
        return
      }

      // Gate 2: purpose-scoped UI-access token (see WorkflowsService docblock).
      const userUuid = service.verifyUiAccessToken(readCookie(request, WORKFLOWS_UI_COOKIE_NAME))
      if (userUuid === null) {
        response.status(403).json({
          error: {
            tag: 'workflows-ui-unauthorized',
            message: 'Workflows editor access requires an active, entitled session. Open it from the Workflows view.',
          },
        })
        return
      }

      // Gate 3: an active pairing — unpair revokes access immediately.
      if (!(await service.isPaired(userUuid))) {
        response.status(403).json({
          error: {
            tag: 'workflows-not-paired',
            message: 'Connect workflows before opening the editor.',
          },
        })
        return
      }

      // Forward. The mount strips the base path from request.url, but n8n is
      // deployed with N8N_PATH=<basePath>/ so it expects the FULL original path —
      // use originalUrl and skip any rewriting.
      const headers: Record<string, string | string[]> = {}
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined || HOP_BY_HOP_HEADERS.includes(name)) {
          continue
        }
        headers[name] = value
      }
      delete headers.host
      headers['x-forwarded-proto'] = request.protocol
      headers['x-forwarded-host'] = request.headers.host ?? ''
      headers['x-forwarded-for'] = request.ip ?? ''

      // The app-level body parsers (json/text) run BEFORE this router and CONSUME
      // the request stream for the content types they match (the n8n editor's
      // REST calls are application/json). When that happened, re-serialize the
      // parsed body and send it with a recomputed content-length; otherwise the
      // stream is untouched and can be piped as-is.
      let bodyToForward: string | Buffer | undefined
      if (request.readableEnded) {
        if (typeof request.body === 'string' || Buffer.isBuffer(request.body)) {
          bodyToForward = request.body
        } else if (request.body !== undefined && request.body !== null && typeof request.body === 'object') {
          bodyToForward = JSON.stringify(request.body)
        } else {
          bodyToForward = ''
        }
        delete headers['content-length']
        if (bodyToForward.length > 0) {
          headers['content-length'] = `${Buffer.byteLength(bodyToForward)}`
        }
      }

      const upstreamRequest = transport.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (target.protocol === 'https:' ? 443 : 80),
          method: request.method,
          path: request.originalUrl,
          headers,
        },
        (upstreamResponse) => {
          // helmet already stamped OUR strict CSP on this response; the n8n
          // editor ships its own headers and inline bootstrapping, so drop ours
          // and let the (same-origin, iframe-sandboxed) editor's headers stand.
          response.removeHeader('Content-Security-Policy')

          for (const [name, value] of Object.entries(upstreamResponse.headers)) {
            if (value === undefined || HOP_BY_HOP_HEADERS.includes(name)) {
              continue
            }
            response.setHeader(name, value)
          }
          response.status(upstreamResponse.statusCode ?? 502)
          upstreamResponse.pipe(response)
        },
      )

      upstreamRequest.on('error', (error: Error) => {
        logger.debug(`[workflows-ui] proxy error: ${error.message}`)
        if (!response.headersSent) {
          response.status(502).json({
            error: {
              tag: 'workflows-engine-unreachable',
              message: 'The workflows engine is not reachable. Is the n8n service running?',
            },
          })
        } else {
          response.end()
        }
      })

      if (bodyToForward !== undefined) {
        upstreamRequest.end(bodyToForward)
      } else {
        request.pipe(upstreamRequest)
      }
      // If the client disconnects (e.g. the editor's SSE stream), tear down the
      // upstream leg too so sockets do not leak.
      response.on('close', () => {
        upstreamRequest.destroy()
      })
    } catch (error) {
      logger.error(`[workflows-ui] proxy failure: ${(error as Error).message}`)
      if (!response.headersSent) {
        response.status(500).json({ error: { message: 'Workflows editor proxy failure.' } })
      }
    }
  })

  return true
}
