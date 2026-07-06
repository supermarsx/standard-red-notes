import { Request, Response } from 'express'
import { inject } from 'inversify'
import { BaseHttpController, controller, httpGet } from 'inversify-express-utils'

import { TYPES } from '../../Bootstrap/Types'
import { PluginsProxyService } from '../../Service/Plugins/PluginsProxyService'

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
 * Authenticated (session required) like the other feature endpoints: the fetch
 * spends server-side network I/O, and gating it keeps this from being an open
 * relay on top of the base-restriction SSRF guard (see PluginsProxyService).
 *
 *   GET /v1/plugins/index               -> the repo `packages.json` (JSON)
 *   GET /v1/plugins/download?path=<rel> -> one package file under the base
 */
@controller('/v1/plugins')
export class PluginsController extends BaseHttpController {
  constructor(
    @inject(TYPES.ApiGateway_PluginsProxyService) private pluginsProxyService: PluginsProxyService,
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
