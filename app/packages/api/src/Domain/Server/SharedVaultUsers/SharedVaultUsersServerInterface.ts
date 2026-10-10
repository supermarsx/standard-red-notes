import { HttpResponse } from '@standardnotes/responses'
import { Uuid } from '@standardnotes/domain-core'

import { GetSharedVaultUsersRequestParams } from '../../Request/SharedVaultUser/GetSharedVaultUsersRequestParams'
import { DeleteSharedVaultUserRequestParams } from '../../Request/SharedVaultUser/DeleteSharedVaultUserRequestParams'
import { DeleteSharedVaultUserResponse } from '../../Response/SharedVaultUsers/DeleteSharedVaultUserResponse'
import { GetSharedVaultUsersResponse } from '../../Response/SharedVaultUsers/GetSharedVaultUsersResponse'
import { DesignateSurvivorResponse } from '../../Response/SharedVaultUsers/DesignateSurvivorResponse'
import { UpdateSharedVaultUserPermissionRequestParams } from '../../Request/SharedVaultUser/UpdateSharedVaultUserPermissionRequestParams'
import { UpdateSharedVaultUserPermissionResponse } from '../../Response/SharedVaultUsers/UpdateSharedVaultUserPermissionResponse'

export interface SharedVaultUsersServerInterface {
  getSharedVaultUsers(params: GetSharedVaultUsersRequestParams): Promise<HttpResponse<GetSharedVaultUsersResponse>>
  designateSurvivor(params: {
    sharedVaultUuid: Uuid
    sharedVaultMemberUuid: Uuid
  }): Promise<HttpResponse<DesignateSurvivorResponse>>
  deleteSharedVaultUser(
    params: DeleteSharedVaultUserRequestParams,
  ): Promise<HttpResponse<DeleteSharedVaultUserResponse>>
  updateSharedVaultUserPermission(
    params: UpdateSharedVaultUserPermissionRequestParams,
  ): Promise<HttpResponse<UpdateSharedVaultUserPermissionResponse>>
}
