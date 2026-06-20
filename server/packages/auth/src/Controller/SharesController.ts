import { HttpResponse, HttpStatusCode } from '@standardnotes/responses'
import { MapperInterface } from '@standardnotes/domain-core'

import { Share } from '../Domain/Share/Share'
import { CreateShare } from '../Domain/UseCase/CreateShare/CreateShare'
import { ListShares } from '../Domain/UseCase/ListShares/ListShares'
import { RevokeShare } from '../Domain/UseCase/RevokeShare/RevokeShare'
import { GetShare } from '../Domain/UseCase/GetShare/GetShare'
import { ShareHttpProjection } from '../Infra/Http/Projection/ShareHttpProjection'

export class SharesController {
  constructor(
    private createShare: CreateShare,
    private listShares: ListShares,
    private revokeShare: RevokeShare,
    private getShare: GetShare,
    private shareHttpMapper: MapperInterface<Share, ShareHttpProjection>,
  ) {}

  async list(params: { userUuid: string }): Promise<HttpResponse> {
    const result = await this.listShares.execute({
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
        shares: result.getValue().map((share) => this.shareHttpMapper.toProjection(share)),
      },
    }
  }

  async create(params: {
    userUuid: string
    type: string
    encryptedPayload: string
    nickname?: string | null
  }): Promise<HttpResponse> {
    const result = await this.createShare.execute({
      userUuid: params.userUuid,
      type: params.type,
      encryptedPayload: params.encryptedPayload,
      nickname: params.nickname,
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
        // The shareId the client embeds in the share link. The decryption key
        // lives only in the link fragment and never reaches the server.
        shareId: created.shareId,
        share: {
          uuid: created.shareId,
          type: created.type,
          nickname: created.nickname,
          createdAt: created.createdAt.toISOString(),
          revoked: false,
        },
      },
    }
  }

  async revoke(params: { userUuid: string; shareId: string }): Promise<HttpResponse> {
    const result = await this.revokeShare.execute({
      userUuid: params.userUuid,
      shareId: params.shareId,
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
   * PUBLIC, unauthenticated read. Anyone with the share link id can fetch the
   * opaque ciphertext. Returns 404 (Not Found) when the share does not exist or
   * has been revoked. Never leaks the owning user's uuid.
   */
  async get(params: { shareId: string }): Promise<HttpResponse> {
    const result = await this.getShare.execute({
      shareId: params.shareId,
    })

    if (result.isFailed()) {
      // The shared @standardnotes/responses HttpStatusCode enum has no NotFound
      // member, so emit the literal 404 for the public read path (missing or
      // revoked share). Never leak the owning user's uuid in the body.
      return {
        status: 404 as HttpStatusCode,
        data: {
          error: {
            message: result.getError(),
          },
        },
      }
    }

    const share = result.getValue()

    return {
      status: HttpStatusCode.Success,
      data: {
        type: share.type,
        encryptedPayload: share.encryptedPayload,
      },
    }
  }
}
