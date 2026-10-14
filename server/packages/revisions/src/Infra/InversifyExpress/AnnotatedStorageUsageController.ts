import { inject } from 'inversify'
import { Request } from 'express'
import { BaseHttpController, controller, httpPost, results } from 'inversify-express-utils'
import { verifyStorageUsageRequest } from '@standardnotes/domain-core'
import { RevisionStorageUsage } from '../TypeORM/SQL/RevisionStorageUsage'

@controller('/internal/storage-usage')
export class AnnotatedStorageUsageController extends BaseHttpController {
  constructor(@inject(RevisionStorageUsage) private usage: RevisionStorageUsage) {
    super()
  }
  @httpPost('/')
  async measure(request: Request): Promise<results.JsonResult> {
    if (
      !verifyStorageUsageRequest(
        this.usage.secret,
        request.headers['x-storage-timestamp'],
        request.headers['x-storage-signature'],
        request.body,
      )
    ) {
      return this.json({ error: 'Not authorized' }, 403)
    }
    try {
      return this.json(await this.usage.measure(request.body))
    } catch {
      return this.json({ error: 'Revision usage unavailable' }, 503)
    }
  }
}
