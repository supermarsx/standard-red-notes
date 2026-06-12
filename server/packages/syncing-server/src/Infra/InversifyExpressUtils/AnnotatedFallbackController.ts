import { BaseHttpController, all, controller, results } from 'inversify-express-utils'

@controller('')
export class AnnotatedFallbackController extends BaseHttpController {
  @all('/{*splat}')
  public async fallback(): Promise<results.NotFoundResult> {
    return this.notFound()
  }
}
