import { Request, Response } from 'express'
import { randomUUID } from 'crypto'
import { inject } from 'inversify'
import { BaseHttpController, controller, httpDelete, httpGet, httpPost, httpPut } from 'inversify-express-utils'
import { SettingName } from '@standardnotes/domain-core'

import { TYPES } from '../../Bootstrap/Types'
import { CaldavInputError } from '../../Service/Caldav/CaldavInputError'
import { normalizeCaldavBasePath } from '../../Service/Caldav/CaldavBasePath'
import { CaldavService } from '../../Service/Caldav/CaldavService'
import { normalizePublishedTodoRecurrence } from '../../Service/Caldav/CalendarProjection'
import { PublishedTodo } from '../../Service/Caldav/ICalendarSerializer'

function userUuidFrom(response: Response): string {
  return (response.locals.user as { uuid: string }).uuid
}

function userAllowed(response: Response): boolean {
  const settings = (response.locals as { settings?: Record<string, unknown> }).settings
  if (!settings) {
    return false
  }
  const raw = settings[SettingName.NAMES.CaldavEnabled]
  return raw !== undefined && raw !== null && `${raw}`.toLowerCase() === 'true'
}

function requirePublishAccess(service: CaldavService, response: Response): boolean {
  if (!service.isEnabled()) {
    response.status(403).json({
      error: {
        tag: 'caldav-disabled',
        message: 'CalDAV is disabled on this server.',
      },
    })
    return false
  }
  if (!userAllowed(response)) {
    response.status(403).json({
      error: {
        tag: 'caldav-not-allowed',
        message: 'CalDAV access is not enabled for your account.',
      },
    })
    return false
  }
  return true
}

/**
 * Standard Red Notes: management API for scoped, revocable CalDAV access tokens.
 *
 * These tokens are the Basic-auth credential stock CalDAV clients use to read
 * the user's PUBLISHED reminders feed (see CaldavService / createCaldavRouter).
 * They are NOT the account password and are read-only calendar scope.
 *
 * GATING (off by default, two gates):
 *   1. env master switch CALDAV_ENABLED (service.isEnabled()),
 *   2. per-user opt-in: the CALDAV_ENABLED setting must be 'true' for THIS user
 *      before a token can be issued. The setting is read from the request's
 *      resolved settings (same opportunistic channel the AI/OCR proxies use);
 *      when absent it fails CLOSED.
 *
 * All routes require a valid session (RequiredCrossServiceTokenMiddleware), so
 * `response.locals.user.uuid` identifies the owner.
 *
 * `/config` reports whether the feature is available FOR THIS USER so the client
 * can decide whether to show the CalDAV settings UI.
 */
@controller('/v1/caldav/tokens')
export class CaldavTokensController extends BaseHttpController {
  private readonly caldavBasePath: string

  constructor(
    @inject(TYPES.ApiGateway_CaldavService) private caldavService: CaldavService,
    @inject(TYPES.ApiGateway_CALDAV_BASE_PATH) caldavBasePath: string,
  ) {
    super()
    this.caldavBasePath = normalizeCaldavBasePath(caldavBasePath)
  }

