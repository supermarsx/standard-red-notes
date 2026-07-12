import { UserRequestType } from '@standardnotes/common'
import { type RootKeyParamsInterface } from '@standardnotes/models'
import { HttpResponse } from '@standardnotes/responses'

import { UserDeletionResponseBody } from '../../Response/User/UserDeletionResponseBody'
import { UserRegistrationResponseBody } from '../../Response/User/UserRegistrationResponseBody'
import { UserRequestResponseBody } from '../../Response/UserRequest/UserRequestResponseBody'
import { UserUpdateResponse } from '../../Response/User/UserUpdateResponse'

export interface UserApiServiceInterface {
  register(registerDTO: {
    email: string
    serverPassword: string
    hvmToken?: string
    keyParams: RootKeyParamsInterface
    ephemeral: boolean
    // Standard Red Notes: optional workspace name for "multiple accounts per
    // email" (WORKSPACES_PER_EMAIL_ENABLED). Sent as workspace_identifier; the
    // server ignores it unless the feature flag is on.
    workspaceIdentifier?: string
    // Standard Red Notes: optional Proof-of-Work fields sent as pow_seed/pow_nonce
    // when resubmitting after a `proof-of-work-required` challenge.
    powSeed?: string
    powNonce?: string
    // Standard Red Notes: optional invite-URL token, sent as invite_token only
    // when supplied (INVITE-URL signup control).
    inviteToken?: string
  }): Promise<HttpResponse<UserRegistrationResponseBody>>
  updateUser(updateDTO: { userUuid: string }): Promise<HttpResponse<UserUpdateResponse>>

  submitUserRequest(dto: {
    userUuid: string
    requestType: UserRequestType
  }): Promise<HttpResponse<UserRequestResponseBody>>

  deleteAccount(dto: {
    userUuid: string
    serverPassword: string | undefined
  }): Promise<HttpResponse<UserDeletionResponseBody>>
}
