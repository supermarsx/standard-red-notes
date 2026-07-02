import { Request, Response } from 'express'
import { inject } from 'inversify'
import { BaseHttpController, controller, httpDelete, httpGet, httpPost, httpPut } from 'inversify-express-utils'
import { SettingName } from '@standardnotes/domain-core'

import { TYPES } from '../../Bootstrap/Types'
import { ReminderDeliveryService } from '../../Service/ReminderDelivery/ReminderDeliveryService'
import { DeliveryChannel, isDeliveryChannel } from '../../Service/ReminderDelivery/Types'

/**
 * Standard Red Notes: management API for server-side reminder DELIVERY.
 *
 * E2E NOTE: notes/reminders are end-to-end encrypted, so the server cannot read
 * them. This controller only ever touches reminders the user has EXPLICITLY
 * PUBLISHED here for delivery (plaintext by design) and the user's own delivery
 * config — never any other encrypted data. Exactly the CalDAV model.
 *
 * GATING (off by default, two gates — mirrors CaldavTokensController):
 *   1. env master switch REMINDER_DELIVERY_ENABLED (service.isEnabled()),
 *   2. per-user opt-in: the REMINDER_DELIVERY_ENABLED setting must be 'true' for
 *      THIS user. Read from the request's resolved settings on
 *      response.locals.settings (same channel the AI/OCR/CalDAV gates use); when
 *      absent it fails CLOSED.
 *
 * All routes require a valid session (RequiredCrossServiceTokenMiddleware), so
 * `response.locals.user.uuid` identifies the owner.
 *
 * PUBLISH FLOW: the web client POSTs a reminder here when the user has delivery
 * enabled (see the web Reminders/reminderDelivery helpers), re-POSTs it under the
 * same stable id when it is edited or a recurring occurrence advances (the store
 * re-arms `sent` when `dueAtUtc` changes), and DELETEs it when the in-app
 * reminder is cleared. It does not expose anyone else's data.
 */
@controller('/v1/reminder-delivery')
export class ReminderDeliveryController extends BaseHttpController {
  constructor(
    @inject(TYPES.ApiGateway_ReminderDeliveryService) private reminderDeliveryService: ReminderDeliveryService,
  ) {
    super()
  }

  @httpGet('/config', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async config(_request: Request, response: Response): Promise<void> {
    const enabled = this.reminderDeliveryService.isEnabled()
    const allowed = this.userAllowed(response)
    response.json({
      reminderDeliveryEnabled: enabled,
      allowed,
      available: enabled && allowed,
    })
  }

  @httpGet('/delivery-config', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async getDeliveryConfig(_request: Request, response: Response): Promise<void> {
    if (!this.gate(response)) {
      return
    }
    const userUuid = this.userUuid(response)
    const config = await this.reminderDeliveryService.getConfig(userUuid)
    response.json({ config })
  }

  @httpPut('/delivery-config', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async setDeliveryConfig(request: Request, response: Response): Promise<void> {
    if (!this.gate(response)) {
      return
    }
    const userUuid = this.userUuid(response)
    const body = (request.body ?? {}) as { channel?: unknown; destination?: unknown; enabled?: unknown }

    if (!isDeliveryChannel(body.channel)) {
      response.status(400).json({ error: { message: 'A valid channel (whatsapp|telegram|email) is required.' } })
      return
    }
    const destination = typeof body.destination === 'string' ? body.destination : ''

    try {
      const config = await this.reminderDeliveryService.setConfig(userUuid, {
        channel: body.channel as DeliveryChannel,
        destination,
        enabled: Boolean(body.enabled),
      })
      response.json({ config })
    } catch (error) {
      response.status(400).json({ error: { message: (error as Error).message } })
    }
  }

  @httpGet('/', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async list(_request: Request, response: Response): Promise<void> {
    if (!this.gate(response)) {
      return
    }
    const userUuid = this.userUuid(response)
    const reminders = await this.reminderDeliveryService.listReminders(userUuid)
    response.json({ reminders })
  }

  /**
   * Publish a reminder for delivery. Called by the web client whenever a reminder
   * is saved while the user's delivery config is enabled. Upserts by id; a changed
   * dueAtUtc re-arms delivery (see PublishedRemindersStore.publish).
   */
  @httpPost('/', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async publish(request: Request, response: Response): Promise<void> {
    if (!this.gate(response)) {
      return
    }
    const userUuid = this.userUuid(response)
    const body = (request.body ?? {}) as {
      id?: unknown
      message?: unknown
      dueAtUtc?: unknown
      channel?: unknown
      destination?: unknown
    }

    const id = typeof body.id === 'string' ? body.id.trim() : ''
    const message = typeof body.message === 'string' ? body.message : ''
    const dueAtUtc = typeof body.dueAtUtc === 'string' ? body.dueAtUtc : ''
    if (id.length === 0 || dueAtUtc.length === 0 || Number.isNaN(Date.parse(dueAtUtc))) {
      response.status(400).json({ error: { message: 'id and a valid ISO-8601 dueAtUtc are required.' } })
      return
    }

    const channel = isDeliveryChannel(body.channel) ? (body.channel as DeliveryChannel) : undefined
    const destination = typeof body.destination === 'string' && body.destination.trim().length > 0
      ? body.destination.trim()
      : undefined

    const stored = await this.reminderDeliveryService.publish(userUuid, {
      id,
      message,
      dueAtUtc,
      ...(channel ? { channel } : {}),
      ...(destination ? { destination } : {}),
    })
    response.status(201).json({ reminder: stored })
  }

  /**
   * Unpublish (remove) a published reminder so it will never be delivered. The
   * web client calls this when the user clears/removes an in-app reminder whose
   * publication would otherwise still fire.
   */
  @httpDelete('/:id', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async unpublish(request: Request, response: Response): Promise<void> {
    if (!this.gate(response)) {
      return
    }
    const userUuid = this.userUuid(response)
    const id = request.params.id as string
    const removed = await this.reminderDeliveryService.unpublish(userUuid, id)
    if (!removed) {
      response.status(404).json({ error: { message: 'Published reminder not found.' } })
      return
    }
    response.status(200).json({ removed: true })
  }

  private gate(response: Response): boolean {
    if (!this.reminderDeliveryService.isEnabled()) {
      response.status(403).json({
        error: { tag: 'reminder-delivery-disabled', message: 'Reminder delivery is disabled on this server.' },
      })
      return false
    }
    if (!this.userAllowed(response)) {
      response.status(403).json({
        error: {
          tag: 'reminder-delivery-not-allowed',
          message: 'Reminder delivery is not enabled for your account.',
        },
      })
      return false
    }
    return true
  }

  private userUuid(response: Response): string {
    return (response.locals.user as { uuid: string }).uuid
  }

  private userAllowed(response: Response): boolean {
    const settings = (response.locals as { settings?: Record<string, unknown> }).settings
    if (!settings) {
      return false
    }
    const raw = settings[SettingName.NAMES.ReminderDeliveryEnabled]
    return raw !== undefined && raw !== null && `${raw}`.toLowerCase() === 'true'
  }
}
