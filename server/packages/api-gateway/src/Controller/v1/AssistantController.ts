import { Request, Response } from 'express'
import { inject, optional } from 'inversify'
import { BaseHttpController, controller, httpGet, httpPost } from 'inversify-express-utils'
import * as IORedis from 'ioredis'
import { SettingName } from '@standardnotes/domain-core'

import { TYPES } from '../../Bootstrap/Types'
import {
  AssistantProviderConfig,
  configuredProviders,
  listProviderModels,
  resolveProvider,
} from '../../Service/Assistant/providers/factory'
import { ChatMessage, ProviderEvent, ToolDescriptor } from '../../Service/Assistant/providers/types'

interface StreamRequestBody {
  provider?: string
  model?: string
  system?: string
  messages?: ChatMessage[]
  tools?: ToolDescriptor[]
}

// Redis usage counters expire shortly after the calendar day they track so
// stale keys self-clean while a slightly-late midnight request still finds the
// correct day's counter. 26h covers any timezone skew between the gateway clock
// and the YYYY-MM-DD bucket boundary.
const USAGE_TTL_SECONDS = 26 * 60 * 60

interface ResolvedUserLimits {
  // Whether AI is enabled for this user. `undefined` means "not resolvable from
  // the cross-service token / locals" and the caller should fall back to allow.
  aiEnabled?: boolean
  // Per-user daily request limit (>0) if resolvable, else undefined.
  perUserLimit?: number
}

/**
 * Stateless LLM streaming proxy. Standard Notes notes are end-to-end encrypted,
 * so the agent loop and ALL tools run in the browser. This controller only holds
 * the provider API key and forwards ONE model turn at a time as Server-Sent
 * Events. Tool execution never happens here.
 */
// `/config` is intentionally public: it returns only which LLM providers the
// server proxy has configured (non-sensitive), and the client may query it
// before/without a session. `/stream` and `/usage` stay authenticated because
// they spend / report on the server-held provider API key budget.
@controller('/v1/assistant')
export class AssistantController extends BaseHttpController {
  constructor(
    @inject(TYPES.ApiGateway_ASSISTANT_PROVIDER_CONFIG) private providerConfig: AssistantProviderConfig,
    @inject(TYPES.ApiGateway_ASSISTANT_DEFAULT_PROVIDER) private defaultProvider: string,
    @inject(TYPES.ApiGateway_ASSISTANT_DEFAULT_MODEL) private defaultModel: string,
    @inject(TYPES.ApiGateway_ASSISTANT_DAILY_REQUEST_LIMIT) private globalDailyLimit: number,
    @inject(TYPES.ApiGateway_ASSISTANT_TRANSCRIPTION_MODELS) private transcriptionModels: string[],
    @inject(TYPES.ApiGateway_Redis) @optional() private redis?: IORedis.Redis,
  ) {
    super()
  }

  // `/transcription/models` is intentionally public, like `/config`: it returns only
  // the operator-configured speech-to-text model ids (from the TRANSCRIPTION_MODELS
  // env, empty by default), which are non-sensitive. The web client queries it to
  // populate the audio-recorder model picker; an empty list (or a missing endpoint on
  // older servers) makes the client fall back to a free-text model field.
  @httpGet('/transcription/models')
  async transcriptionModelList(_request: Request, response: Response): Promise<void> {
    response.json({ models: this.transcriptionModels })
  }

  @httpGet('/config')
  async config(_request: Request, response: Response): Promise<void> {
    const providers = configuredProviders(this.providerConfig)

    response.json({
      providers,
      defaultProvider: providers.includes(this.defaultProvider) ? this.defaultProvider : (providers[0] ?? ''),
      defaultModel: this.defaultModel,
    })
  }

