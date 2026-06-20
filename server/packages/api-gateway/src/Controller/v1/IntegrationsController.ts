import { Request, Response } from 'express'
import { inject } from 'inversify'
import { BaseHttpController, controller, httpPost } from 'inversify-express-utils'

import { TYPES } from '../../Bootstrap/Types'
import {
  GitHubPublishRequest,
  GitHubPublishService,
  GitHubPublishValidationError,
} from '../../Service/Integrations/GitHubPublishService'

/**
 * Standard Red Notes: optional server-mediated integrations.
 *
 * `POST /v1/integrations/github/publish` pushes a single note (already converted
 * to Markdown by the client) to a GitHub repository using a user-supplied
 * Personal Access Token. It is authenticated (RequiredCrossServiceTokenMiddleware)
 * so only a logged-in user can spend an outbound request.
 *
 * PRIVACY: this endpoint receives the note's DECRYPTED content and the user's
 * PAT, forwards both to GitHub, and returns. Neither value is persisted or
 * logged. The feature does nothing unless a user explicitly calls it.
 */
@controller('/v1/integrations')
export class IntegrationsController extends BaseHttpController {
  constructor(
    @inject(TYPES.ApiGateway_GitHubPublishService) private gitHubPublishService: GitHubPublishService,
  ) {
    super()
  }

  @httpPost('/github/publish', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async publishToGitHub(request: Request, response: Response): Promise<void> {
    const body = (request.body ?? {}) as Partial<GitHubPublishRequest>

    try {
      const result = await this.gitHubPublishService.publish(body)

      if (result.ok) {
        response.status(200).json({
          created: result.created,
          path: result.path,
          contentUrl: result.contentUrl,
          commitUrl: result.commitUrl,
        })
        return
      }

      response.status(result.status >= 400 && result.status < 600 ? result.status : 502).json({
        error: { tag: result.tag, message: result.message },
      })
    } catch (error) {
      if (error instanceof GitHubPublishValidationError) {
        response.status(400).json({
          error: { tag: error.tag, message: error.message },
        })
        return
      }

      // Defensive: never let an unexpected error bubble the PAT/content into the
      // global error handler's request-body logging path. We log only a generic
      // message here (no body, no token).
      response.status(500).json({
        error: {
          tag: 'publish-failed',
          message: 'Could not publish the note to GitHub. Please try again.',
        },
      })
    }
  }
}
