import { createHmac, timingSafeEqual } from 'crypto'
import { inject } from 'inversify'
import { controller, httpGet } from 'inversify-express-utils'
import { Request, Response } from 'express'
import { Repository } from 'typeorm'
import { Uuid } from '@standardnotes/domain-core'
import TYPES from '../../Bootstrap/Types'
import { TypeORMSharedVaultUser } from '../TypeORM/TypeORMSharedVaultUser'
import { readSharedVaultMembershipSnapshot } from '../readSharedVaultMembershipSnapshot'

@controller('/internal/shared-vault-memberships')
export class AnnotatedMembershipSnapshotController {
  constructor(
    @inject(TYPES.Sync_ORMSharedVaultUserRepository) private repository: Repository<TypeORMSharedVaultUser>,
    @inject(TYPES.Sync_AUTH_JWT_SECRET) private secret: string,
  ) {}

  @httpGet('/')
  async get(req: Request, res: Response): Promise<void> {
    const timestamp = req.get('x-membership-timestamp') ?? ''
    const signature = req.get('x-membership-signature') ?? ''
    const userUuid = req.query.userUuid
    if (
      (userUuid !== undefined && (typeof userUuid !== 'string' || Uuid.create(userUuid).isFailed())) ||
      !/^\d{13}$/.test(timestamp) ||
      Math.abs(Date.now() - Number(timestamp)) > 30_000 ||
      !/^[a-f0-9]{64}$/.test(signature) ||
      !this.secret
    ) {
      res.sendStatus(401)
      return
    }
    const expected = createHmac('sha256', this.secret)
      .update(`membership-snapshot:${timestamp}:${userUuid ?? ''}`)
      .digest()
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) {
      res.sendStatus(401)
      return
    }
    res.setHeader('Cache-Control', 'no-store')
    res.json({
      complete: true,
      memberships: await readSharedVaultMembershipSnapshot(this.repository, userUuid as string | undefined),
    })
  }
}
