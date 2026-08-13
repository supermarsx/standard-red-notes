import { HttpResponse, HttpStatusCode } from '@standardnotes/responses'
import { MapperInterface } from '@standardnotes/domain-core'

import { EmailReminder } from '../Domain/EmailReminder/EmailReminder'
import { CreateEmailReminder } from '../Domain/UseCase/CreateEmailReminder/CreateEmailReminder'
import { ListEmailReminders } from '../Domain/UseCase/ListEmailReminders/ListEmailReminders'
import { DeleteEmailReminder } from '../Domain/UseCase/DeleteEmailReminder/DeleteEmailReminder'
import { EmailReminderHttpProjection } from '../Infra/Http/Projection/EmailReminderHttpProjection'

// The server currently consumes the published responses package; keep these
// typed fallbacks until its lockfile picks up the shared enum members.
const HTTP_CONFLICT = 409 as HttpStatusCode
const HTTP_SERVICE_UNAVAILABLE = 503 as HttpStatusCode

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

  async create(params: { userUuid: string; dueAt: number | string; message: string }): Promise<HttpResponse> {
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
      const message = result.getError()
      return {
        status: this.cancellationFailureStatus(message),
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
        message: result.getValue(),
      },
    }
  }

  private cancellationFailureStatus(message: string): HttpStatusCode {
    if (message.includes('already in flight')) {
      return HTTP_CONFLICT
    }
    if (message.includes('durable email delivery cancellation is unavailable')) {
      return HTTP_SERVICE_UNAVAILABLE
    }

    return HttpStatusCode.Unauthorized
  }
}
