import { inject } from 'inversify'
import { Request } from 'express'
import { BaseHttpController, controller, httpPost, results } from 'inversify-express-utils'
import { verifyStorageUsageRequest } from '@standardnotes/domain-core'
import { FileStorageUsage } from '../../Domain/Services/FileStorageUsage'

@controller('/internal/storage-usage')
export class AnnotatedStorageUsageController extends BaseHttpController {
  constructor(@inject(FileStorageUsage) private usage: FileStorageUsage) {
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
      return this.json({ error: 'File usage unavailable' }, 503)
    }
  }
}
