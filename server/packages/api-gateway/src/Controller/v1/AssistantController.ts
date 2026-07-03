import { Request, Response } from 'express'
import { inject, optional } from 'inversify'
import { BaseHttpController, controller, httpGet, httpPost } from 'inversify-express-utils'
import * as IORedis from 'ioredis'
import { RoleName, SettingName } from '@standardnotes/domain-core'
import { Role } from '@standardnotes/security'

import { TYPES } from '../../Bootstrap/Types'
import {
  AssistantProviderConfig,
  configuredProviders,
  listProviderModels,
  resolveProvider,
} from '../../Service/Assistant/providers/factory'
import { ChatMessage, Provider, ProviderEvent, ToolDescriptor } from '../../Service/Assistant/providers/types'
import { resolveProfileProvider } from '../../Service/Assistant/profiles'
import { SubscriptionCredentialProviderInterface } from '../../Service/Assistant/subscription/SubscriptionCredentialProvider'
import { ServerSettingsResolver } from '../../Service/ServerSettings/ServerSettingsResolver'
import {
  RedisTokenUsageStore,
  SUBSCRIPTION_USAGE_SUBJECT,
} from '../../Service/Assistant/RedisTokenUsageStore'
import {
  buildWindowUsage,
  estimateTokensFromChars,
  estimateTokensFromText,
  FIVE_HOUR_WINDOW_MS,
  isOverTokenLimit,
  TokenWindowId,
  unavailableWindowUsage,
  WEEKLY_WINDOW_MS,
  windowLabel,
} from '../../Service/Assistant/tokenMetering'

