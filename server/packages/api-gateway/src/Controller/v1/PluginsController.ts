import { Request, Response } from 'express'
import { inject } from 'inversify'
import { BaseHttpController, controller, httpGet } from 'inversify-express-utils'

import { TYPES } from '../../Bootstrap/Types'
import { PluginsProxyService } from '../../Service/Plugins/PluginsProxyService'
import { ServerSettingsResolver } from '../../Service/ServerSettings/ServerSettingsResolver'

/**
 * Standard Red Notes: SAME-ORIGIN plugins (extensions) gallery proxy.
 *
 * The web client used to fetch the plugins index (`packages.json`) DIRECTLY from
 * raw.githubusercontent.com, which the strict SPA CSP (`connect-src 'self'`)
 * blocks — so the browse-plugins gallery never loaded. These endpoints let the
 * client fetch the index (and individual package files) from the SAME origin;
 * the gateway performs the outbound fetch against the operator-configured repo
 * base (PLUGINS_REPO_URL env / the admin `plugins.repoUrl` overlay). No CSP
 * change is needed.
 *
 *   GET /v1/plugins/index               -> the repo `packages.json` (JSON)      [session]
 *   GET /v1/plugins/download?path=<rel> -> one package file under the base      [session]
 *   GET /v1/plugins/config              -> { repoUrl, sameOriginRendering }     [session]
 *   GET /v1/plugins/component/<relPath> -> a component file, served for the     [PUBLIC]
 *                                          RENDERING iframe (opt-in)
 *
 * index/download/config are session-authed like the other feature endpoints (the
 * client attaches its token over XHR). The COMPONENT route is DIFFERENT: it backs
 * an <iframe src="..."> top-level navigation, which the browser fetches with NO
 * Authorization header, so it MUST be reachable without one — exactly like the
 * native `/components/` static assets. It is safe to leave unauthenticated because
 * (a) it is GATED behind the admin `plugins.sameOriginRendering` opt-in (404 when
 * off, so a stock deploy exposes nothing new), (b) it only ever serves files that
 * the SSRF guard resolves UNDER the operator-configured trusted repo base — which
 * are already public CDN content — never an arbitrary host/URL, and (c) each
 * fetch is timeout- and size-capped. See PluginsProxyService for the guard.
 *
 * ---------------------------------------------------------------------------
 * WHY SAME-ORIGIN SERVING IS SAFE FOR THE RENDERING IFRAME
 * ---------------------------------------------------------------------------
 * Serving third-party code from the SN origin is why the feature is OPT-IN. It
 * does NOT grant the component extra trust: the client renders it in a SANDBOXED
 * iframe WITHOUT `allow-same-origin` (IframeFeatureView), so the document runs in
 * an OPAQUE origin and cannot touch the parent SN DOM / localStorage / cookies /
 * IndexedDB. It still talks to the host only via the componentManager postMessage
 * protocol (gated by a per-viewer sessionKey), exactly as when it was hosted
 * externally. Same-origin only changes the URL the CSP `frame-src` sees — not the
 * isolation boundary. We deliberately do NOT attach the SPA CSP to these
 * responses (nginx scopes it to `location /`, not `/v1`): the opaque-origin
 * document would fail its own `script-src 'self'`. We DO set nosniff + explicit,
 * extension-derived Content-Types (raw.githubusercontent serves everything as
 * text/plain, which would stop the browser executing JS / rendering HTML) and a
 * permissive CORS header so the opaque-origin document can load its own fonts.
 */

/** Map a file extension to a browser Content-Type for a served component file. */
const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  wasm: 'application/wasm',
  txt: 'text/plain; charset=utf-8',
}

/**
 * Content-Type for a served component file, derived from its extension (NOT the
 * upstream header, which is text/plain for every file on raw.githubusercontent).
 * Unknown extensions fall back to octet-stream so an unexpected file is never
 * mislabeled as executable/renderable.
 */
