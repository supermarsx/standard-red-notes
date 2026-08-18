import type {
  SyncApiRpcAdapter,
  SyncApiRpcRequest,
  SyncApiRpcResponse,
  SyncNegotiatedOperation,
} from '@standard-red-notes/websocket-gateway'

const MAX_BUFFERED_RPC_RESPONSE_BYTES = 512 * 1024
const RESPONSE_HEADER_NAMES = [
  'cache-control',
  'content-disposition',
  'content-length',
  'content-type',
  'etag',
  'last-modified',
  'retry-after',
  'x-request-id',
] as const

export type LoopbackSyncApiRpcAdapterOptions = {
  /** Fixed process-owned origin, for example http://127.0.0.1:3000. */
  origin: string
  operations: readonly Extract<SyncNegotiatedOperation, 'API_RPC' | 'STREAM_ASSISTANT'>[]
  fetch?: typeof globalThis.fetch
}

/**
 * Dispatches websocket RPC through the exact public Express middleware and
 * controllers on a fixed loopback origin. The frame supplies only a relative
 * path; it can never choose a host, scheme, credential, or hop-by-hop header.
 */
export class LoopbackSyncApiRpcAdapter implements SyncApiRpcAdapter {
  readonly idempotencyScope = 'shared-durable' as const
  private readonly origin: URL
  private readonly fetch: typeof globalThis.fetch
  private readonly negotiatedOperations: readonly Extract<SyncNegotiatedOperation, 'API_RPC' | 'STREAM_ASSISTANT'>[]

  constructor(options: LoopbackSyncApiRpcAdapterOptions) {
    const origin = new URL(options.origin)
    if (
      origin.protocol !== 'http:' ||
      origin.pathname !== '/' ||
      origin.search !== '' ||
      origin.hash !== '' ||
      !isLoopbackHostname(origin.hostname)
    ) {
      throw new Error('Authenticated RPC adapter requires a fixed HTTP loopback origin.')
    }
    this.origin = origin
    this.fetch = options.fetch ?? globalThis.fetch
    this.negotiatedOperations = [...new Set(options.operations)]
  }

  ready(): boolean {
    return typeof this.fetch === 'function' && this.negotiatedOperations.includes('API_RPC')
  }

  operations(): readonly Extract<SyncNegotiatedOperation, 'API_RPC' | 'STREAM_ASSISTANT'>[] {
    return this.negotiatedOperations
  }

  async execute(input: SyncApiRpcRequest, signal: AbortSignal): Promise<SyncApiRpcResponse> {
    if (!this.ready() || !isAllowedRpcRequest(input, this.negotiatedOperations) || isForbiddenRpcPath(input.path)) {
      throw new Error('Authenticated RPC operation is unavailable.')
    }
    if (!input.identity.authorization?.startsWith('Bearer ')) {
      throw new Error('Authenticated RPC identity is unavailable.')
    }

    const target = new URL(input.path, this.origin)
    if (target.origin !== this.origin.origin || `${target.pathname}${target.search}` !== input.path) {
      throw new Error('Authenticated RPC target is invalid.')
    }
    const headers = new Headers(input.headers)
    headers.set('authorization', input.identity.authorization)
    if (input.idempotencyKey) {
      headers.set('idempotency-key', input.idempotencyKey)
    }
    headers.set('x-standardnotes-transport', 'websocket-rpc-v1')

    const response = await this.fetch(target, {
      method: input.method,
      headers,
      redirect: 'error',
      signal,
      ...(Object.hasOwn(input, 'body') ? { body: JSON.stringify(input.body) } : {}),
    })
    const responseHeaders: Record<string, string> = {}
    for (const name of RESPONSE_HEADER_NAMES) {
      const value = response.headers.get(name)
      if (value !== null) {
        responseHeaders[name] = value
      }
    }

    if (input.stream) {
      return {
        status: response.status,
        headers: responseHeaders,
        stream: response.body ? readableStreamBytes(response.body) : emptyByteStream(),
      }
    }

    const contentLength = parseContentLength(response.headers.get('content-length'))
    if (contentLength !== undefined && contentLength > MAX_BUFFERED_RPC_RESPONSE_BYTES) {
      throw new Error('Authenticated RPC response is too large.')
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_BUFFERED_RPC_RESPONSE_BYTES) {
      throw new Error('Authenticated RPC response is too large.')
    }
    return {
      status: response.status,
      headers: responseHeaders,
      ...(bytes.byteLength > 0 ? { body: parseBufferedBody(bytes, response.headers.get('content-type')) } : {}),
    }
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '[::1]' || hostname === 'localhost'
}

function isAllowedRpcRequest(
  input: SyncApiRpcRequest,
  operations: readonly Extract<SyncNegotiatedOperation, 'API_RPC' | 'STREAM_ASSISTANT'>[],
): boolean {
  if (input.method === 'GET') {
    return true
  }
  if (input.method !== 'POST' || !input.idempotencyKey) {
    return false
  }
  const pathname = new URL(input.path, 'http://rpc.invalid').pathname
  return (
    (pathname === '/v1/assistant/stream' && operations.includes('STREAM_ASSISTANT')) ||
    pathname === '/v1/collaboration/authorize'
  )
}

function isForbiddenRpcPath(path: string): boolean {
  const pathname = new URL(path, 'http://rpc.invalid').pathname
  return (
    pathname === '/v1/items' ||
    pathname.startsWith('/v1/items/') ||
    pathname === '/v1/sessions' ||
    pathname.startsWith('/v1/sessions/') ||
    pathname === '/v1/login-params' ||
    pathname === '/v1/users' ||
    pathname === '/v1/sockets/sync/tickets' ||
    pathname.startsWith('/sockets/')
  )
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null || !/^\d+$/u.test(value)) {
    return undefined
  }
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function parseBufferedBody(bytes: Uint8Array, contentType: string | null): unknown {
  const text = new TextDecoder().decode(bytes)
  if (contentType?.toLowerCase().includes('application/json')) {
    return JSON.parse(text)
  }
  return text
}

async function* readableStreamBytes(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader()
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) {
        return
      }
      if (result.value.byteLength > 0) {
        yield result.value
      }
    }
  } finally {
    reader.releaseLock()
  }
}

async function* emptyByteStream(): AsyncGenerator<Uint8Array> {
  return
}
