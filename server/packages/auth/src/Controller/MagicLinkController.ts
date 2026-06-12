import { HttpResponse, HttpStatusCode } from '@standardnotes/responses'
import { SettingName } from '@standardnotes/domain-core'

import { GenerateMagicLinkCode } from '../Domain/UseCase/GenerateMagicLinkCode/GenerateMagicLinkCode'
import { SetSettingValue } from '../Domain/UseCase/SetSettingValue/SetSettingValue'
import { GetSetting } from '../Domain/UseCase/GetSetting/GetSetting'

export type RequestMagicLinkRequestParams = {
  email: string
}

export type SetMagicLinkStatusRequestParams = {
  userUuid: string
  enabled: boolean
}

export class MagicLinkController {
  constructor(
    private generateMagicLinkCode: GenerateMagicLinkCode,
    private setSettingValue: SetSettingValue,
    private getSetting: GetSetting,
  ) {}

  async getStatus(
    params: { userUuid: string },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<HttpResponse<any>> {
    const result = await this.getSetting.execute({
      userUuid: params.userUuid,
      settingName: SettingName.NAMES.MagicLinkEnabled,
      allowSensitiveRetrieval: true,
      decrypted: true,
    })

    const enabled = !result.isFailed() && result.getValue().decryptedValue === 'true'

    return {
      status: HttpStatusCode.Success,
      data: {
        enabled,
      },
    }
  }

  async request(
    params: RequestMagicLinkRequestParams,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<HttpResponse<any>> {
    if (!params.email) {
      return {
        status: HttpStatusCode.BadRequest,
        data: {
          error: {
            message: 'An email is required to request a verification code.',
          },
        },
      }
    }

    const result = await this.generateMagicLinkCode.execute({
      userIdentifier: params.email,
    })

    if (result.isFailed()) {
      return {
        status: HttpStatusCode.BadRequest,
        data: {
          error: {
            message: result.getError(),
          },
        },
      }
    }

    const { code, emailed } = result.getValue()

    return {
      status: HttpStatusCode.Success,
      data: {
        emailed,
        // The on-screen code is always returned as a fallback when email is not
        // configured. When the code has been emailed it is omitted from the body.
        code: emailed ? undefined : code,
      },
    }
  }

  async setStatus(
    params: SetMagicLinkStatusRequestParams,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<HttpResponse<any>> {
    const result = await this.setSettingValue.execute({
      userUuid: params.userUuid,
      settingName: SettingName.NAMES.MagicLinkEnabled,
      value: params.enabled ? 'true' : 'false',
    })

    if (result.isFailed()) {
      return {
        status: HttpStatusCode.BadRequest,
        data: {
          error: {
            message: result.getError(),
          },
        },
      }
    }

    return {
      status: HttpStatusCode.Success,
      data: {
        enabled: params.enabled,
      },
    }
  }
}
