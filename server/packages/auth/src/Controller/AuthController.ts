import { HttpResponse, HttpStatusCode } from '@standardnotes/responses'

import { GetUserKeyParamsRecovery } from '../Domain/UseCase/GetUserKeyParamsRecovery/GetUserKeyParamsRecovery'
import { RecoveryKeyParamsRequestParams } from '../Infra/Http/Request/RecoveryKeyParamsRequestParams'
import { RecoveryKeyParamsResponseBody } from '../Infra/Http/Response/RecoveryKeyParamsResponseBody'
import { GenerateRecoveryCodesResponseBody } from '../Infra/Http/Response/GenerateRecoveryCodesResponseBody'
import { GenerateRecoveryCodes } from '../Domain/UseCase/GenerateRecoveryCodes/GenerateRecoveryCodes'
import { GenerateRecoveryCodesRequestParams } from '../Infra/Http/Request/GenerateRecoveryCodesRequestParams'
import { Logger } from 'winston'
import { SECURITY_STEP_UP_UPDATE_REQUIRED_MESSAGE } from '../Domain/Auth/SecurityStepUp'

/**
 * DEPRECATED: This controller is deprecated and will be removed in the future.
 */
export class AuthController {
  constructor(
    private getUserKeyParamsRecovery: GetUserKeyParamsRecovery,
    private doGenerateRecoveryCodes: GenerateRecoveryCodes,
    private logger: Logger,
  ) {}

  async generateRecoveryCodes(
    params: GenerateRecoveryCodesRequestParams,
  ): Promise<HttpResponse<GenerateRecoveryCodesResponseBody>> {
    const result = await this.doGenerateRecoveryCodes.execute({
      userUuid: params.userUuid,
      serverPassword: params.serverPassword,
      authTokenVersion: params.authTokenVersion,
      shouldVerifyUserServerPassword: true,
    })

    if (result.isFailed()) {
      const message =
        result.getError() === SECURITY_STEP_UP_UPDATE_REQUIRED_MESSAGE
          ? SECURITY_STEP_UP_UPDATE_REQUIRED_MESSAGE
          : 'Could not generate recovery codes.'

      return {
        status: HttpStatusCode.BadRequest,
        data: {
          error: {
            message,
          },
        },
      }
    }

    return {
      status: HttpStatusCode.Success,
      data: {
        recoveryCodes: result.getValue(),
      },
    }
  }

  async recoveryKeyParams(
    params: RecoveryKeyParamsRequestParams,
  ): Promise<HttpResponse<RecoveryKeyParamsResponseBody>> {
    const result = await this.getUserKeyParamsRecovery.execute({
      apiVersion: params.apiVersion,
      username: params.username,
      codeChallenge: params.codeChallenge,
      recoveryCodes: params.recoveryCodes,
    })

    if (result.isFailed()) {
      this.logger.debug('Failed to get recovery key parameters.')

      return {
        status: HttpStatusCode.Unauthorized,
        data: {
          error: {
            message: 'Invalid login credentials.',
          },
        },
      }
    }

    return {
      status: HttpStatusCode.Success,
      data: {
        keyParams: result.getValue(),
      },
    }
  }
}
