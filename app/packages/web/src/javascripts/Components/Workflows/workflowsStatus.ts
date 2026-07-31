import { WebApplication } from '@/Application/WebApplication'

export type WorkflowsStatus = {
  enabled: boolean
  available: boolean
  publicUrl: string | null
  configurationError: boolean
  authentication: 'n8n'
}

export type WorkflowsStatusState =
  { kind: 'unknown' } | { kind: 'loading' } | { kind: 'unavailable' } | { kind: 'loaded'; status: WorkflowsStatus }

export function shouldShowWorkflowsSection(signedIn: boolean, state: WorkflowsStatusState): boolean {
  return signedIn && state.kind === 'loaded' && state.status.enabled === true
}

const MAX_PUBLIC_URL_LENGTH = 2_048
const LOOPBACK_IPV4_PATTERN = /^127(?:\.\d{1,3}){3}$/

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 0x1f || code === 0x7f) {
      return true
    }
  }
  return false
}

function isExplicitLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  if (normalized === 'localhost' || normalized === '[::1]') {
    return true
  }
  if (!LOOPBACK_IPV4_PATTERN.test(normalized)) {
    return false
  }
  return normalized
    .split('.')
    .slice(1)
    .every((part) => Number(part) >= 0 && Number(part) <= 255)
}

function safeHttpUrl(value: string | undefined | null): URL | null {
  if (!value) {
    return null
  }
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null
  } catch {
    return null
  }
}

function rawAuthorityHostname(authority: string): string | null {
  const hostAndPort = authority.slice(authority.lastIndexOf('@') + 1)
  if (hostAndPort.startsWith('[')) {
    const close = hostAndPort.indexOf(']')
    return close > 0 ? hostAndPort.slice(0, close + 1) : null
  }
  const colon = hostAndPort.lastIndexOf(':')
  if (colon >= 0 && /^\d+$/.test(hostAndPort.slice(colon + 1))) {
    return hostAndPort.slice(0, colon)
  }
  return hostAndPort
}

/**
 * Defense-in-depth for the browser navigation target. The gateway performs the
 * canonical validation, then the client independently rejects unsafe URLs and
 * the actual app/API hostnames (ports do not matter for cookie delivery).
 */
export function resolveWorkflowsPublicUrl(
  publicUrl: string | null,
  apiHost: string | undefined | null,
  browserOrigin: string | undefined | null,
): string | null {
  if (
    !publicUrl ||
    publicUrl.length > MAX_PUBLIC_URL_LENGTH ||
    publicUrl !== publicUrl.trim() ||
    containsControlCharacter(publicUrl) ||
    publicUrl.includes('\\') ||
    !/^https?:\/\//i.test(publicUrl)
  ) {
    return null
  }
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(publicUrl)?.[1]
  const authorityHostname = authority ? rawAuthorityHostname(authority) : null
  if (!authority || !authorityHostname || /[%\s]/.test(authority) || authorityHostname.endsWith('.')) {
    return null
  }

  const target = safeHttpUrl(publicUrl)
  if (!target || target.username || target.password || target.search || target.hash) {
    return null
  }
  if (authorityHostname.toLowerCase() !== target.hostname.toLowerCase()) {
    return null
  }
  if (target.protocol === 'http:' && !isExplicitLoopback(target.hostname)) {
    return null
  }

  const api = safeHttpUrl(apiHost)
  const browser = safeHttpUrl(browserOrigin)
  const targetHostname = target.hostname.toLowerCase()
  if (
    (api && api.hostname.toLowerCase() === targetHostname) ||
    (browser && browser.hostname.toLowerCase() === targetHostname)
  ) {
    return null
  }
  return target.toString()
}

/**
 * Open the already-validated external target without an opener or referrer.
 * Browsers may deliberately return `null` when `noopener` is requested even
 * though the tab opened, so the return value must not be treated as a popup
 * failure signal.
 */
export function openExternalWorkflowsUrl(
  publicUrl: string,
  openWindow: (url: string, target: string, features: string) => Window | null = window.open.bind(window),
): void {
  void openWindow(publicUrl, '_blank', 'noopener,noreferrer')
}

export function parseWorkflowsStatus(data: unknown): WorkflowsStatus | null {
  if (!data || typeof data !== 'object') {
    return null
  }
  const raw = data as Record<string, unknown>
  if (
    typeof raw.enabled !== 'boolean' ||
    typeof raw.available !== 'boolean' ||
    typeof raw.configurationError !== 'boolean' ||
    raw.authentication !== 'n8n' ||
    (raw.publicUrl !== null && typeof raw.publicUrl !== 'string')
  ) {
    return null
  }
  if ((!raw.enabled || !raw.available) && raw.publicUrl !== null) {
    return null
  }
  if (
    (!raw.enabled && (raw.available || raw.configurationError)) ||
    (raw.available && raw.configurationError) ||
    (raw.enabled && !raw.available && !raw.configurationError)
  ) {
    return null
  }
  if (raw.available && (typeof raw.publicUrl !== 'string' || raw.publicUrl.length === 0)) {
    return null
  }
  return {
    enabled: raw.enabled,
    available: raw.available,
    publicUrl: raw.publicUrl as string | null,
    configurationError: raw.configurationError,
    authentication: 'n8n',
  }
}

type Listener = (state: WorkflowsStatusState) => void

export class WorkflowsStatusService {
  private state: WorkflowsStatusState = { kind: 'unknown' }
  private listeners = new Set<Listener>()
  private inflight: Promise<void> | undefined
  private generation = 0

  get(): WorkflowsStatusState {
    return this.state
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  reset(): void {
    // Invalidate any response started under the previous account/session. The
    // underlying request may still complete, but it must never publish stale
    // discovery metadata into the next signed-in user's state.
    this.generation += 1
    this.inflight = undefined
    this.setState({ kind: 'unknown' })
  }

  async refresh(application: WebApplication): Promise<void> {
    if (!application.sessions.isSignedIn()) {
      this.generation += 1
      this.inflight = undefined
      this.setState({ kind: 'unavailable' })
      return
    }
    if (this.inflight) {
      return this.inflight
    }
    if (this.state.kind !== 'loaded') {
      this.setState({ kind: 'loading' })
    }

    const generation = this.generation
    this.inflight = (async () => {
      try {
        const { ok, data } = await application.serverGetJsonRequest<unknown>('/v1/workflows/status')
        if (generation !== this.generation) {
          return
        }
        const status = ok ? parseWorkflowsStatus(data) : null
        this.setState(status ? { kind: 'loaded', status } : { kind: 'unavailable' })
      } catch {
        if (generation === this.generation) {
          this.setState({ kind: 'unavailable' })
        }
      } finally {
        if (generation === this.generation) {
          this.inflight = undefined
        }
      }
    })()

    return this.inflight
  }

  private setState(state: WorkflowsStatusState): void {
    this.state = state
    for (const listener of this.listeners) {
      listener(state)
    }
  }
}

export const workflowsStatusService = new WorkflowsStatusService()
