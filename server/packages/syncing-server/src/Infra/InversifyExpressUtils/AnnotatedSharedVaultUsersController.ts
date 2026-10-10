import { controller, httpDelete, httpGet, httpPatch, httpPost, results } from 'inversify-express-utils'
import { inject } from 'inversify'
import { MapperInterface, SharedVaultUser } from '@standardnotes/domain-core'
import { Request, Response } from 'express'

import { BaseSharedVaultUsersController } from './Base/BaseSharedVaultUsersController'
import TYPES from '../../Bootstrap/Types'
import { SharedVaultUserHttpRepresentation } from '../../Mapping/Http/SharedVaultUserHttpRepresentation'
import { GetSharedVaultUsers } from '../../Domain/UseCase/SharedVaults/GetSharedVaultUsers/GetSharedVaultUsers'
import { RemoveUserFromSharedVault } from '../../Domain/UseCase/SharedVaults/RemoveUserFromSharedVault/RemoveUserFromSharedVault'
import { DesignateSurvivor } from '../../Domain/UseCase/SharedVaults/DesignateSurvivor/DesignateSurvivor'
import { UpdateSharedVaultUserPermission } from '../../Domain/UseCase/SharedVaults/UpdateSharedVaultUserPermission/UpdateSharedVaultUserPermission'

@controller('/shared-vaults/:sharedVaultUuid/users', TYPES.Sync_AuthMiddleware)
export class AnnotatedSharedVaultUsersController extends BaseSharedVaultUsersController {
  constructor(
    @inject(TYPES.Sync_GetSharedVaultUsers) override getSharedVaultUsersUseCase: GetSharedVaultUsers,
    @inject(TYPES.Sync_RemoveSharedVaultUser) override removeUserFromSharedVaultUseCase: RemoveUserFromSharedVault,
    @inject(TYPES.Sync_DesignateSurvivor) override designateSurvivorUseCase: DesignateSurvivor,
    @inject(TYPES.Sync_UpdateSharedVaultUserPermission)
    override updateSharedVaultUserPermissionUseCase: UpdateSharedVaultUserPermission,
    @inject(TYPES.Sync_SharedVaultUserHttpMapper)
    override sharedVaultUserHttpMapper: MapperInterface<SharedVaultUser, SharedVaultUserHttpRepresentation>,
  ) {
    super(
      getSharedVaultUsersUseCase,
      removeUserFromSharedVaultUseCase,
      designateSurvivorUseCase,
      updateSharedVaultUserPermissionUseCase,
      sharedVaultUserHttpMapper,
    )
  }

  @httpGet('/')
  override async getSharedVaultUsers(request: Request, response: Response): Promise<results.JsonResult> {
    return super.getSharedVaultUsers(request, response)
  }

  @httpDelete('/:userUuid')
  override async removeUserFromSharedVault(request: Request, response: Response): Promise<results.JsonResult> {
    return super.removeUserFromSharedVault(request, response)
  }

  /**
   * PATCH, not PUT: this replaces one field of an existing membership and creates
   * nothing. `POST /:userUuid/...` would have read as a sub-action and `DELETE` is already
   * the removal, so PATCH on the member resource is the one verb that cannot be confused
   * with either.
   */
  @httpPatch('/:userUuid')
  override async updateSharedVaultUserPermission(request: Request, response: Response): Promise<results.JsonResult> {
    return super.updateSharedVaultUserPermission(request, response)
  }

  @httpPost('/:userUuid/designate-survivor')
  override async designateSurvivor(request: Request, response: Response): Promise<results.JsonResult> {
    return super.designateSurvivor(request, response)
  }
}