export function contentTypeForPath(pathname: string): string {
  const clean = pathname.split(/[?#]/)[0]
  const lastSegment = clean.substring(clean.lastIndexOf('/') + 1)
  const dot = lastSegment.lastIndexOf('.')
  const ext = dot >= 0 ? lastSegment.substring(dot + 1).toLowerCase() : ''

  return CONTENT_TYPE_BY_EXTENSION[ext] ?? 'application/octet-stream'
}

@controller('/v1/plugins')
export class PluginsController extends BaseHttpController {
  constructor(
    @inject(TYPES.ApiGateway_PluginsProxyService) private pluginsProxyService: PluginsProxyService,
    @inject(TYPES.ApiGateway_ServerSettingsResolver) private serverSettingsResolver: ServerSettingsResolver,
  ) {
    super()
  }

  @httpGet('/index', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async index(_request: Request, response: Response): Promise<void> {
    const result = await this.pluginsProxyService.fetchIndex()
    if ('error' in result) {
      response.status(this.statusForError(result.error)).json({
        error: { tag: `plugins-index-${result.error}`, message: this.messageForError(result.error) },
      })

      return
    }

    // packages.json is JSON — pass the upstream body through verbatim with a JSON
    // content type so the client can parse it directly.
    response.status(200)
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.send(result.body)
  }

  @httpGet('/download', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async download(request: Request, response: Response): Promise<void> {
    const path = typeof request.query.path === 'string' ? request.query.path : ''
    if (path.length === 0) {
      response.status(400).json({ error: { tag: 'plugins-download-invalid-path', message: 'A path is required.' } })

      return
    }

    const result = await this.pluginsProxyService.fetchFile(path)
    if ('error' in result) {
      response.status(this.statusForError(result.error)).json({
        error: { tag: `plugins-download-${result.error}`, message: this.messageForError(result.error) },
      })

      return
    }

    response.status(200)
    response.setHeader('Content-Type', result.contentType)
    response.send(result.body)
  }

  /**
   * Standard Red Notes: the client-readable plugins config (session-authed). The
   * web client reads this to decide whether to rewrite an installed trusted-repo
   * component's `hosted_url` to the same-origin component route. `repoUrl` is the
   * effective trusted base (needed to recognize a hosted_url that lives under it
   * and compute its relative path); `sameOriginRendering` is the admin opt-in.
   * Neither value is a secret (the base is already effectively public via the
   * index), so returning them to an authenticated client is safe.
   */
  @httpGet('/config', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async config(_request: Request, response: Response): Promise<void> {
    const [repoUrl, sameOriginRendering] = await Promise.all([
      this.serverSettingsResolver.resolvePluginsRepoUrl(),
      this.serverSettingsResolver.resolvePluginsSameOriginRendering(),
    ])

    response.status(200).json({ repoUrl, sameOriginRendering })
  }

  /**
   * Standard Red Notes: serve a single trusted-repo component file SAME-ORIGIN so
   * its RENDERING iframe satisfies the strict CSP `frame-src 'self'`. UNAUTHENTICATED
   * on purpose (an iframe navigation carries no token) but GATED behind the admin
   * `plugins.sameOriginRendering` opt-in (404 when off) and SSRF-guarded to the
   * configured base. The wildcard (`req.params[0]`) is the file path RELATIVE to
   * the repo base — including the component directory hierarchy — so a component's
   * own relative asset refs (`./main.js`, `static/js/x.js`) resolve back through
   * this same route and stay under the base. See the class doc for the isolation
   * rationale.
   */
  @httpGet('/component/*')
  async component(request: Request, response: Response): Promise<void> {
    // OFF by default: expose nothing beyond today's behavior unless an admin opts in.
    if (!(await this.serverSettingsResolver.resolvePluginsSameOriginRendering())) {
      response
        .status(404)
        .json({ error: { tag: 'plugins-component-disabled', message: 'Same-origin plugin rendering is disabled.' } })

      return
    }

    const relativePath = typeof request.params[0] === 'string' ? request.params[0] : ''
    if (relativePath.length === 0) {
      response
        .status(400)
        .json({ error: { tag: 'plugins-component-invalid-path', message: 'A component path is required.' } })

      return
    }

    const result = await this.pluginsProxyService.fetchFile(relativePath)
    if ('error' in result) {
      response.status(this.statusForError(result.error)).json({
        error: { tag: `plugins-component-${result.error}`, message: this.messageForError(result.error) },
      })

      return
    }

    // Correct, extension-derived Content-Type (never the upstream text/plain) so
    // the browser executes JS / renders HTML. nosniff pins that type; the
    // permissive CORS header lets the opaque-origin sandboxed document load its
    // own fonts/assets (mirrors the native `/components/` nginx block).
    response.status(200)
    response.setHeader('Content-Type', contentTypeForPath(relativePath))
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.send(result.body)
  }

  private statusForError(error: string): number {
    switch (error) {
      case 'outside-base':
      case 'invalid-path':
        // The client asked for something outside the configured repo base — a
        // client error (and the SSRF guard's refusal), not a server fault.
        return 400
      case 'too-large':
        return 413
      default:
        // unreachable / upstream: the remote repo is the problem, surface 502.
        return 502
    }
  }

  private messageForError(error: string): string {
    switch (error) {
      case 'outside-base':
        return 'The requested path is outside the configured plugins repository.'
      case 'invalid-path':
        return 'Invalid plugins path.'
      case 'too-large':
        return 'The plugins response exceeded the allowed size.'
      default:
        return 'The plugins repository could not be reached.'
    }
  }
}