  @httpGet('/config', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async config(_request: Request, response: Response): Promise<void> {
    const enabled = this.caldavService.isEnabled()
    const allowed = userAllowed(response)
    const basePath = this.caldavBasePath
    response.json({
      caldavEnabled: enabled,
      allowed,
      available: enabled && allowed,
      basePath,
      collectionPathTemplate: `${basePath}/calendars/{userUuid}/todos/`,
    })
  }

  @httpGet('/', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async list(_request: Request, response: Response): Promise<void> {
    // Cleanup remains available when either feature gate is off.
    const userUuid = userUuidFrom(response)
    const tokens = await this.caldavService.listTokens(userUuid)
    response.json({ tokens })
  }

  @httpPost('/', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async create(request: Request, response: Response): Promise<void> {
    if (!requirePublishAccess(this.caldavService, response)) {
      return
    }

    const userUuid = userUuidFrom(response)
    const label =
      typeof (request.body as { label?: unknown })?.label === 'string' ? (request.body as { label: string }).label : ''

    try {
      const created = await this.caldavService.createToken(userUuid, label)
      // The plaintext token is returned exactly once here.
      response.status(201).json({ token: created })
    } catch (error) {
      if (!(error instanceof CaldavInputError)) {
        throw error
      }
      response.status(400).json({ error: { message: (error as Error).message } })
    }
  }

  @httpDelete('/', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async revokeAll(_request: Request, response: Response): Promise<void> {
    const revoked = await this.caldavService.revokeAllTokens(userUuidFrom(response))
    response.status(200).json({ revoked })
  }

  @httpDelete('/:tokenUuid', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async revoke(request: Request, response: Response): Promise<void> {
    // Revocation remains available when either feature gate is off.
    const userUuid = userUuidFrom(response)
    const tokenUuid = request.params.tokenUuid as string
    const removed = await this.caldavService.revokeToken(userUuid, tokenUuid)
    if (!removed) {
      response.status(404).json({ error: { message: 'CalDAV token not found.' } })
      return
    }
    response.status(200).json({ revoked: true })
  }
}

/**
 * Authenticated management API for the explicit plaintext calendar projection.
 * This intentionally does not inspect or decrypt notes. Only fields submitted
 * to this controller enter the CalDAV store.
 */
@controller('/v1/caldav/todos')
export class CaldavTodosController extends BaseHttpController {
  constructor(@inject(TYPES.ApiGateway_CaldavService) private caldavService: CaldavService) {
    super()
  }

  @httpGet('/', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async list(_request: Request, response: Response): Promise<void> {
    // Plaintext cleanup remains available even if CalDAV is later disabled.
    const todos = await this.caldavService.listTodos(userUuidFrom(response))
    response.json({ todos })
  }

  @httpPost('/', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async publish(request: Request, response: Response): Promise<void> {
    if (!requirePublishAccess(this.caldavService, response)) {
      return
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    // Every field this controller forwards must be named HERE. A field added to
    // the store's schema but not to this list is accepted by the client, stored
    // as nothing, and then behaves like a record that never had it — which is
    // how `recurrence` and `categories` first shipped as silent no-ops.
    const todo: PublishedTodo = {
      uid: typeof body.uid === 'string' && body.uid.length > 0 ? body.uid : randomUUID(),
      summary: typeof body.summary === 'string' ? body.summary : '',
      ...(typeof body.description === 'string' ? { description: body.description } : {}),
      ...(typeof body.due === 'string' ? { due: body.due } : {}),
      ...(typeof body.start === 'string' ? { start: body.start } : {}),
      ...(typeof body.completed === 'boolean' ? { completed: body.completed } : {}),
      ...(typeof body.completedAt === 'string' ? { completedAt: body.completedAt } : {}),
      ...(typeof body.priority === 'number' ? { priority: body.priority } : {}),
    }
    if (todo.summary.trim().length === 0) {
      response.status(400).json({ error: { message: 'A summary is required to publish a calendar item.' } })
      return
    }
    if (body.categories !== undefined) {
      // Rejected rather than filtered: a client that sent a malformed list has
      // a bug, and quietly publishing a record with no categories would hide it.
      if (!Array.isArray(body.categories) || body.categories.some((entry) => typeof entry !== 'string')) {
        response.status(400).json({ error: { message: 'Calendar categories must be a list of strings.' } })
        return
      }
      todo.categories = body.categories as string[]
    }
    if (body.recurrence !== undefined) {
      const recurrence = normalizePublishedTodoRecurrence(body.recurrence)
      if (!recurrence) {
        response.status(400).json({ error: { message: 'Refusing to publish an unrecognized repeat rule.' } })
        return
      }
      todo.recurrence = recurrence
    }
    try {
      const stored = await this.caldavService.publishTodo(userUuidFrom(response), todo)
      response.status(200).json({ todo: stored })
    } catch (error) {
      if (!(error instanceof CaldavInputError)) {
        throw error
      }
      response.status(400).json({ error: { message: error.message } })
    }
  }

  @httpDelete('/:uid', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async unpublish(request: Request, response: Response): Promise<void> {
    const removed = await this.caldavService.unpublishTodo(userUuidFrom(response), request.params.uid as string)
    if (!removed) {
      response.status(404).json({ error: { message: 'Published calendar item not found.' } })
      return
    }
    response.status(200).json({ unpublished: true })
  }
}

/**
 * Authenticated settings for the due-date-to-event projection: whether a
 * published task's deadline also appears as a calendar EVENT, and in what shape.
 *
 * It is a settings endpoint, not a data endpoint — it stores no task content.
 * GET is deliberately available even when the feature gates are off, because the
 * client needs the stored values to render the pane and tell the user WHY the
 * projection is inactive; PUT requires both gates, like every other write here.
 *
 * The response always echoes the EFFECTIVE, normalized settings rather than the
 * submitted body, so a clamped duration or an unknown time zone is visible in
 * the UI immediately instead of looking saved and behaving differently.
 */
@controller('/v1/caldav/projection')
export class CaldavProjectionController extends BaseHttpController {
  constructor(@inject(TYPES.ApiGateway_CaldavService) private caldavService: CaldavService) {
    super()
  }

  @httpGet('/', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async read(_request: Request, response: Response): Promise<void> {
    const projection = await this.caldavService.getProjection(userUuidFrom(response))
    response.json({
      projection,
      caldavEnabled: this.caldavService.isEnabled(),
      allowed: userAllowed(response),
    })
  }

  @httpPut('/', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async write(request: Request, response: Response): Promise<void> {
    if (!requirePublishAccess(this.caldavService, response)) {
      return
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    // Accept either the bare settings object or a `{ projection: … }` envelope so
    // the client can round-trip exactly what GET returned.
    const submitted = body.projection !== undefined ? body.projection : body
    const projection = await this.caldavService.setProjection(userUuidFrom(response), submitted)
    response.status(200).json({ projection })
  }

  @httpDelete('/', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async reset(_request: Request, response: Response): Promise<void> {
    // Reverting to the OFF defaults stays available when either gate is off, so
    // a user can always stop the projection.
    const removed = await this.caldavService.resetProjection(userUuidFrom(response))
    const projection = await this.caldavService.getProjection(userUuidFrom(response))
    response.status(200).json({ reset: removed, projection })
  }
}
