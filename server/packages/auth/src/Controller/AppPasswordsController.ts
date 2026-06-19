import { HttpResponse, HttpStatusCode } from '@standardnotes/responses'
import { MapperInterface } from '@standardnotes/domain-core'

import { AppPassword } from '../Domain/AppPassword/AppPassword'
import { CreateAppPassword } from '../Domain/UseCase/CreateAppPassword/CreateAppPassword'
import { ListAppPasswords } from '../Domain/UseCase/ListAppPasswords/ListAppPasswords'
import { DeleteAppPassword } from '../Domain/UseCase/DeleteAppPassword/DeleteAppPassword'
import { AppPasswordHttpProjection } from '../Infra/Http/Projection/AppPasswordHttpProjection'

export class AppPasswordsController {
  constructor(
    private createAppPassword: CreateAppPassword,
    private listAppPasswords: ListAppPasswords,
    private deleteAppPassword: DeleteAppPassword,
    private appPasswordHttpMapper: MapperInterface<AppPassword, AppPasswordHttpProjection>,
  ) {}

  async list(params: { userUuid: string }): Promise<HttpResponse> {
    const result = await this.listAppPasswords.execute({
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
        appPasswords: result.getValue().map((appPassword) => this.appPasswordHttpMapper.toProjection(appPassword)),
      },
    }
  }

  async create(params: { userUuid: string; label: string }): Promise<HttpResponse> {
    const result = await this.createAppPassword.execute({
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
        appPassword: {
          uuid: created.uuid,
          label: created.label,
          createdAt: created.createdAt.toISOString(),
        },
        // Plaintext secret returned exactly once. The client must surface and let
        // the user copy it now; it is never retrievable again.
        password: created.password,
      },
    }
  }

  async delete(params: { userUuid: string; appPasswordId: string }): Promise<HttpResponse> {
    const result = await this.deleteAppPassword.execute({
      userUuid: params.userUuid,
      appPasswordId: params.appPasswordId,
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
