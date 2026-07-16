/**
 * Standard Red Notes: OPT-IN, locked-down CONTAINER restart via a
 * docker-socket-proxy sidecar. Talks the Docker Engine API
 * (`POST /containers/{id}/restart`) over the proxy's HTTP endpoint — NEVER a raw
 * `/var/run/docker.sock`. This is the mechanism the admin panel uses to restart
 * the infrastructure containers (Redis cache + MariaDB) that do NOT run under the
 * server container's supervisord (see ServiceControlService for those).
 *
 * OFF BY DEFAULT. It activates only when an operator BOTH:
 *   (a) sets the enable flag + proxy URL (SERVICE_CONTROL_DOCKER_ENABLED=true +
 *       SERVICE_CONTROL_DOCKER_PROXY_URL), AND
 *   (b) actually runs the least-privilege proxy (compose `--profile ops`).
 * When either is missing, or the proxy is unreachable, every call degrades to a
 * clear `disabled`/`unavailable` outcome (like the supervisorctl unavailable
 * path) — NEVER a throw / 500, and the UI shows "not available".
 *
 * SAFETY:
 *   - Allowlist: only the exact logical names in `allowedContainers` (the compose
 *     SERVICE names {cache, db}) are ever acted on; anything else short-circuits
 *     to `invalid-container` with NO HTTP call.
 *   - No shell, no raw socket: the logical name is mapped to a compose container
 *     name and URL-ENCODED into the Engine API path; the raw docker socket is
 *     mounted ONLY into the proxy, never into this (server) container.
 *   - Least privilege: the proxy is configured to allow ONLY the restart
 *     endpoint (deny everything else), so even a bug here cannot do more than
 *     restart an allowlisted container.
 */

/**
 * Discriminated outcome of a container-restart attempt. The controller maps each
 * `kind` onto an HTTP status; the service itself NEVER throws so a disabled or
 * unreachable proxy degrades to a clear result instead of a 500.
 */
export type DockerRestartOutcome =
  | { kind: 'ok'; container: string; name: string }
  | { kind: 'disabled' }
  | { kind: 'invalid-container'; container: string }
  | { kind: 'unavailable'; message: string }
  | { kind: 'error'; container: string; message: string }

/** Minimal HTTP response shape the service reads back from the proxy. */
export interface DockerFetchResult {
  status: number
  text: () => Promise<string>
}

/**
 * Injection seam: performs one HTTP request against the docker-socket-proxy.
 * Kept abstract so the service is unit-testable without a real proxy/daemon, and
 * so the ONLY place a real request is made goes through the runtime's fetch.
 */
export type DockerFetchRunner = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<DockerFetchResult>

export interface DockerServiceControlServiceOptions {
  enabled?: boolean
  proxyUrl?: string
  /** Compose project name — the prefix of default container names. */
  project?: string
  /** Logical (compose service) names that may be restarted. */
  allowedContainers?: string[]
  /** Explicit logical -> actual container-name overrides (wins over the default). */
  containerNames?: Record<string, string>
  runner?: DockerFetchRunner
  timeoutMs?: number
}

/** The compose SERVICE names the admin panel may restart through the proxy. */
export const DEFAULT_DOCKER_RESTARTABLE_CONTAINERS: string[] = ['cache', 'db']

export class DockerServiceControlService {
  private readonly enabled: boolean
  private readonly proxyBaseUrl: string
  private readonly project: string
  private readonly allowedContainers: string[]
  private readonly containerNames: Record<string, string>
  private readonly runner: DockerFetchRunner
  private readonly timeoutMs: number

  constructor(options: DockerServiceControlServiceOptions = {}) {
    this.enabled = options.enabled ?? false
    // Normalise: no trailing slash so path concatenation is clean.
    this.proxyBaseUrl = (options.proxyUrl ?? '').trim().replace(/\/+$/, '')
    this.project = options.project ?? 'standard-red-notes'
    this.allowedContainers = options.allowedContainers ?? DEFAULT_DOCKER_RESTARTABLE_CONTAINERS
    this.containerNames = options.containerNames ?? {}
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.runner = options.runner ?? this.defaultRunner()
  }

