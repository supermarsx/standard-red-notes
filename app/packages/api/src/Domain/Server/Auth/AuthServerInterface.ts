import { HttpResponse } from '@standardnotes/responses'
import {
  AccountRecoveryLookupRequestParams,
  RecoveryKeyParamsRequestParams,
  SignInWithRecoveryCodesRequestParams,
} from '../../Request'
import {
  AccountRecoveryLookupResponseBody,
  GenerateRecoveryCodesResponseBody,
  RecoveryKeyParamsResponseBody,
  SignInWithRecoveryCodesResponseBody,
} from '../../Response'
import { HttpRequestOptions } from '../../Http/HttpRequestOptions'

export interface AuthServerInterface {
  accountRecoveryLookup(
    params: AccountRecoveryLookupRequestParams,
  ): Promise<HttpResponse<AccountRecoveryLookupResponseBody>>
  generateRecoveryCodes(options?: HttpRequestOptions): Promise<HttpResponse<GenerateRecoveryCodesResponseBody>>
  recoveryKeyParams(params: RecoveryKeyParamsRequestParams): Promise<HttpResponse<RecoveryKeyParamsResponseBody>>
  signInWithRecoveryCodes(
    params: SignInWithRecoveryCodesRequestParams,
  ): Promise<HttpResponse<SignInWithRecoveryCodesResponseBody>>
}
