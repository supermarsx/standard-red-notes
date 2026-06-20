import { HttpResponse, HttpStatusCode } from '@standardnotes/responses'
import { MapperInterface } from '@standardnotes/domain-core'

import { TrustedDevice } from '../Domain/TrustedDevice/TrustedDevice'
import { CreateTrustedDevice } from '../Domain/UseCase/CreateTrustedDevice/CreateTrustedDevice'
import { ListTrustedDevices } from '../Domain/UseCase/ListTrustedDevices/ListTrustedDevices'
import { DeleteTrustedDevice } from '../Domain/UseCase/DeleteTrustedDevice/DeleteTrustedDevice'
import { TrustedDeviceHttpProjection } from '../Infra/Http/Projection/TrustedDeviceHttpProjection'

export class TrustedDevicesController {
  constructor(
    private createTrustedDevice: CreateTrustedDevice,
    private listTrustedDevices: ListTrustedDevices,
    private deleteTrustedDevice: DeleteTrustedDevice,
    private trustedDeviceHttpMapper: MapperInterface<TrustedDevice, TrustedDeviceHttpProjection>,
  ) {}

  async list(params: { userUuid: string }): Promise<HttpResponse> {
    const result = await this.listTrustedDevices.execute({
      userUuid: params.userUuid,
    })

    if (result.isFailed()) {
      return {
        status: HttpStatusCode.Unauthorized,
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
        trustedDevices: result.getValue().map((trustedDevice) => this.trustedDeviceHttpMapper.toProjection(trustedDevice)),
      },
    }
  }

  async create(params: { userUuid: string; label: string }): Promise<HttpResponse> {
    const result = await this.createTrustedDevice.execute({
      userUuid: params.userUuid,
      label: params.label,
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

    const created = result.getValue()

    return {
      status: HttpStatusCode.Success,
      data: {
        // `token` is the plaintext device token, returned EXACTLY ONCE. The
        // client must persist it and present it as `trusted_device_token` on the
        // login-params request to bypass the second factor on future sign-ins.
        trustedDevice: {
          uuid: created.uuid,
          label: created.label,
          token: created.token,
          createdAt: created.createdAt,
          expiresAt: created.expiresAt,
        },
      },
    }
  }

  async delete(params: { userUuid: string; deviceId: string }): Promise<HttpResponse> {
    const result = await this.deleteTrustedDevice.execute({
      userUuid: params.userUuid,
      deviceId: params.deviceId,
    })

    if (result.isFailed()) {
      return {
        status: HttpStatusCode.Unauthorized,
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
        message: result.getValue(),
      },
    }
  }
}
