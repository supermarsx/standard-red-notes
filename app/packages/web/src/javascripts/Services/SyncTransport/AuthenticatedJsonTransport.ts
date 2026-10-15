import { AuthenticatedJsonTransport, readSharedServerAccessKey } from '@standardnotes/api'
import { HttpVerb } from '@standardnotes/responses'
import { AuthenticatedRpcError, WebSocketSyncTransport } from './WebSocketSyncTransport'

const excludedFamilies = [
  '/v1/items',
  '/v1/users',
  '/v1/login-params',
  '/v1/sockets',
  '/sockets',
  '/v1/auth',
  '/v1/authenticators',
  '/v1/mfa',
  '/v1/passkeys',
  '/v1/recovery',
  '/v1/security-keys',
  '/v1/magic-links',
  '/v1/files',
  '/files',
  '/v1/meta',
]
const allowedHeaders = new Set(['accept', 'content-type', 'if-match', 'if-none-match', 'x-shared-vault-owner-context'])
const sensitive = /(?:password|secret|credential|token|captcha|assertion|clientdata|authenticator|recovery.?code)/i

function hasCredentials(value: unknown, depth = 0): boolean {
  if (depth > 32) {
    return true
  }
  if (!value || typeof value !== 'object') {
    return false
  }
  return Object.entries(value).some(([key, child]) => sensitive.test(key) || hasCredentials(child, depth + 1))
}

/** Prefer the already-negotiated lane; never establish it through its own bootstrap requests. */
export function createAuthenticatedJsonTransport(options: {
  getTransport(): WebSocketSyncTransport | undefined
  getAccountScope(): string | undefined
}): AuthenticatedJsonTransport {
  const keys = new WeakMap<object, string>()
  return async (request, context) => {
    const transport = options.getTransport()
    const scope = options.getAccountScope()
    if (
      !transport ||
      !scope ||
      transport.transportStatus.state !== 'READY' ||
      !transport.transportStatus.operations.includes('API_RPC') ||
      !request.authentication ||
      request.authentication !== context.authentication ||
      request.external ||
      request.rawBytes ||
      (request.responseType && request.responseType !== 'json') ||
      readSharedServerAccessKey()
    ) {
      return undefined
    }
    let url: URL, host: URL
    try {
      url = new URL(request.url)
      host = new URL(context.host)
    } catch {
      return undefined
    }
    const base = host.pathname.replace(/\/$/, '')
    if (
      !['http:', 'https:'].includes(host.protocol) ||
      url.origin !== host.origin ||
      url.username ||
      url.password ||
      url.hash ||
      !url.pathname.startsWith(`${base}/v1/`)
    ) {
      return undefined
    }
    const path = url.pathname.slice(base.length)
    let normalized: string
    try {
      normalized = decodeURIComponent(path)
        .toLowerCase()
        .replace(/\/{2,}/g, '/')
        .replace(/\/+$/, '')
    } catch {
      return undefined
    }
    const heartbeat = normalized === '/v1/sessions/activity' && request.verb === HttpVerb.Post
    if (
      (!heartbeat && (request.verb !== HttpVerb.Get || normalized.startsWith('/v1/sessions'))) ||
      normalized.startsWith('/v1/pending-mfa-approvals/') ||
      excludedFamilies.some((family) => normalized === family || normalized.startsWith(`${family}/`)) ||
      hasCredentials(request.params) ||
      [...url.searchParams.keys()].some((key) => sensitive.test(key))
    ) {
      return undefined
    }
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(heartbeat ? { 'content-type': 'application/json' } : {}),
      'x-snjs-version': context.snjsVersion,
      'x-application-version': context.applicationVersion,
    }
    for (const header of request.customHeaders ?? []) {
      const name = header.key.toLowerCase()
      if (!allowedHeaders.has(name) || /[\r\n]/.test(header.value)) {
        return undefined
      }
      if (name === 'content-type' && !header.value.startsWith('application/json')) {
        return undefined
      }
      headers[name] = header.value
    }
    if (request.verb === HttpVerb.Get) {
      for (const [key, value] of Object.entries(request.params ?? {})) {
        url.searchParams.append(key, String(value))
      }
    }
    if (heartbeat && !keys.has(request)) {
      if (!globalThis.crypto?.getRandomValues) {
        return undefined
      }
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
      keys.set(request, [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(''))
    }
    try {
      const response = await transport.openAuthenticatedRpcStream({
        method: request.verb === HttpVerb.Get ? 'GET' : 'POST',
        path: `${path}${url.search}`,
        headers,
        ...(heartbeat ? { body: request.params, idempotencyKey: keys.get(request) } : {}),
        signal: request.abortSignal,
        stream: false,
        deadlineMs: Math.max(1_000, Math.min(120_000, request.timeoutMs ?? 30_000)),
      })
      if (scope !== options.getAccountScope()) {
        throw new AuthenticatedRpcError('ACCOUNT_CHANGED', false, false)
      }
      const noBody = [204, 205, 304].includes(response.status)
      return new Response(
        noBody ? null : typeof response.body === 'string' ? response.body : JSON.stringify(response.body ?? {}),
        {
          status: response.status,
          headers: response.headers,
        },
      )
    } catch (error) {
      if (request.abortSignal?.aborted) {
        throw request.abortSignal.reason ?? error
      }
      if (scope !== options.getAccountScope()) {
        throw new AuthenticatedRpcError('ACCOUNT_CHANGED', false, false)
      }
      if (error instanceof AuthenticatedRpcError && error.safeToFallback) {
        return undefined
      }
      // A sent mutation may have applied. Return an uncertain network failure,
      // never undefined (which would dispatch the same request over HTTP).
      return new Response(
        JSON.stringify({
          networkFailure: true,
          uncertain: true,
          error: { message: 'The socket request did not return a result.' },
        }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      )
    }
  }
}