  // Authenticated: it queries the provider's model list using the server-held
  // API key, so it must not be reachable without a session.
  @httpGet('/models', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async models(request: Request, response: Response): Promise<void> {
    const requested = typeof request.query.provider === 'string' ? request.query.provider : ''
    const providers = configuredProviders(this.providerConfig)
    const provider = requested || (providers.includes(this.defaultProvider) ? this.defaultProvider : providers[0] || '')

    if (!provider || !providers.includes(provider)) {
      response.status(400).json({
        error: { message: 'Requested provider is not configured on this server.' },
      })
      return
    }

    const models = await listProviderModels(provider, this.providerConfig)
    response.json({ provider, models })
  }

  @httpGet('/usage', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async usage(_request: Request, response: Response): Promise<void> {
    const userUuid = (response.locals.user as { uuid: string }).uuid
    const limits = this.resolveUserLimits(response)
    const limit = this.effectiveLimit(limits)
    const dayKey = this.currentDayKey()

    let used = 0
    if (this.redis) {
      const raw = await this.redis.get(this.usageKey(userUuid, dayKey))
      used = raw ? parseInt(raw, 10) : 0
    }

    response.json({
      used,
      limit,
      resetsAt: this.nextResetIso(),
    })
  }

  @httpPost('/stream', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async streamCompletion(request: Request, response: Response): Promise<void> {
    const body = (request.body ?? {}) as StreamRequestBody

    const userUuid = (response.locals.user as { uuid: string }).uuid
    const limits = this.resolveUserLimits(response)

    // 1) Hard disable: if AI is explicitly disabled for this user, refuse.
    if (limits.aiEnabled === false) {
      response.status(403).json({
        error: {
          tag: 'ai-disabled',
          message: 'AI assistant access is disabled for your account.',
        },
      })
      return
    }

    const limit = this.effectiveLimit(limits)
    const dayKey = this.currentDayKey()

    // 2) Meter per user per day. We INCR up front (so concurrent requests can't
    // race past the ceiling) and, if the resulting count exceeds the limit, roll
    // the counter back and reject with 429. The counter therefore only ever ends
    // up reflecting requests that were allowed to start a proxy stream.
    if (this.redis && limit > 0) {
      const key = this.usageKey(userUuid, dayKey)
      const count = await this.redis.incr(key)
      if (count === 1) {
        await this.redis.expire(key, USAGE_TTL_SECONDS)
      }

      if (count > limit) {
        await this.redis.decr(key)
        response.status(429).json({
          error: {
            tag: 'ai-rate-limited',
            message: `Daily AI request limit reached (${limit}). Try again after the limit resets.`,
            limit,
            resetsAt: this.nextResetIso(),
          },
        })
        return
      }
    }

    const providerId = body.provider || this.defaultProvider
    const model = body.model || this.defaultModel

    let provider
    try {
      provider = resolveProvider(providerId, model, this.providerConfig)
    } catch (error) {
      // The proxy never started, so refund the metered request.
      await this.refundUsage(userUuid, dayKey, limit)

      response.setHeader('Content-Type', 'text/event-stream')
      response.setHeader('Cache-Control', 'no-cache, no-transform')
      response.setHeader('Connection', 'keep-alive')
      response.setHeader('X-Accel-Buffering', 'no')
      response.flushHeaders?.()
      const writeErr = (event: ProviderEvent): void => {
        response.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      writeErr({ kind: 'error', message: (error as Error).message })
      writeErr({ kind: 'finish', stopReason: 'error' })
      response.end()
      return
    }

    response.setHeader('Content-Type', 'text/event-stream')
    response.setHeader('Cache-Control', 'no-cache, no-transform')
    response.setHeader('Connection', 'keep-alive')
    response.setHeader('X-Accel-Buffering', 'no')
    response.flushHeaders?.()

    const writeEvent = (event: ProviderEvent): void => {
      response.write(`data: ${JSON.stringify(event)}\n\n`)
    }

    let clientClosed = false
    request.on('close', () => {
      clientClosed = true
    })

    try {
      const stream = provider.send({
        system: body.system ?? '',
        messages: body.messages ?? [],
        tools: body.tools ?? [],
      })

      for await (const event of stream) {
        if (clientClosed) {
          break
        }
        writeEvent(event)
      }
    } catch (error) {
      writeEvent({ kind: 'error', message: (error as Error).message })
      writeEvent({ kind: 'finish', stopReason: 'error' })
    } finally {
      response.end()
    }
  }

  private usageKey(userUuid: string, dayKey: string): string {
    return `ai-usage:${userUuid}:${dayKey}`
  }

  private currentDayKey(): string {
    // YYYY-MM-DD in UTC.
    return new Date().toISOString().slice(0, 10)
  }

  private nextResetIso(): string {
    const now = new Date()
    const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0))
    return reset.toISOString()
  }

  private effectiveLimit(limits: ResolvedUserLimits): number {
    if (limits.perUserLimit !== undefined && limits.perUserLimit > 0) {
      return limits.perUserLimit
    }
    return this.globalDailyLimit > 0 ? this.globalDailyLimit : 0
  }

  private async refundUsage(userUuid: string, dayKey: string, limit: number): Promise<void> {
    if (this.redis && limit > 0) {
      await this.redis.decr(this.usageKey(userUuid, dayKey))
    }
  }

  /**
   * Resolves per-user AI settings (AI_ENABLED / AI_REQUEST_LIMIT).
   *
   * The cross-service token validated by RequiredCrossServiceTokenMiddleware does
   * NOT currently carry user setting values, so these are read opportunistically
   * from response.locals only if some upstream populates them there. When absent,
   * we fall back to the GLOBAL env ceiling (ASSISTANT_DAILY_REQUEST_LIMIT) and
   * allow access.
   *
   * TODO: For true per-user enforcement, fetch AI_ENABLED / AI_REQUEST_LIMIT from
   * the auth service (e.g. via the existing ServiceProxy settings endpoint keyed
   * on response.locals.user.uuid) and cache them alongside the cross-service
   * token, then resolve them here instead of relying on response.locals.
   */
  private resolveUserLimits(response: Response): ResolvedUserLimits {
    const settings = (response.locals as { settings?: Record<string, unknown> }).settings
    if (!settings) {
      return {}
    }

    const result: ResolvedUserLimits = {}

    const enabledRaw = settings[SettingName.NAMES.AiEnabled]
    if (enabledRaw !== undefined && enabledRaw !== null) {
      result.aiEnabled = `${enabledRaw}`.toLowerCase() !== 'false' && `${enabledRaw}` !== '0'
    }

    const limitRaw = settings[SettingName.NAMES.AiRequestLimit]
    if (limitRaw !== undefined && limitRaw !== null) {
      const parsed = parseInt(`${limitRaw}`, 10)
      if (!Number.isNaN(parsed)) {
        result.perUserLimit = parsed
      }
    }

    return result
  }
}
