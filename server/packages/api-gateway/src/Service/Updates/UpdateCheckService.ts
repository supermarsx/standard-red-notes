/**
 * Standard Red Notes: self-hosted "Check for updates".
 *
 * The gateway — not the browser — fetches the operator-configured
 * UPDATE_CHECK_URL, so the remote release host never sees end-user IPs and the
 * client needs no CORS exemption. Because this is a self-hosted fork, the check
 * target is fully configurable; when UPDATE_CHECK_URL is unset the feature
 * reports `configured: false` and the client renders a graceful
 * "not configured" state (no errors anywhere).
 *
 * Two remote response shapes are supported:
 *   1. GitHub releases API — either the list (`GET /releases` →
 *      `[{ tag_name, html_url, published_at, draft, prerelease }, ...]`, newest
 *      first) or the single-object `GET /releases/latest` form.
 *   2. A minimal custom JSON document: `{ "version": "1.2.3", "url": "..." }`.
 *
 * Results are cached in-memory (default 15 minutes) so repeated client checks
 * do not hammer the remote; `?force=true` (the manual "Check for updates"
 * button) bypasses the cache. The service NEVER throws: network/parse failures
 * degrade to `{ configured: true, error: 'unreachable' | 'invalid-response' }`.
 */

import * as fs from 'fs'
import * as path from 'path'

export type UpdateCheckFetchLike = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    signal?: AbortSignal
    redirect?: 'follow' | 'manual' | 'error'
  },
) => Promise<{
  status: number
  ok: boolean
  json: () => Promise<unknown>
}>

export interface UpdateCheckServiceConfig {
  /** The operator-configured endpoint to check. Unset => feature not configured. */
  url?: string
  /**
   * Standard Red Notes: optional lazy URL resolution (runtime server settings).
   * When present it is consulted on EVERY getStatus call and takes precedence
   * over the static `url`, so an admin-persisted UPDATE_CHECK_URL override
   * (persisted → env precedence, see ServerSettingsResolver) takes effect on
   * the next check without a restart. Must never throw.
   */
  urlResolver?: () => Promise<string | undefined>
  /** The version this deployment reports as "current". */
  currentVersion: string
  /** How long a fetched result is served from cache. Default 15 minutes. */
  cacheTtlMs?: number
  /** Outbound fetch timeout. Default 5 seconds. */
  timeoutMs?: number
}

export interface UpdateStatus {
  configured: boolean
  currentVersion: string
  latestVersion?: string
  updateAvailable?: boolean
  releaseUrl?: string
  /** ISO timestamp of when the remote was actually contacted (cache-aware). */
  checkedAt?: string
  /** Present instead of latest/updateAvailable when the remote check failed. */
  error?: 'unreachable' | 'invalid-response'
}

const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 5 * 1000

/** Strip a leading `v`/`V` and surrounding whitespace: `v1.2.3` → `1.2.3`. */
export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '')
}

/**
 * Parse a version into numeric dot segments, ignoring any `-prerelease` /
 * `+build` suffix. Returns null when the core is not purely numeric segments —
 * callers then fall back to string inequality ("different version available").
 */
export function parseVersionSegments(version: string): number[] | null {
  const core = normalizeVersion(version).split(/[-+]/)[0]
  if (!/^\d+(\.\d+)*$/.test(core)) {
    return null
  }
  return core.split('.').map(Number)
}

/**
 * Tolerant semver-ish "is `latest` newer than `current`?". Numeric segment
 * compare with missing segments treated as 0 (`1.2` == `1.2.0`). If either
 * side is non-parseable, degrade to string inequality after normalization —
 * any DIFFERENT version is reported as an available update.
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const latestSegments = parseVersionSegments(latest)
  const currentSegments = parseVersionSegments(current)

  if (!latestSegments || !currentSegments) {
    return normalizeVersion(latest) !== normalizeVersion(current)
  }

  const length = Math.max(latestSegments.length, currentSegments.length)
  for (let i = 0; i < length; i++) {
    const a = latestSegments[i] ?? 0
    const b = currentSegments[i] ?? 0
    if (a !== b) {
      return a > b
    }
  }

  return false
}

interface ParsedRelease {
  version: string
  url?: string
}

/**
 * Extract `{ version, url }` from a remote response body. Supports the GitHub
 * releases list, the GitHub `/releases/latest` object, and the plain
 * `{ version, url }` document. Returns null for anything unrecognizable.
 */
