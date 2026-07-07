import { useEffect, useState } from 'react'
import { isErrorResponse } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'

/**
 * Standard Red Notes: SAME-ORIGIN plugin component RENDERING (client half).
 *
 * A trusted-repo plugin is installed with its EXTERNAL `hosted_url` (the plugins
 * CDN), and that URL is used as the rendering iframe's `src`. Under the strict SPA
 * CSP (`frame-src 'self' blob:`) an external iframe src is BLOCKED, so the
 * component never renders. When the operator opts in (admin
 * `plugins.sameOriginRendering`), the gateway also serves the component's files
 * SAME-ORIGIN at `/v1/plugins/component/<relPath>` (SSRF-guarded to the configured
 * trusted base). This module rewrites such a `hosted_url` to that same-origin path
 * at RENDER time so `frame-src 'self'` is satisfied WITHOUT any CSP change.
 *
 * The rewrite is done at render time (not persisted into the synced component
 * content) so: the toggle is a LIVE gate (turn it off and rendering reverts to the
 * external URL, blocked as before); nothing SN-specific is baked into data synced
 * across clients; and only URLs that actually live UNDER the configured trusted
 * base are ever touched — a component hosted anywhere else is left exactly as-is.
 *
 * The iframe stays SANDBOXED without `allow-same-origin` (see IframeFeatureView),
 * so serving same-origin grants the component NO access to the parent SN origin —
 * it runs in an opaque origin and still talks to the host only via the
 * componentManager postMessage/sessionKey protocol.
 */

export type PluginsSameOriginConfig = {
  repoUrl: string
  sameOriginRendering: boolean
}

let cachedConfigPromise: Promise<PluginsSameOriginConfig | undefined> | undefined

const fetchConfig = async (application: WebApplication): Promise<PluginsSameOriginConfig | undefined> => {
  try {
    const response = await application.legacyApi.downloadPluginsConfig()
    if (isErrorResponse(response)) {
      return undefined
    }
    const data = (response as { data?: Partial<PluginsSameOriginConfig> }).data
    if (!data || typeof data.repoUrl !== 'string' || typeof data.sameOriginRendering !== 'boolean') {
      return undefined
    }

    return { repoUrl: data.repoUrl, sameOriginRendering: data.sameOriginRendering }
  } catch (error) {
    console.error('Failed to load plugins same-origin config', error)

    return undefined
  }
}

/**
 * Fetch (and memoize for the session) the client-readable plugins config. The
 * result rarely changes and every component viewer needs it, so it is cached
 * behind a single in-flight promise.
 */
export const loadPluginsSameOriginConfig = (
  application: WebApplication,
): Promise<PluginsSameOriginConfig | undefined> => {
  if (!cachedConfigPromise) {
    cachedConfigPromise = fetchConfig(application)
  }

  return cachedConfigPromise
}

/** Test/hot-reload seam: drop the memoized config so the next call refetches. */
export const resetPluginsSameOriginConfigCache = (): void => {
  cachedConfigPromise = undefined
}

const stripTrailingSlashes = (value: string): string => value.replace(/\/+$/, '')

/**
 * Rewrite a component's `hosted_url` to the same-origin component route WHEN the
 * opt-in is on AND the URL lives under the configured trusted repo base. Returns
 * the original URL unchanged in every other case (opt-in off, empty url, or a
 * host outside the trusted base). PURE + exported so the containment check is
 * unit-testable in isolation.
 */
export const rewriteComponentUrlForSameOrigin = (
  url: string,
  config: PluginsSameOriginConfig | undefined,
): string => {
  if (!config || !config.sameOriginRendering || !url) {
    return url
  }

  const base = stripTrailingSlashes(config.repoUrl)
  if (base.length === 0) {
    return url
  }

  // Only a URL that IS the base or sits UNDER the base directory is eligible; a
  // sibling whose name merely shares the base as a prefix (".../dist-evil/...")
  // must NOT match, so require the base to be followed by a path separator.
  const isUnderBase = url === base || url.startsWith(`${base}/`)
  if (!isUnderBase) {
    return url
  }

  // The file path relative to the base, with any query/hash dropped (a component
  // index is a plain file). Each segment is encoded by pluginsComponentPath.
  const relativePath = url.slice(base.length).replace(/^\/+/, '').split(/[?#]/)[0]
  if (relativePath.length === 0) {
    return url
  }

  return pluginsComponentPath(relativePath)
}

/**
 * Build the same-origin component-serve path. Root-relative (`/v1/...`) so the
 * iframe always loads from the SPA's OWN origin (satisfying `frame-src 'self'`)
 * regardless of the configured API host. Segments are encoded but slashes are
 * preserved so the component's relative asset refs resolve back through the route.
 */
const pluginsComponentPath = (relativePath: string): string =>
  `/v1/plugins/component/${relativePath
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`

/**
 * React hook: the memoized plugins same-origin config (undefined until loaded, or
 * if the endpoint is unavailable). Safe to call from any component viewer.
 */
export const usePluginsSameOriginConfig = (application: WebApplication): PluginsSameOriginConfig | undefined => {
  const [config, setConfig] = useState<PluginsSameOriginConfig | undefined>(undefined)

  useEffect(() => {
    let active = true
    void loadPluginsSameOriginConfig(application).then((resolved) => {
      if (active) {
        setConfig(resolved)
      }
    })

    return () => {
      active = false
    }
  }, [application])

  return config
}
