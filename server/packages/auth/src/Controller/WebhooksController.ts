import { HttpResponse, HttpStatusCode } from '@standardnotes/responses'
import { MapperInterface } from '@standardnotes/domain-core'

import { Webhook } from '../Domain/Webhook/Webhook'
import { RegisterWebhook } from '../Domain/UseCase/RegisterWebhook/RegisterWebhook'
import { ListWebhooks } from '../Domain/UseCase/ListWebhooks/ListWebhooks'
import { DeleteWebhook } from '../Domain/UseCase/DeleteWebhook/DeleteWebhook'
import { WebhookHttpProjection } from '../Infra/Http/Projection/WebhookHttpProjection'
import { AuditLogWriterInterface } from '../Domain/AuditLog/AuditLogWriterInterface'
import { AuditAction } from '../Domain/AuditLog/AuditAction'
import { ALL_WEBHOOK_EVENTS } from '../Domain/Webhook/WebhookEvent'

export class WebhooksController {
  constructor(
    private registerWebhook: RegisterWebhook,
    private listWebhooks: ListWebhooks,
    private deleteWebhook: DeleteWebhook,
    private webhookHttpMapper: MapperInterface<Webhook, WebhookHttpProjection>,
    private auditLogWriter: AuditLogWriterInterface,
  ) {}

  async list(params: { userUuid: string; isAdmin: boolean }): Promise<HttpResponse> {
    const result = await this.listWebhooks.execute({
      userUuid: params.userUuid,
      includeGlobal: params.isAdmin,
    })

    if (result.isFailed()) {
      return {
        status: HttpStatusCode.BadRequest,
        data: { error: { message: result.getError() } },
      }
    }

    return {
      status: HttpStatusCode.Success,
      data: {
        // Surface the catalogue of subscribable events so a UI / integration can
        // discover what it may subscribe to.
        availableEvents: ALL_WEBHOOK_EVENTS,
        webhooks: result.getValue().map((webhook) => this.webhookHttpMapper.toProjection(webhook)),
      },
    }
  }

  async create(params: {
    userUuid: string
    isAdmin: boolean
    targetUrl: string
    events: string[]
    global?: boolean
    ip?: string
  }): Promise<HttpResponse> {
    // Only an admin may register a global webhook.
    if (params.global === true && !params.isAdmin) {
      return {
        status: HttpStatusCode.Unauthorized,
        data: { error: { message: 'Only an administrator may register a global webhook.' } },
      }
    }

    const result = await this.registerWebhook.execute({
      userUuid: params.userUuid,
      targetUrl: params.targetUrl,
      events: params.events,
      global: params.global,
    })

    if (result.isFailed()) {
      return {
        status: HttpStatusCode.BadRequest,
        data: { error: { message: result.getError() } },
      }
    }

    const created = result.getValue()

    await this.auditLogWriter.write({
      actorUuid: params.userUuid,
      action: AuditAction.WebhookCreated,
      targetType: 'webhook',
      targetUuid: created.uuid,
      ip: params.ip ?? null,
      metadata: {
        targetUrl: created.targetUrl,
        events: created.events,
        global: created.userUuid === null,
      },
    })

    return {
      status: HttpStatusCode.Success,
      data: {
        webhook: {
          uuid: created.uuid,
          userUuid: created.userUuid,
          targetUrl: created.targetUrl,
          events: created.events,
          enabled: created.enabled,
          createdAt: created.createdAt.toISOString(),
        },
        // The HMAC secret is returned exactly once. The subscriber must store it
        // now to verify the X-SRN-Signature header; it is never retrievable again.
        secret: created.secret,
      },
    }
  }

  async delete(params: {
    userUuid: string
    isAdmin: boolean
    webhookId: string
    ip?: string
  }): Promise<HttpResponse> {
    const result = await this.deleteWebhook.execute({
      userUuid: params.userUuid,
      webhookId: params.webhookId,
      isAdmin: params.isAdmin,
    })

    if (result.isFailed()) {
      return {
        status: HttpStatusCode.BadRequest,
        data: { error: { message: result.getError() } },
      }
    }

    await this.auditLogWriter.write({
      actorUuid: params.userUuid,
      action: AuditAction.WebhookDeleted,
      targetType: 'webhook',
      targetUuid: params.webhookId,
      ip: params.ip ?? null,
    })

    return {
      status: HttpStatusCode.Success,
      data: { message: result.getValue() },
    }
  }
}