export function parseUpdateResponse(body: unknown): ParsedRelease | null {
  if (Array.isArray(body)) {
    // GitHub `GET /releases` list — newest first. Prefer the newest entry that
    // is neither a draft nor a prerelease; fall back to the first entry.
    const releases = body.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    const stable = releases.find((entry) => entry.draft !== true && entry.prerelease !== true)
    const candidate = stable ?? releases[0]
    if (!candidate) {
      return null
    }
    return parseUpdateResponse(candidate)
  }

  if (!body || typeof body !== 'object') {
    return null
  }

  const record = body as Record<string, unknown>

  // GitHub release object (list entry or /releases/latest).
  if (typeof record.tag_name === 'string' && record.tag_name.length > 0) {
    return {
      version: record.tag_name,
      url: typeof record.html_url === 'string' ? record.html_url : undefined,
    }
  }

  // Plain `{ version, url }` document.
  if (typeof record.version === 'string' && record.version.length > 0) {
    return {
      version: record.version,
      url: typeof record.url === 'string' ? record.url : undefined,
    }
  }

  return null
}

/**
 * Resolve this package's own version by walking up from `startDir` until the
 * api-gateway package.json is found. Works from both `src/` (ts-jest) and the
 * compiled `dist/src/` layout without relying on resolveJsonModule.
 */
export function resolveOwnPackageVersion(startDir: string = __dirname): string {
  let dir = startDir
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'package.json')
    try {
      if (fs.existsSync(candidate)) {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { name?: string; version?: string }
        if (parsed.name === '@standardnotes/api-gateway' && typeof parsed.version === 'string') {
          return parsed.version
        }
      }
    } catch {
      // Unreadable/invalid candidate — keep walking up.
    }
    const parent = path.dirname(dir)
    if (parent === dir) {
      break
    }
    dir = parent
  }
  return 'unknown'
}

export class UpdateCheckService {
  private readonly cacheTtlMs: number
  private readonly timeoutMs: number
  private cached?: { status: UpdateStatus; fetchedAt: number; url: string }

  constructor(
    private fetchFn: UpdateCheckFetchLike,
    private config: UpdateCheckServiceConfig,
  ) {
    this.cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /**
   * The one public entry point. Never throws — every failure mode maps to a
   * degraded-but-valid UpdateStatus payload. The check URL is resolved lazily
   * per call (runtime settings overlay → env), and the in-memory cache is keyed
   * to the URL it was fetched from so changing the URL invalidates it.
   */
  async getStatus(force = false, now: number = Date.now()): Promise<UpdateStatus> {
    const url = await this.resolveUrl()
    if (!url) {
      return {
        configured: false,
        currentVersion: this.config.currentVersion,
      }
    }

    if (!force && this.cached && this.cached.url === url && now - this.cached.fetchedAt < this.cacheTtlMs) {
      return this.cached.status
    }

    const status = await this.performCheck(now, url)
    this.cached = { status, fetchedAt: now, url }
    return status
  }

  private async resolveUrl(): Promise<string | undefined> {
    if (this.config.urlResolver) {
      try {
        return await this.config.urlResolver()
      } catch {
        // A broken settings overlay must never take the endpoint down.
        return this.config.url
      }
    }
    return this.config.url
  }

  private async performCheck(now: number, url: string): Promise<UpdateStatus> {
    const base: UpdateStatus = {
      configured: true,
      currentVersion: this.config.currentVersion,
      checkedAt: new Date(now).toISOString(),
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    let body: unknown
    try {
      const response = await this.fetchFn(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json, application/vnd.github+json',
          'User-Agent': 'standard-red-notes-update-check',
        },
        signal: controller.signal,
        redirect: 'follow',
      })

      if (!response.ok) {
        return { ...base, error: 'unreachable' }
      }

      body = await response.json()
    } catch {
      return { ...base, error: 'unreachable' }
    } finally {
      clearTimeout(timer)
    }

    const release = parseUpdateResponse(body)
    if (!release) {
      return { ...base, error: 'invalid-response' }
    }

    return {
      ...base,
      latestVersion: normalizeVersion(release.version),
      updateAvailable: isNewerVersion(release.version, this.config.currentVersion),
      releaseUrl: release.url,
    }
  }
}