  /**
   * True only when an operator has BOTH set the enable flag AND supplied the
   * proxy URL. The capability being "enabled" says nothing about the proxy
   * actually being reachable — that is isAvailable().
   */
  isEnabled(): boolean {
    return this.enabled && this.proxyBaseUrl !== ''
  }

  /** The allowlisted logical container names the UI may render controls for. */
  getAllowedContainers(): string[] {
    return [...this.allowedContainers]
  }

  isAllowed(name: string): boolean {
    return this.allowedContainers.includes(name)
  }

  /**
   * Resolve a logical (compose service) name to the ACTUAL container name the
   * Docker Engine API restarts by. An explicit override wins; otherwise the
   * default compose v2 name `<project>-<service>-1`.
   */
  containerNameFor(name: string): string {
    return this.containerNames[name] ?? `${this.project}-${name}-1`
  }

  /**
   * Probe whether the proxy is reachable. Any HTTP answer (even a 403 for a
   * denied endpoint) proves the proxy is up; only a connection failure/timeout
   * counts as unavailable. Needs NO Docker permission, so it works with the
   * strictest proxy config. Returns false immediately when not enabled.
   */
  async isAvailable(): Promise<boolean> {
    if (!this.isEnabled()) {
      return false
    }
    try {
      await this.request('GET', '/_ping')

      return true
    } catch {
      return false
    }
  }

  /**
   * Restart one allowlisted container through the proxy. Enforces the allowlist
   * (no HTTP call for a non-allowlisted name), then POSTs the Engine API restart
   * and maps the response. Never throws.
   */
  async restart(name: string): Promise<DockerRestartOutcome> {
    if (!this.isEnabled()) {
      return { kind: 'disabled' }
    }
    if (!this.isAllowed(name)) {
      return { kind: 'invalid-container', container: name }
    }

    const container = this.containerNameFor(name)

    let result: DockerFetchResult
    try {
      // Docker Engine API: 204 No Content on success. The container name is
      // URL-encoded (belt-and-braces; the allowlist already gates the value).
      result = await this.request('POST', `/containers/${encodeURIComponent(container)}/restart`)
    } catch {
      return {
        kind: 'unavailable',
        message:
          'Container control is not available: the docker-socket-proxy could not be reached. Ensure the `ops` profile is running.',
      }
    }

    if (result.status === 204 || result.status === 304) {
      return { kind: 'ok', container: name, name: container }
    }
    if (result.status === 404) {
      return { kind: 'error', container: name, message: `No such container: ${container}.` }
    }
    if (result.status === 403) {
      return {
        kind: 'error',
        container: name,
        message: 'The docker-socket-proxy denied the restart. Check its allowlist (only restart must be permitted).',
      }
    }

    let detail = ''
    try {
      detail = (await result.text()).trim().slice(0, 200)
    } catch {
      // ignore body read failure
    }

    return {
      kind: 'error',
      container: name,
      message:
        detail !== '' ? `Restart failed (HTTP ${result.status}): ${detail}` : `Restart failed (HTTP ${result.status}).`,
    }
  }

  private async request(method: string, path: string): Promise<DockerFetchResult> {
    return this.runner(`${this.proxyBaseUrl}${path}`, {
      method,
      headers: { Accept: 'application/json' },
    })
  }

  private defaultRunner(): DockerFetchRunner {
    return async (url, init) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const response = await (
          globalThis.fetch as unknown as (
            url: string,
            init: { method: string; headers: Record<string, string>; signal?: AbortSignal },
          ) => Promise<DockerFetchResult>
        )(url, { ...init, signal: controller.signal })

        return response
      } finally {
        clearTimeout(timer)
      }
    }
  }
}
