import { HttpResponse, HttpStatusCode } from '@standardnotes/responses'
import { MapperInterface } from '@standardnotes/domain-core'

import { DeadManSwitch } from '../Domain/DeadManSwitch/DeadManSwitch'
import { CreateDeadManSwitch } from '../Domain/UseCase/CreateDeadManSwitch/CreateDeadManSwitch'
import { ListDeadManSwitches } from '../Domain/UseCase/ListDeadManSwitches/ListDeadManSwitches'
import { CheckInDeadManSwitch } from '../Domain/UseCase/CheckInDeadManSwitch/CheckInDeadManSwitch'
import { DeleteDeadManSwitch } from '../Domain/UseCase/DeleteDeadManSwitch/DeleteDeadManSwitch'
import { DeadManSwitchHttpProjection } from '../Infra/Http/Projection/DeadManSwitchHttpProjection'

export class DeadManSwitchesController {
  constructor(
    private createDeadManSwitch: CreateDeadManSwitch,
    private listDeadManSwitches: ListDeadManSwitches,
    private checkInDeadManSwitch: CheckInDeadManSwitch,
    private deleteDeadManSwitch: DeleteDeadManSwitch,
    private deadManSwitchHttpMapper: MapperInterface<DeadManSwitch, DeadManSwitchHttpProjection>,
  ) {}

  async list(params: { userUuid: string }): Promise<HttpResponse> {
    const result = await this.listDeadManSwitches.execute({
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
        deadManSwitches: result.getValue().map((deadManSwitch) => this.deadManSwitchHttpMapper.toProjection(deadManSwitch)),
      },
    }
  }

  async create(params: {
    userUuid: string
    recipientEmail: string
    shareUrl: string
    message?: string | null
    intervalDays: number
  }): Promise<HttpResponse> {
    const result = await this.createDeadManSwitch.execute({
      userUuid: params.userUuid,
      recipientEmail: params.recipientEmail,
      shareUrl: params.shareUrl,
      message: params.message,
      intervalDays: params.intervalDays,
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
        deadManSwitch: {
          uuid: created.uuid,
          recipientEmail: created.recipientEmail,
          message: created.message,
          intervalDays: created.intervalDays,
          deadline: created.deadline,
          triggered: created.triggered,
          lastCheckInAt: created.lastCheckInAt,
          createdAt: created.createdAt,
        },
      },
    }
  }

  async checkIn(params: { userUuid: string; switchId: string }): Promise<HttpResponse> {
    const result = await this.checkInDeadManSwitch.execute({
      userUuid: params.userUuid,
      switchId: params.switchId,
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
        deadline: result.getValue(),
      },
    }
  }

  async delete(params: { userUuid: string; switchId: string }): Promise<HttpResponse> {
    const result = await this.deleteDeadManSwitch.execute({
      userUuid: params.userUuid,
      switchId: params.switchId,
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
