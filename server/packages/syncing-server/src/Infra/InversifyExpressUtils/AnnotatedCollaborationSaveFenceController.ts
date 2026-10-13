import { inject } from 'inversify'
import { controller, httpPost } from 'inversify-express-utils'
import { Request, Response } from 'express'
import { SQLCollaborationSaveFence } from '../TypeORM/SQLCollaborationSaveFence'
import { SyncCommandProtocolError } from '../../Domain/SyncCommand/SyncCommandTypes'

@controller('/internal/collaboration-save-fence')
export class AnnotatedCollaborationSaveFenceController {
  constructor(@inject(SQLCollaborationSaveFence) private readonly fence: SQLCollaborationSaveFence) {}

  @httpPost('/')
  async post(req: Request, res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store')
    try {
      const request = this.fence.verifyRequest(
        req.body,
        req.get('x-collaboration-fence-timestamp') ?? '',
        req.get('x-collaboration-fence-signature') ?? '',
      )
      res.json(await this.fence.request(request))
    } catch (error) {
      if (error instanceof SyncCommandProtocolError) {
        res.status(error.httpStatus).json({ error: { code: error.code, message: error.message } })
        return
      }
      res
        .status(503)
        .json({
          error: { code: 'collaboration_save_fence_unavailable', message: 'The collaboration saver is unavailable.' },
        })
    }
  }
}
