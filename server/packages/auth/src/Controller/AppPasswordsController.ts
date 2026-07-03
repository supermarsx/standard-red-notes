import { HttpResponse, HttpStatusCode } from '@standardnotes/responses'
import { MapperInterface } from '@standardnotes/domain-core'

import { AppPassword } from '../Domain/AppPassword/AppPassword'
import { CreateAppPassword } from '../Domain/UseCase/CreateAppPassword/CreateAppPassword'
import { ListAppPasswords } from '../Domain/UseCase/ListAppPasswords/ListAppPasswords'
import { DeleteAppPassword } from '../Domain/UseCase/DeleteAppPassword/DeleteAppPassword'
import { RevokeAppPassword } from '../Domain/UseCase/RevokeAppPassword/RevokeAppPassword'
import { AppPasswordHttpProjection } from '../Infra/Http/Projection/AppPasswordHttpProjection'

export class AppPasswordsController {
  constructor(
    private createAppPassword: CreateAppPassword,
    private listAppPasswords: ListAppPasswords,
    private deleteAppPassword: DeleteAppPassword,
    private revokeAppPassword: RevokeAppPassword,
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

  async create(params: { userUuid: string; label: string; expiresInDays?: number | null }): Promise<HttpResponse> {
    let expiresAt: Date | null = null
    if (params.expiresInDays !== undefined && params.expiresInDays !== null) {
      const days = Number(params.expiresInDays)
      if (!Number.isFinite(days) || days <= 0) {
        return {
          status: HttpStatusCode.BadRequest,
          data: {
            error: {
              message: 'Could not create app password: the expiry duration must be a positive number of days.',
            },
          },
        }
      }
      expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
    }

    const result = await this.createAppPassword.execute({
      userUuid: params.userUuid,
      label: params.label,
      expiresAt,
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
          expiresAt: created.expiresAt ? created.expiresAt.toISOString() : null,
        },
        // Plaintext secret returned exactly once. The client must surface and let
        // the user copy it now; it is never retrievable again.
        password: created.password,
      },
    }
  }

  /**
   * Default destructive action: SOFT-revoke (keeps the row + audit trail). Use
   * `deletePermanently` to hard-delete.
   */
  async revoke(params: { userUuid: string; appPasswordId: string }): Promise<HttpResponse> {
    const result = await this.revokeAppPassword.execute({
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

  /**
   * Permanent hard-delete. Retained for callers that genuinely need to purge a
   * record rather than keep the revocation trail.
   */
  async deletePermanently(params: { userUuid: string; appPasswordId: string }): Promise<HttpResponse> {
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