interface StreamRequestBody {
  provider?: string
  model?: string
  /** Standard Red Notes: select a named profile by id (overrides `provider`). */
  profileId?: string
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
    // Standard Red Notes: runtime server settings (persisted overlay over env,
    // persisted wins). Consulted PER REQUEST so admin-set keys/URLs/limits take
    // effect immediately; the boot-time env values above are the fallback when
    // the resolver is absent (unit tests) or its store is unreadable.
    @inject(TYPES.ApiGateway_ServerSettingsResolver)
    @optional()
    private serverSettingsResolver?: ServerSettingsResolver,
    // Standard Red Notes: ChatGPT/Codex subscription pairing lifecycle. Optional
    // — only bound when ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY is set; the pairing
    // routes degrade to 503 when it is absent.
    @inject(TYPES.ApiGateway_AssistantSubscriptionCredentialProvider)
    @optional()
    private subscriptionCredentialProvider?: SubscriptionCredentialProviderInterface,
    // Standard Red Notes: env fallback for the per-user rolling-window TOKEN
    // limits. Persisted admin overrides (ServerSettingsResolver) win over these;
    // 0 = unlimited. Optional so unit tests that build the controller directly
    // (no DI) default to unlimited and skip token enforcement.
    @inject(TYPES.ApiGateway_ASSISTANT_5H_TOKEN_LIMIT)
    @optional()
    private fiveHourTokenLimitEnv: number = 0,
    @inject(TYPES.ApiGateway_ASSISTANT_WEEKLY_TOKEN_LIMIT)
    @optional()
    private weeklyTokenLimitEnv: number = 0,
  ) {
    super()
  }

  /**
   * Effective per-user rolling-window token limits: persisted admin values win
   * (via the resolver), else the env fallback, else 0 (unlimited). Never throws.
   */
  private async effectiveTokenLimits(): Promise<{ fiveHour: number; weekly: number }> {
    if (this.serverSettingsResolver) {
      try {
        return await this.serverSettingsResolver.resolveAssistantTokenLimits()
      } catch {
        // Fall through to the env fallback.
      }
    }

    return { fiveHour: this.fiveHourTokenLimitEnv || 0, weekly: this.weeklyTokenLimitEnv || 0 }
  }

  /** The Redis-backed token counter, or undefined when Redis is not configured. */
  private tokenStore(): RedisTokenUsageStore | undefined {
    return this.redis ? new RedisTokenUsageStore(this.redis) : undefined
  }

  /**
   * Standard Red Notes: same admin gate the auth server enforces (InternalTeamUser
   * role from the verified cross-service token), applied to the gateway-local
   * subscription pairing routes since they manage a server-held credential.
   */
  private requestorIsAdmin(response: Response): boolean {
    const roles = ((response.locals as { roles?: Role[] }).roles ?? []) as Role[]

    return roles.some((role) => role.name === RoleName.NAMES.InternalTeamUser)
  }

  /** Effective provider config: persisted admin overrides win over env. */
  private async effectiveProviderConfig(): Promise<AssistantProviderConfig> {
    if (this.serverSettingsResolver) {
      try {
        return await this.serverSettingsResolver.resolveAssistantConfig()
      } catch {
        // Fall through to the env-bound config.
      }
    }

    return this.providerConfig
  }

  /** Effective global daily ceiling: persisted admin override wins over env. */
  private async effectiveGlobalDailyLimit(): Promise<number> {
    if (this.serverSettingsResolver) {
      try {
        return await this.serverSettingsResolver.resolveAssistantDailyRequestLimit()
      } catch {
        // Fall through to the env-bound limit.
      }
    }

    return this.globalDailyLimit
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
    const providers = configuredProviders(await this.effectiveProviderConfig())

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
    // Standard Red Notes: when a saved profile id is supplied, discover models
    // against THAT profile's provider config (its own base URL + key), not the
    // default provider. Lets the admin AI tab populate a per-profile model list.
    const requestedProfileId = typeof request.query.profileId === 'string' ? request.query.profileId.trim() : ''
    if (requestedProfileId && this.serverSettingsResolver) {
      let profile
      try {
        profile = await this.serverSettingsResolver.resolveActiveProfile(requestedProfileId)
      } catch {
        profile = undefined
      }
      if (!profile) {
        response.status(400).json({ error: { message: 'Requested profile is not configured on this server.' } })
        return
      }
      const resolution = resolveProfileProvider(profile)
      const models = await listProviderModels(resolution.providerId, resolution.config)
      response.json({ provider: resolution.providerId, profileId: profile.id, models })
      return
    }

    const providerConfig = await this.effectiveProviderConfig()
    const requested = typeof request.query.provider === 'string' ? request.query.provider : ''
    const providers = configuredProviders(providerConfig)
    const provider = requested || (providers.includes(this.defaultProvider) ? this.defaultProvider : providers[0] || '')

    if (!provider || !providers.includes(provider)) {
      response.status(400).json({
        error: { message: 'Requested provider is not configured on this server.' },
      })
      return
    }

    const models = await listProviderModels(provider, providerConfig)
    response.json({ provider, models })
  }

  @httpGet('/usage', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async usage(_request: Request, response: Response): Promise<void> {
    const userUuid = (response.locals.user as { uuid: string }).uuid
    const limits = this.resolveUserLimits(response)
    const limit = this.effectiveLimit(limits, await this.effectiveGlobalDailyLimit())
    const dayKey = this.currentDayKey()

    // Existing daily REQUEST meter (kept working alongside the new token windows).
    let used = 0
    if (this.redis) {
      try {
        const raw = await this.redis.get(this.usageKey(userUuid, dayKey))
        used = raw ? parseInt(raw, 10) : 0
      } catch {
        // Fail-open: report 0 rather than error out the whole usage payload.
      }
    }

    // New per-user rolling-window TOKEN meters (5h + weekly). Fail-open on Redis
    // error: report the windows as `unavailable` (0 used) so the client never
    // blocks on a metering read.
    const tokenLimits = await this.effectiveTokenLimits()
    const now = Date.now()
    const store = this.tokenStore()
    let fiveHour = unavailableWindowUsage(now, FIVE_HOUR_WINDOW_MS, tokenLimits.fiveHour)
    let weekly = unavailableWindowUsage(now, WEEKLY_WINDOW_MS, tokenLimits.weekly)
    if (store) {
      try {
        const entries = await store.entriesWithinWeek(userUuid, now)
        fiveHour = buildWindowUsage(entries, now, FIVE_HOUR_WINDOW_MS, tokenLimits.fiveHour)
        weekly = buildWindowUsage(entries, now, WEEKLY_WINDOW_MS, tokenLimits.weekly)
      } catch {
        // Keep the fail-open placeholders.
      }
    }

    response.json({
      // Back-compat top-level daily-request fields (older clients read these).
      used,
      limit,
      resetsAt: this.nextResetIso(),
      // Structured breakdown: daily requests + the two token windows.
      daily: { usedRequests: used, limitRequests: limit, resetsAt: this.nextResetIso() },
      tokens: { fiveHour, weekly },
    })
  }

  // ---------------------------------------------------------------------------
  // Standard Red Notes: ChatGPT / Codex SUBSCRIPTION PAIRING routes.
  //
  // These wire the pre-existing subscription service (PKCE OAuth lifecycle +
  // encrypted token store) into HTTP. The guided pairing wizard drives:
  //   status -> start (get authorize URL) -> user authorizes ->
  //   callback (redirect) OR complete (pasted code) -> status = paired.
  //
  // status/start/complete/unpair are admin-gated (they manage a server-held
  // credential) and require a session; /callback is the PUBLIC OAuth redirect
  // landing (the browser arrives without a session — its `state` is the CSRF
  // protection, single-use and consumed server-side). NO token is ever returned.
  // ---------------------------------------------------------------------------

  @httpGet('/subscription/status', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async subscriptionStatus(_request: Request, response: Response): Promise<void> {
    if (!this.requestorIsAdmin(response)) {
      response.status(403).json({ error: { message: 'Admin role required.' } })
      return
    }

    const config = await this.effectiveProviderConfig()
    const usingEnvFallback = config.openaiAuthMode === 'subscription' && Boolean(config.openaiSubscriptionToken)

    if (!this.subscriptionCredentialProvider) {
      // Not wired (no encryption key). Report the non-secret truth so the wizard
      // can explain that server-managed pairing is unavailable on this deployment.
      response.json({
        paired: false,
        mode: config.openaiAuthMode ?? undefined,
        usingEnvFallback,
        reason: 'Subscription pairing is not configured on this server (ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY unset).',
      })
      return
    }

    try {
      const status = await this.subscriptionCredentialProvider.getStatus()
      response.json({
        paired: status.paired,
        mode: config.openaiAuthMode ?? undefined,
        accountId: status.accountId,
        accountLabel: status.accountLabel,
        expiresAt: status.expiresAt,
        needsRepair: status.needsRepair,
        usingEnvFallback: !status.paired && usingEnvFallback,
      })
    } catch (error) {
      response.json({ paired: false, reason: (error as Error).message })
    }
  }

  @httpPost('/subscription/start', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async subscriptionStart(_request: Request, response: Response): Promise<void> {
    if (!this.requestorIsAdmin(response)) {
      response.status(403).json({ error: { message: 'Admin role required.' } })
      return
    }
    if (!this.subscriptionCredentialProvider) {
      response.status(503).json({ error: { message: 'Subscription pairing is not configured on this server.' } })
      return
    }

    const adminUuid = ((response.locals as { user?: { uuid?: string } }).user ?? {}).uuid ?? 'admin'
    try {
      const { authorizeUrl, state } = this.subscriptionCredentialProvider.beginPairing(adminUuid)
      response.json({ authorizeUrl, state })
    } catch (error) {
      response.status(500).json({ error: { message: (error as Error).message } })
    }
  }

  // Manual completion for the guided wizard's paste-the-code step (used when the
  // OAuth provider only permits a localhost/out-of-band redirect that cannot reach
  // this server). Exchanges the code for tokens and persists the credential.
  @httpPost('/subscription/complete', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async subscriptionComplete(request: Request, response: Response): Promise<void> {
    if (!this.requestorIsAdmin(response)) {
      response.status(403).json({ error: { message: 'Admin role required.' } })
      return
    }
    if (!this.subscriptionCredentialProvider) {
      response.status(503).json({ error: { message: 'Subscription pairing is not configured on this server.' } })
      return
    }

    const body = (request.body ?? {}) as { state?: unknown; code?: unknown }
    const state = typeof body.state === 'string' ? body.state.trim() : ''
    const code = typeof body.code === 'string' ? body.code.trim() : ''
    if (!state || !code) {
      response.status(400).json({ error: { message: 'Both `state` and `code` are required to complete pairing.' } })
      return
    }

    try {
      const record = await this.subscriptionCredentialProvider.completePairing(state, code)
      response.json({ ok: true, paired: true, accountLabel: record.accountLabel, accountId: record.accountId })
    } catch (error) {
      response.status(400).json({ ok: false, error: { message: (error as Error).message } })
    }
  }

  // PUBLIC OAuth redirect landing. The browser arrives here (no session) after the
  // user authorizes; `state` is the single-use CSRF token. Returns a tiny HTML page
  // that notifies the opener and closes — never JSON, never a token.
  @httpGet('/subscription/callback')
  async subscriptionCallback(request: Request, response: Response): Promise<void> {
    const query = request.query as Record<string, string | undefined>
    const state = (query.state ?? '').trim()
    const code = (query.code ?? '').trim()

    if (!this.subscriptionCredentialProvider) {
      response.status(503).type('html').send(this.pairingResultHtml(false, 'Subscription pairing is not configured.'))
      return
    }
    if (query.error) {
      response.status(400).type('html').send(this.pairingResultHtml(false, `Authorization failed: ${query.error}`))
      return
    }
    if (!state || !code) {
      response.status(400).type('html').send(this.pairingResultHtml(false, 'Missing authorization code or state.'))
      return
    }

    try {
      await this.subscriptionCredentialProvider.completePairing(state, code)
      response.type('html').send(this.pairingResultHtml(true, 'Pairing complete. You can close this window.'))
    } catch (error) {
      response.status(400).type('html').send(this.pairingResultHtml(false, (error as Error).message))
    }
  }

  @httpPost('/subscription/unpair', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async subscriptionUnpair(_request: Request, response: Response): Promise<void> {
    if (!this.requestorIsAdmin(response)) {
      response.status(403).json({ error: { message: 'Admin role required.' } })
      return
    }
    if (!this.subscriptionCredentialProvider) {
      response.status(503).json({ error: { message: 'Subscription pairing is not configured on this server.' } })
      return
    }

    try {
      await this.subscriptionCredentialProvider.unpair()
      response.json({ ok: true })
    } catch (error) {
      response.status(500).json({ ok: false, error: { message: (error as Error).message } })
    }
  }

  /**
   * Standard Red Notes: SUBSCRIPTION USAGE (admin, read-only).
   *
   * HONESTY: ChatGPT/Codex subscriptions do NOT expose a documented, queryable
   * usage/quota endpoint — the Codex backend only returns rate-limit state in
   * per-response headers, not a pollable API. So this reports the tokens SRN has
   * METERED LOCALLY for subscription-backed (`codex-subscription`) proxy calls,
   * aggregated across all users over the same 5h + weekly rolling windows. It is
   * clearly labelled `source: 'srn-local-metering'` and is NOT OpenAI's official
   * quota. Fail-open: reports `unavailable` windows on a Redis error.
   */
  @httpGet('/subscription/usage', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async subscriptionUsage(_request: Request, response: Response): Promise<void> {
    if (!this.requestorIsAdmin(response)) {
      response.status(403).json({ error: { message: 'Admin role required.' } })
      return
    }

    const now = Date.now()
    const store = this.tokenStore()
    // No configured limit on the aggregate — it reports consumption, not a cap.
    let fiveHour = unavailableWindowUsage(now, FIVE_HOUR_WINDOW_MS, 0)
    let weekly = unavailableWindowUsage(now, WEEKLY_WINDOW_MS, 0)
    if (store) {
      try {
        const entries = await store.entriesWithinWeek(SUBSCRIPTION_USAGE_SUBJECT, now)
        fiveHour = buildWindowUsage(entries, now, FIVE_HOUR_WINDOW_MS, 0)
        weekly = buildWindowUsage(entries, now, WEEKLY_WINDOW_MS, 0)
      } catch {
        // Keep the fail-open placeholders.
      }
    }

    const config = await this.effectiveProviderConfig()
    response.json({
      source: 'srn-local-metering',
      subscriptionMode: config.openaiAuthMode === 'subscription',
      tokens: { fiveHour, weekly },
    })
  }

  /**
   * Minimal self-contained HTML for the OAuth callback window: it postMessages the
   * opener (best-effort success signal; the wizard also polls /status) and closes.
   * No secrets — only the success/failure boolean and a human message.
   */
  private pairingResultHtml(success: boolean, message: string): string {
    const safeMessage = message.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string))
    return `<!doctype html><html><head><meta charset="utf-8"><title>ChatGPT pairing</title></head>
<body style="font-family: system-ui, sans-serif; padding: 2rem; text-align: center;">
<h2>${success ? 'Pairing complete' : 'Pairing failed'}</h2>
<p>${safeMessage}</p>
<script>
try { if (window.opener) { window.opener.postMessage({ type: 'chatgpt-paired', success: ${success ? 'true' : 'false'} }, '*') } } catch (e) {}
setTimeout(function(){ try { window.close() } catch (e) {} }, ${success ? 1200 : 4000})
</script>
</body></html>`
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

    const limit = this.effectiveLimit(limits, await this.effectiveGlobalDailyLimit())
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

    // 3) Meter per user per rolling TOKEN window (5h + weekly). We CHECK BEFORE
    // starting — a request already in flight is never hard-broken mid-stream —
    // and reject when the user is already at/over either configured window. We
    // cannot know this request's token spend up front, so "would exceed" is
    // enforced as "is already at the cap". Fail-open: any Redis error here lets
    // the request through rather than blocking on a metering read.
    const tokenLimits = await this.effectiveTokenLimits()
    const tokenStore = this.tokenStore()
    if (tokenStore && (tokenLimits.fiveHour > 0 || tokenLimits.weekly > 0)) {
      try {
        const now = Date.now()
        const entries = await tokenStore.entriesWithinWeek(userUuid, now)
        const fiveHour = buildWindowUsage(entries, now, FIVE_HOUR_WINDOW_MS, tokenLimits.fiveHour)
        const weekly = buildWindowUsage(entries, now, WEEKLY_WINDOW_MS, tokenLimits.weekly)
        const exceeded: { id: TokenWindowId; usedTokens: number; limitTokens: number; resetsAt: string } | undefined =
          isOverTokenLimit(fiveHour.usedTokens, tokenLimits.fiveHour)
            ? { id: 'fiveHour', ...fiveHour }
            : isOverTokenLimit(weekly.usedTokens, tokenLimits.weekly)
              ? { id: 'weekly', ...weekly }
              : undefined

        if (exceeded) {
          // Refund the daily request meter we incremented above — this request
          // is rejected before any upstream proxying happens.
          await this.refundUsage(userUuid, dayKey, limit)
          response.status(429).json({
            error: {
              tag: 'ai-token-limit-reached',
              message: `Your ${windowLabel(exceeded.id)} AI token limit (${exceeded.limitTokens.toLocaleString()} tokens) has been reached. It resets at ${exceeded.resetsAt}.`,
              window: exceeded.id,
              usedTokens: exceeded.usedTokens,
              limitTokens: exceeded.limitTokens,
              resetsAt: exceeded.resetsAt,
            },
          })
          return
        }
      } catch {
        // Fail-open: never block a request because the token meter is unreadable.
      }
    }

    let provider: Provider
    let isSubscription = false
    try {
      const resolved = await this.resolveStreamProvider(body, request)
      provider = resolved.provider
      isSubscription = resolved.isSubscription
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

    // Token accounting for this request: prefer the provider's REAL usage tokens
    // (OpenAI include_usage / Gemini / Cohere emit a `usage` event); otherwise
    // fall back to an ESTIMATE from prompt + streamed-completion text length,
    // flagged so the meter can be honest about the approximation.
    let reportedTokens = 0
    let sawUsageEvent = false
    let completionChars = 0

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
        if (event.kind === 'usage') {
          const total =
            event.totalTokens && event.totalTokens > 0
              ? event.totalTokens
              : (event.promptTokens ?? 0) + (event.completionTokens ?? 0)
          if (total > 0) {
            reportedTokens += total
            sawUsageEvent = true
          }
        } else if (event.kind === 'text-delta') {
          completionChars += event.delta.length
        }
        writeEvent(event)
      }
    } catch (error) {
      writeEvent({ kind: 'error', message: (error as Error).message })
      writeEvent({ kind: 'finish', stopReason: 'error' })
    } finally {
      response.end()
      // Record the request's token spend AFTER it completes (best-effort, never
      // affects the response). Real usage when the provider reported it, else an
      // estimate. Subscription-backed calls also feed the admin aggregate meter.
      const spentTokens = sawUsageEvent
        ? reportedTokens
        : this.estimateRequestTokens(body, completionChars)
      await this.recordTokenUsage(userUuid, spentTokens, isSubscription)
    }
  }

  /** Estimate a request's total tokens from prompt text + streamed completion length. */
  private estimateRequestTokens(body: StreamRequestBody, completionChars: number): number {
    const promptText = [body.system ?? '', ...(body.messages ?? []).map((message) => message.content ?? '')].join('\n')
    return estimateTokensFromText(promptText) + estimateTokensFromChars(completionChars)
  }

  /**
   * Persist a completed request's token spend to the rolling-window meter for the
   * user and, when the call was subscription-backed, to the shared subscription
   * aggregate the admin card reads. Best-effort: swallow Redis errors.
   */
  private async recordTokenUsage(userUuid: string, tokens: number, isSubscription: boolean): Promise<void> {
    const store = this.tokenStore()
    if (!store || tokens <= 0) {
      return
    }
    const now = Date.now()
    try {
      await store.record(userUuid, tokens, now)
      if (isSubscription) {
        await store.record(SUBSCRIPTION_USAGE_SUBJECT, tokens, now)
      }
    } catch {
      // Metering is best-effort and must never surface to the client.
    }
  }

  /**
   * Standard Red Notes: resolves the concrete provider for a /stream request,
   * honoring MULTIPLE named profiles.
   *
   *  - When the client selects a profile (body.profileId or the x-assistant-profile
   *    header), or sends NO explicit provider, the active profile (requested, else
   *    the default) is resolved into a provider. A codex-subscription profile with
   *    no inline token draws a fresh token from the paired subscription credential.
   *  - Otherwise (the client sent an explicit `provider`) the pre-existing legacy
   *    path is used unchanged, so every current client keeps working.
   */
  private async resolveStreamProvider(
    body: StreamRequestBody,
    request: Request,
  ): Promise<{ provider: Provider; isSubscription: boolean }> {
    const headerProfileId =
      typeof request.headers['x-assistant-profile'] === 'string'
        ? (request.headers['x-assistant-profile'] as string).trim()
        : undefined
    const requestedProfileId = (body.profileId && body.profileId.trim()) || headerProfileId || undefined

    if (this.serverSettingsResolver && (requestedProfileId || !body.provider)) {
      let profile
      try {
        profile = await this.serverSettingsResolver.resolveActiveProfile(requestedProfileId)
      } catch {
        profile = undefined
      }

      if (profile) {
        const resolution = resolveProfileProvider(profile, body.model)
        if (
          profile.provider === 'codex-subscription' &&
          !resolution.config.openaiSubscriptionToken &&
          this.subscriptionCredentialProvider
        ) {
          const credential = await this.subscriptionCredentialProvider.getFreshCredential()
          if (credential) {
            resolution.config.openaiSubscriptionToken = credential.token
            if (credential.accountId) {
              resolution.config.openaiAccountId = credential.accountId
            }
          }
        }
        return {
          provider: resolveProvider(resolution.providerId, resolution.model || this.defaultModel, resolution.config),
          isSubscription: profile.provider === 'codex-subscription',
        }
      }

      if (requestedProfileId) {
        throw new Error(`Requested assistant profile "${requestedProfileId}" is not configured or is disabled.`)
      }
    }

    // Legacy path (fully back-compat): honor the client's chosen provider + model.
    const providerId = body.provider || this.defaultProvider
    const model = body.model || this.defaultModel
    const config = await this.effectiveProviderConfig()
    return {
      provider: resolveProvider(providerId, model, config),
      // The legacy single-provider path is subscription-backed when the OpenAI
      // provider is configured in subscription (Codex/ChatGPT) auth mode.
      isSubscription: providerId === 'openai' && config.openaiAuthMode === 'subscription',
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

  private effectiveLimit(limits: ResolvedUserLimits, globalDailyLimit: number = this.globalDailyLimit): number {
    if (limits.perUserLimit !== undefined && limits.perUserLimit > 0) {
      return limits.perUserLimit
    }
    // IMPORTANT: a return value of 0 means UNLIMITED (no daily cap is enforced).
    // The global ceiling comes from the ASSISTANT_DAILY_REQUEST_LIMIT env var —
    // or a runtime admin override persisted via /v1/admin/server-settings, which
    // WINS over the env value (see ServerSettingsResolver) — and defaults to 0
    // when unset/empty (see Bootstrap/Container.ts). So out of the box, AI usage
    // is UNLIMITED. Operators who want to cap usage MUST set a POSITIVE value
    // (a per-user override via the AI_REQUEST_LIMIT setting takes precedence
    // above). Any value <= 0 is intentionally treated as unlimited — do not
    // "fix" this to a default cap.
    return globalDailyLimit > 0 ? globalDailyLimit : 0
  }

  private async refundUsage(userUuid: string, dayKey: string, limit: number): Promise<void> {
    if (this.redis && limit > 0) {
      await this.redis.decr(this.usageKey(userUuid, dayKey))
    }
  }

  /**
   * Resolves per-user AI settings (AI_ENABLED / AI_REQUEST_LIMIT).
   *
   * These ride along inside the cross-service token: CreateCrossServiceToken (auth
   * service) reads AI_ENABLED / AI_REQUEST_LIMIT from the auth settings store at
   * token-mint time and embeds them as `ai_enabled` / `ai_request_limit`, and
   * RequiredCrossServiceTokenMiddleware projects them onto `response.locals.settings`
   * (the same channel the OCR gate uses). So no extra cross-service round trip is
   * needed here.
   *
   * Resolution rules:
   *  - `aiEnabled` is set to `false` ONLY when an admin has explicitly disabled AI
   *    for the user (the token carries AI_ENABLED='false'). `streamCompletion`
   *    then FAILS CLOSED with 403 before proxying. An absent flag (older token /
   *    never-set setting) leaves `aiEnabled` undefined => default-on.
   *  - `perUserLimit` is the positive per-user daily override; when absent the
   *    GLOBAL env ceiling (ASSISTANT_DAILY_REQUEST_LIMIT) applies.
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
