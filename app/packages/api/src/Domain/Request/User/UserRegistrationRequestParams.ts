import { AnyKeyParamsContent } from '@standardnotes/common'
import { ApiEndpointParam } from '@standardnotes/responses'

export type UserRegistrationRequestParams = AnyKeyParamsContent & {
  [ApiEndpointParam.ApiVersion]: string
  [additionalParam: string]: unknown
  password: string
  email: string
  hvm_token?: string
  ephemeral: boolean
  // Standard Red Notes: optional invite-URL token (INVITE-URL signup control).
  // Only present when the client captured a `?invite=<token>` param; the server
  // ignores it unless invite-only mode is on or the link carries batch slots.
  invite_token?: string
}
