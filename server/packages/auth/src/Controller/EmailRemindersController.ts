import { HttpResponse, HttpStatusCode } from '@standardnotes/responses'
import { MapperInterface } from '@standardnotes/domain-core'

import { EmailReminder } from '../Domain/EmailReminder/EmailReminder'
import { CreateEmailReminder } from '../Domain/UseCase/CreateEmailReminder/CreateEmailReminder'
import { ListEmailReminders } from '../Domain/UseCase/ListEmailReminders/ListEmailReminders'
import { DeleteEmailReminder } from '../Domain/UseCase/DeleteEmailReminder/DeleteEmailReminder'
import { EmailReminderHttpProjection } from '../Infra/Http/Projection/EmailReminderHttpProjection'

export class EmailRemindersController {
  constructor(
    private createEmailReminder: CreateEmailReminder,
    private listEmailReminders: ListEmailReminders,
    private deleteEmailReminder: DeleteEmailReminder,
    private emailReminderHttpMapper: MapperInterface<EmailReminder, EmailReminderHttpProjection>,
  ) {}

  async list(params: { userUuid: string }): Promise<HttpResponse> {
    const result = await this.listEmailReminders.execute({
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
        emailReminders: result.getValue().map((reminder) => this.emailReminderHttpMapper.toProjection(reminder)),
      },
    }
  }

  async create(params: {
    userUuid: string
    dueAt: number | string
    message: string
  }): Promise<HttpResponse> {
    const result = await this.createEmailReminder.execute({
      userUuid: params.userUuid,
      dueAt: params.dueAt,
      message: params.message,
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
        emailReminder: result.getValue(),
      },
    }
  }

  async delete(params: { userUuid: string; reminderId: string }): Promise<HttpResponse> {
    const result = await this.deleteEmailReminder.execute({
      userUuid: params.userUuid,
      reminderId: params.reminderId,
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
