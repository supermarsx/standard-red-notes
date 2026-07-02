import { WebApplication } from '@/Application/WebApplication'

/**
 * Standard Red Notes — Workflows (n8n-backed automation) client state.
 *
 * Mirrors the frozen GET /v1/workflows/status contract:
 *   { enabled: boolean, paired: boolean, editorUrl: string | null }
 *
 * The status is fetched once per sign-in and cached module-wide (the sidebar
 * button and the WorkflowsView share it), refetched on sign-in/out, and treated
 * as "unavailable" whenever the endpoint 404s (server without the feature
 * deployed), errors, or the user has no signed-in server session — in all of
 * those cases the Workflows UI hides itself entirely.
 */
export type WorkflowsStatus = {
  enabled: boolean
  paired: boolean
  editorUrl: string | null
}

export type WorkflowsStatusState =
  /** Not fetched yet (initial, or reset after a sign-in/out transition). */
  | { kind: 'unknown' }
  /** A fetch is in flight and there is no previous value to show. */
  | { kind: 'loading' }
  /** Endpoint 404'd / errored, or the user is not signed in — hide the feature. */
  | { kind: 'unavailable' }
  /** Successful, contract-shaped response. */
  | { kind: 'loaded'; status: WorkflowsStatus }

/**
 * Pure visibility resolver for the sidebar section button: visible only when
 * signed into a server AND the server reports the feature enabled for this
 * account. Loading/unknown/unavailable all resolve to hidden, so the button
 * never flashes for users who cannot use it.
 */
export function shouldShowWorkflowsSection(signedIn: boolean, state: WorkflowsStatusState): boolean {
  return signedIn && state.kind === 'loaded' && state.status.enabled === true
}

/**
 * Resolve the server-provided editor URL into an embeddable src.
 *
 * The contract sends a SAME-ORIGIN RELATIVE path (e.g. `/workflows-ui/`) that
 * must resolve against the API host — not the web app origin — so we join it
 * with the application host. Absolute http(s) URLs are passed through
 * (operator-configured deployments); anything else (protocol-relative `//…`,
 * `javascript:`, etc.) is rejected so the iframe can never be pointed at an
 * unexpected origin or scheme.
 */
export function resolveWorkflowsEditorUrl(host: string | undefined | null, editorUrl: string | null): string | null {
  if (!editorUrl) {
    return null
  }
  if (/^https?:\/\//i.test(editorUrl)) {
    return editorUrl
  }
  if (!editorUrl.startsWith('/') || editorUrl.startsWith('//')) {
    return null
  }
  const base = (host ?? '').replace(/\/+$/, '')
  return base ? `${base}${editorUrl}` : null
}

/** Parse a raw /v1/workflows/status body into the contract shape, or null. */
export function parseWorkflowsStatus(data: unknown): WorkflowsStatus | null {
  if (!data || typeof data !== 'object') {
    return null
  }
  const raw = data as { enabled?: unknown; paired?: unknown; editorUrl?: unknown }
  if (typeof raw.enabled !== 'boolean') {
    return null
  }
  return {
    enabled: raw.enabled,
    paired: raw.paired === true,
    editorUrl: typeof raw.editorUrl === 'string' && raw.editorUrl.length > 0 ? raw.editorUrl : null,
  }
}

type Listener = (state: WorkflowsStatusState) => void

/**
 * Tiny module-level cache + pub/sub for the workflows status (same pattern as
 * AssistantUsageService): components subscribe via useWorkflowsStatus, and the
 * WorkflowsView pushes authoritative updates after pair/unpair so the sidebar
 * button reacts without a refetch. Deduplicates concurrent refreshes.
 */
class WorkflowsStatusService {
  private state: WorkflowsStatusState = { kind: 'unknown' }
  private listeners = new Set<Listener>()
  private inflight: Promise<void> | undefined

  get(): WorkflowsStatusState {
    return this.state
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Forget the cached status (used on sign-in/out transitions). */
  reset(): void {
    this.setState({ kind: 'unknown' })
  }

  /** Push an authoritative status (e.g. from a pair/unpair response). */
  setStatus(status: WorkflowsStatus): void {
    this.setState({ kind: 'loaded', status })
  }

  /**
   * Fetch GET /v1/workflows/status (authenticated). Any non-OK response —
   * including 404 from a server that has not deployed the feature — and any
   * network/parse failure degrade to 'unavailable' (feature hidden).
   */
  async refresh(application: WebApplication): Promise<void> {
    if (!application.sessions.isSignedIn()) {
      this.setState({ kind: 'unavailable' })
      return
    }

    if (this.inflight) {
      return this.inflight
    }

    if (this.state.kind !== 'loaded') {
      this.setState({ kind: 'loading' })
    }

    this.inflight = (async () => {
      try {
        const { ok, data } = await application.serverGetJsonRequest<unknown>('/v1/workflows/status')
        const status = ok ? parseWorkflowsStatus(data) : null
        this.setState(status ? { kind: 'loaded', status } : { kind: 'unavailable' })
      } catch {
        this.setState({ kind: 'unavailable' })
      } finally {
        this.inflight = undefined
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
