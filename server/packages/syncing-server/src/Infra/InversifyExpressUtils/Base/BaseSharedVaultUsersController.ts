import { Request, Response } from 'express'
import { BaseHttpController, results } from 'inversify-express-utils'
import { HttpStatusCode } from '@standardnotes/responses'
import { ControllerContainerInterface, MapperInterface, SharedVaultUser } from '@standardnotes/domain-core'

import { SharedVaultUserHttpRepresentation } from '../../../Mapping/Http/SharedVaultUserHttpRepresentation'
import { GetSharedVaultUsers } from '../../../Domain/UseCase/SharedVaults/GetSharedVaultUsers/GetSharedVaultUsers'
import { RemoveUserFromSharedVault } from '../../../Domain/UseCase/SharedVaults/RemoveUserFromSharedVault/RemoveUserFromSharedVault'
import { DesignateSurvivor } from '../../../Domain/UseCase/SharedVaults/DesignateSurvivor/DesignateSurvivor'
import { UpdateSharedVaultUserPermission } from '../../../Domain/UseCase/SharedVaults/UpdateSharedVaultUserPermission/UpdateSharedVaultUserPermission'
import { ResponseLocals } from '../ResponseLocals'

export class BaseSharedVaultUsersController extends BaseHttpController {
  constructor(
    protected getSharedVaultUsersUseCase: GetSharedVaultUsers,
    protected removeUserFromSharedVaultUseCase: RemoveUserFromSharedVault,
    protected designateSurvivorUseCase: DesignateSurvivor,
    protected updateSharedVaultUserPermissionUseCase: UpdateSharedVaultUserPermission,
    protected sharedVaultUserHttpMapper: MapperInterface<SharedVaultUser, SharedVaultUserHttpRepresentation>,
    private controllerContainer?: ControllerContainerInterface,
  ) {
    super()

    if (this.controllerContainer !== undefined) {
      this.controllerContainer.register('sync.shared-vault-users.get-users', this.getSharedVaultUsers.bind(this))
      this.controllerContainer.register(
        'sync.shared-vault-users.remove-user',
        this.removeUserFromSharedVault.bind(this),
      )
      this.controllerContainer.register('sync.shared-vault-users.designate-survivor', this.designateSurvivor.bind(this))
      // Without this line a single-container deployment answers
      // 500 "Method sync.shared-vault-users.update-permission not found" while the build,
      // the decorated multi-container route and every use-case spec stay green --
      // the failure mode that left all nine invite endpoints dead for a release.
      this.controllerContainer.register(
        'sync.shared-vault-users.update-permission',
        this.updateSharedVaultUserPermission.bind(this),
      )
    }
  }

  async getSharedVaultUsers(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    const result = await this.getSharedVaultUsersUseCase.execute({
      originatorUuid: locals.user.uuid,
      sharedVaultUuid: request.params.sharedVaultUuid as string,
    })

    if (result.isFailed()) {
      return this.json(
        {
          error: {
            message: result.getError(),
          },
        },
        HttpStatusCode.BadRequest,
      )
    }

    return this.json({
      users: result.getValue().map((sharedVault) => this.sharedVaultUserHttpMapper.toProjection(sharedVault)),
    })
  }

  async removeUserFromSharedVault(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    const result = await this.removeUserFromSharedVaultUseCase.execute({
      sharedVaultUuid: request.params.sharedVaultUuid as string,
      userUuid: request.params.userUuid as string,
      originatorUuid: locals.user.uuid,
    })

    if (result.isFailed()) {
      return this.json(
        {
          error: {
            message: result.getError(),
          },
        },
        HttpStatusCode.BadRequest,
      )
    }

    response.setHeader('x-invalidate-cache', request.params.userUuid as string)

    return this.json({
      success: true,
    })
  }

  async updateSharedVaultUserPermission(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    // `request.body` can be absent entirely on this path: Express 5 leaves it undefined
    // for a bodyless request, and the single-container proxy forwards the payload it was
    // given rather than a parsed body. Reading through `?.` keeps a missing body a 400
    // naming the parameter instead of a 500 TypeError.
    const permission = (request.body as { permission?: unknown } | undefined)?.permission

    if (typeof permission !== 'string') {
      return this.json(
        {
          error: {
            message: 'Please provide the permission to set.',
          },
        },
        HttpStatusCode.BadRequest,
      )
    }

    const result = await this.updateSharedVaultUserPermissionUseCase.execute({
      sharedVaultUuid: request.params.sharedVaultUuid as string,
      userUuid: request.params.userUuid as string,
      originatorUuid: locals.user.uuid,
      permission,
    })

    if (result.isFailed()) {
      return this.json(
        {
          error: {
            message: result.getError(),
          },
        },
        HttpStatusCode.BadRequest,
      )
    }

    // The member's cross-service token carries their vault permission
    // (`belongs_to_shared_vaults[].permission`), and BOTH file authorizers refuse an
    // upload when it reads `read`. Stamping the SUBJECT's uuid here drops their cached
    // token so the next request mints one with the new permission.
    response.setHeader('x-invalidate-cache', request.params.userUuid as string)

    return this.json({
      user: this.sharedVaultUserHttpMapper.toProjection(result.getValue()),
    })
  }

  async designateSurvivor(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    const result = await this.designateSurvivorUseCase.execute({
      sharedVaultUuid: request.params.sharedVaultUuid as string,
      userUuid: request.params.userUuid as string,
      originatorUuid: locals.user.uuid,
    })

    if (result.isFailed()) {
      return this.json(
        {
          error: {
            message: result.getError(),
          },
        },
        HttpStatusCode.BadRequest,
      )
    }

    return this.json({
      success: true,
    })
  }
}
