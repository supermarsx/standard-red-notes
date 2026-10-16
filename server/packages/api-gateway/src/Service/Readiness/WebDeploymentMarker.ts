import { normalizeDeploymentRevision, normalizeDeploymentVersion } from './DeploymentIdentity'

export type WebDeploymentMarker = { revision: string; version: string }
type Options = { internalOrigin?: string; publicUrl?: string; fetch?: typeof fetch; now?: () => number }
const MARKER_PATH = '/.well-known/srn-deployment.json'
const MAX_BYTES = 512
const DEADLINE_MS = 2_500

/** Configuration only: never derive a fetch target from a request header or frame. */
export function webDeploymentOrigin(internalOrigin?: string, publicUrl?: string): string | undefined {
  const configured = internalOrigin?.trim() || publicUrl?.trim()
  if (!configured) {
    return undefined
  }
  try {
    const url = new URL(configured)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return undefined
    }
    return url.origin
  } catch {
    return undefined
  }
}

/** Read the LIVE web facade, not this backend image's independent build marker.
 * A short, coalesced cache bounds traffic when many tabs check simultaneously.
 */
export class WebDeploymentMarkerReader {
  private readonly origin: string | undefined
  private readonly fetch: typeof fetch
  private readonly now: () => number
  private cached: WebDeploymentMarker | undefined
  private expiresAt = 0
  private pending: Promise<WebDeploymentMarker | undefined> | undefined

  constructor(options: Options) {
    this.origin = webDeploymentOrigin(options.internalOrigin, options.publicUrl)
    this.fetch = options.fetch ?? globalThis.fetch
    this.now = options.now ?? Date.now
  }

  read(): Promise<WebDeploymentMarker | undefined> {
    if (this.pending) {
      return this.pending
    }
    if (this.now() < this.expiresAt) {
      return Promise.resolve(this.cached)
    }
    this.pending = this.fetchMarker()
      .then((marker) => {
        this.cached = marker
        this.expiresAt = this.now() + (marker ? 5_000 : 1_000)
        return marker
      })
      .finally(() => {
        this.pending = undefined
      })
    return this.pending
  }

  private async fetchMarker(): Promise<WebDeploymentMarker | undefined> {
    if (!this.origin) {
      return undefined
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), DEADLINE_MS)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const response = await this.fetch(`${this.origin}${MARKER_PATH}`, {
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        headers: { accept: 'application/json', 'cache-control': 'no-cache' },
        signal: controller.signal,
      })
      if (
        response.status !== 200 ||
        !response.body ||
        !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')
      ) {
        return undefined
      }
      const declaredLength = response.headers.get('content-length')
      if (declaredLength !== null && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_BYTES)) {
        return undefined
      }
      reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        size += value.byteLength
        if (size > MAX_BYTES) {
          return undefined
        }
        chunks.push(value)
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return undefined
      }
      const value = parsed as Record<string, unknown>
      if (
        Object.keys(value).some((key) => key !== 'revision' && key !== 'version') ||
        typeof value.revision !== 'string' ||
        typeof value.version !== 'string'
      ) {
        return undefined
      }
      const revision = normalizeDeploymentRevision(value.revision)
      const version = normalizeDeploymentVersion(value.version)
      return revision && version ? { revision, version } : undefined
    } catch {
      return undefined
    } finally {
      clearTimeout(timeout)
      if (reader) {
        void reader.cancel().catch(() => undefined)
      }
      controller.abort()
    }
  }
}
