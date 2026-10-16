import { Request, Response } from 'express'
import { inject } from 'inversify'
import { controller, httpGet } from 'inversify-express-utils'
import { TYPES } from '../../Bootstrap/Types'
import { WebDeploymentMarkerReader } from '../../Service/Readiness/WebDeploymentMarker'

/** Public provenance, identical in scope to the static marker. API_RPC uses this
 * fixed v1 route so its browser request stays on the authenticated socket.
 */
@controller('/v1/deployment')
export class WebDeploymentController {
  constructor(@inject(TYPES.ApiGateway_WebDeploymentMarkerReader) private reader: WebDeploymentMarkerReader) {}

  @httpGet('/web')
  async web(_request: Request, response: Response): Promise<void> {
    response.setHeader('Cache-Control', 'no-store')
    const marker = await this.reader.read()
    if (marker) {
      response.status(200).json(marker)
    } else {
      response
        .status(503)
        .json({ error: { tag: 'service-unavailable', message: 'The web deployment marker is unavailable.' } })
    }
  }
}
