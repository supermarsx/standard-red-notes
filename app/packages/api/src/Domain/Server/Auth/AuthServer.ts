import { HttpServiceInterface } from '../../Http/HttpServiceInterface'
import {
  AccountRecoveryLookupRequestParams,
  RecoveryKeyParamsRequestParams,
  SignInWithRecoveryCodesRequestParams,
} from '../../Request'
import { HttpResponse } from '@standardnotes/responses'
import {
  AccountRecoveryLookupResponseBody,
  GenerateRecoveryCodesResponseBody,
  RecoveryKeyParamsResponseBody,
  SignInWithRecoveryCodesResponseBody,
} from '../../Response'
import { AuthServerInterface } from './AuthServerInterface'
import { Paths } from './Paths'
import { HttpRequestOptions } from '../../Http/HttpRequestOptions'

export class AuthServer implements AuthServerInterface {
  constructor(private httpService: HttpServiceInterface) {}

  async accountRecoveryLookup(
    params: AccountRecoveryLookupRequestParams,
  ): Promise<HttpResponse<AccountRecoveryLookupResponseBody>> {
    return this.httpService.post(Paths.v1.accountRecoveryLookup, params)
  }

  async generateRecoveryCodes(options?: HttpRequestOptions): Promise<HttpResponse<GenerateRecoveryCodesResponseBody>> {
    return this.httpService.post(Paths.v1.generateRecoveryCodes, undefined, options)
  }

  async recoveryKeyParams(
    params: RecoveryKeyParamsRequestParams,
  ): Promise<HttpResponse<RecoveryKeyParamsResponseBody>> {
    return this.httpService.post(Paths.v1.recoveryKeyParams, params)
  }

  async signInWithRecoveryCodes(
    params: SignInWithRecoveryCodesRequestParams,
  ): Promise<HttpResponse<SignInWithRecoveryCodesResponseBody>> {
    return this.httpService.post(Paths.v1.signInWithRecoveryCodes, params)
  }
}
