import { CrossServiceTokenData } from '@standardnotes/security'
import { TimerInterface } from '@standardnotes/time'
import { NextFunction, Request, Response } from 'express'
import { BaseMiddleware, sanitizeRequestUrlForLogging } from 'inversify-express-utils'
import { verify } from 'jsonwebtoken'
import { Logger } from 'winston'

import { CrossServiceTokenCacheInterface } from '../Service/Cache/CrossServiceTokenCacheInterface'
import { ServiceProxyInterface } from '../Service/Proxy/ServiceProxyInterface'
import { ResponseLocals } from './ResponseLocals'
import { resolveClientIpFromRequest } from './ClientIp'
import { RoleName, SettingName } from '@standardnotes/domain-core'
import { PublicServiceFailure, publicHttpErrorStatus, safeHttpErrorLogMetadata } from '../Service/Logging/SafeLog'

export abstract class AuthMiddleware extends BaseMiddleware {
  constructor(
    private serviceProxy: ServiceProxyInterface,
    private jwtSecret: string,
    private crossServiceTokenCacheTTL: number,
    private crossServiceTokenCache: CrossServiceTokenCacheInterface,
    private timer: TimerInterface,
    protected logger: Logger,
    // Standard Red Notes: optional trusted client-IP header name (CLIENT_IP_HEADER;
    // empty = off). Threaded into the canonical resolver so the session/security IP
    // sent to auth matches the rate limiter + ACL. Defaults to off.
    private clientIpHeader: string = '',
  ) {
    super()
  }

  async handler(request: Request, response: Response, next: NextFunction): Promise<void> {
    if (!this.handleMissingAuthHeader(request.headers.authorization, response, next)) {
      return
    }

    const authHeaderValue = request.headers.authorization as string
    const sharedVaultOwnerContextHeaderValue = request.headers['x-shared-vault-owner-context'] as string | undefined
    const cacheKey = `${authHeaderValue}${
      sharedVaultOwnerContextHeaderValue ? `:${sharedVaultOwnerContextHeaderValue}` : ''
    }`

    try {
      let crossServiceTokenFetchedFromCache = true
      let crossServiceToken = null
      if (this.crossServiceTokenCacheTTL) {
        crossServiceToken = await this.crossServiceTokenCache.get(cacheKey)
      }

      if (crossServiceToken === null) {
        const cookiesFromHeaders = new Map<string, string[]>()
        request.headers.cookie?.split(';').forEach((cookie) => {
          const parts = cookie.split('=')
          if (parts.length === 2) {
            const existingCookies = cookiesFromHeaders.get(parts[0].trim())
            if (existingCookies) {
              existingCookies.push(parts[1].trim())
              cookiesFromHeaders.set(parts[0].trim(), existingCookies)
            } else {
              cookiesFromHeaders.set(parts[0].trim(), [parts[1].trim()])
            }
          }
        })
        const authResponse = await this.serviceProxy.validateSession({
          headers: {
            authorization: authHeaderValue.replace('Bearer ', ''),
            sharedVaultOwnerContext: sharedVaultOwnerContextHeaderValue,
          },
          requestMetadata: {
            snjs: request.headers['x-snjs-version'] as string,
            application: request.headers['x-application-version'] as string,
            url: sanitizeRequestUrlForLogging(request.url),
            method: request.method,
            userAgent: request.headers['user-agent'],
            secChUa: request.headers['sec-ch-ua'] as string,
            // Standard Red Notes: THE canonical client-IP resolver (resolveClientIp)
            // rather than hand-parsing the leftmost X-Forwarded-For, which a direct
            // client can spoof. It honors the configured TRUST_PROXY (via request.ip)
            // and the optional CLIENT_IP_HEADER, and normalizes the result — so the
            // session/security IP recorded by auth matches the RateLimitMiddleware
            // buckets and the IP allow/block list exactly.
            ip: resolveClientIpFromRequest(request, this.clientIpHeader),
          },
          cookies: cookiesFromHeaders,
        })

        if (!this.handleSessionValidationResponse(authResponse, response, next)) {
          return
        }

        this.logger.debug('[AuthMiddleware] Fetched cross-service token from underlying service')

        crossServiceToken = (authResponse.data as { authToken: string }).authToken
        crossServiceTokenFetchedFromCache = false
      }

      const decodedToken = verify(crossServiceToken, this.jwtSecret, { algorithms: ['HS256'] }) as CrossServiceTokenData

      if (this.crossServiceTokenCacheTTL && !crossServiceTokenFetchedFromCache) {
        await this.crossServiceTokenCache.set({
          key: cacheKey,
          encodedCrossServiceToken: crossServiceToken,
          expiresAtInSeconds: this.getCrossServiceTokenCacheExpireTimestamp(decodedToken),
          userUuid: decodedToken.user.uuid,
        })
      }

      const mcpScope = decodedToken.mcp_scope
      const readOnlyAccess = (decodedToken.session?.readonly_access ?? false) || mcpScope?.access === 'read'

      Object.assign(response.locals, {
        authToken: crossServiceToken,
        user: decodedToken.user,
        session: decodedToken.session,
        roles: decodedToken.roles,
        sharedVaultOwnerContext: decodedToken.shared_vault_owner_context,
        readOnlyAccess,
        mcpScope,
        isFreeUser: decodedToken.roles.length === 1 && decodedToken.roles[0].name === RoleName.NAMES.CoreUser,
        belongsToSharedVaults: decodedToken.belongs_to_shared_vaults ?? [],
        hasContentLimit: decodedToken.hasContentLimit === true,
        collaborationEnabled: decodedToken.collaboration_enabled !== false,
        liveSyncEnabled: decodedToken.live_sync_enabled !== false,
        authTokenVersion: decodedToken.version,
        // Standard Red Notes: SHADOW-BAN pass-through. Projected onto locals so
        // gateway controllers can see it; the enforced degradation is applied by
        // the syncing-server off the same token field. Absent ⇒ not shadow-banned.
        shadowBanned: decodedToken.shadow_banned === true,
        // Standard Red Notes: project per-user feature settings carried by the
        // cross-service token onto response.locals.settings so feature controllers
        // (AssistantController, OcrController) can enforce per-user gates/limits.
        // Only defined keys are set so an absent flag stays "unresolved" (which the
        // AI/OCR gates treat as their respective default).
        settings: this.projectSettings(decodedToken),
      } as ResponseLocals)
    } catch (error) {
      const safeError = safeHttpErrorLogMetadata(error, {
        action: 'session.validate',
        endpoint: '/sessions/validate',
        method: request.method,
      })
      this.logger.error('Could not validate session on underlying service.', safeError)
      this.logger.debug('Session validation failure summary.', safeError)

      response.status(publicHttpErrorStatus(error)).send(PublicServiceFailure)

      return
    }

    return next()
  }

  protected abstract handleSessionValidationResponse(
    authResponse: {
      status: number
      data: unknown
      headers: {
        contentType: string
      }
    },
    response: Response,
    next: NextFunction,
  ): boolean

  protected abstract handleMissingAuthHeader(
    authHeaderValue: string | undefined,
    response: Response,
    next: NextFunction,
  ): boolean

  /**
   * Standard Red Notes: project the per-user feature settings the cross-service
   * token carries onto a flat `{ SETTING_NAME: value }` map, matching the shape
   * the feature controllers read from `response.locals.settings`.
   *
   * AI_ENABLED is default-on (absent flag => enabled), but we only emit the key
   * when the token explicitly carries `ai_enabled === false`, so the
   * AssistantController can FAIL CLOSED on an explicit admin disable while still
   * allowing access when the token predates this field. AI_REQUEST_LIMIT is only
   * emitted when a positive per-user override exists.
   */
  private projectSettings(decodedToken: CrossServiceTokenData): Record<string, unknown> {
    const settings: Record<string, unknown> = {}

    if (decodedToken.ai_enabled === false) {
      settings[SettingName.NAMES.AiEnabled] = 'false'
    } else if (decodedToken.ai_enabled === true) {
      settings[SettingName.NAMES.AiEnabled] = 'true'
    }

    if (typeof decodedToken.ai_request_limit === 'number' && decodedToken.ai_request_limit > 0) {
      settings[SettingName.NAMES.AiRequestLimit] = decodedToken.ai_request_limit
    }

    // WORKFLOWS_ENABLED is OPT-IN (default-off): auth emits `workflows_enabled`
    // ONLY when the admin-managed setting is literally 'true', so the key is
    // projected only in that case. An absent key means "not entitled" and the
    // WorkflowsController FAILS CLOSED, which is the correct default.
    if (decodedToken.workflows_enabled === true) {
      settings[SettingName.NAMES.WorkflowsEnabled] = 'true'
    }

    // CALDAV_ENABLED is OPT-IN (default-off): auth emits `caldav_enabled` only
    // for the literal per-user opt-in. Omitted and false values remain absent so
    // CalDAV management controllers fail closed for old or unentitled tokens.
    if (decodedToken.caldav_enabled === true) {
      settings[SettingName.NAMES.CaldavEnabled] = 'true'
    }

    // OCR_SERVER_ALLOWED is OPT-IN (default-off) like WORKFLOWS_ENABLED: auth
    // emits `ocr_server_allowed` ONLY when the admin-managed setting is literally
    // 'true', so the key is projected only in that case. An absent key means "not
    // entitled" and the OcrController FAILS CLOSED, which is the correct default
    // for this privacy-sensitive E2E downgrade (decrypted page images leave the
    // device). The projected value matches the string shape OcrController reads.
    if (decodedToken.ocr_server_allowed === true) {
      settings[SettingName.NAMES.OcrServerAllowed] = 'true'
    }

    return settings
  }

  private getCrossServiceTokenCacheExpireTimestamp(token: CrossServiceTokenData): number {
    const crossServiceTokenDefaultCacheExpiration = this.timer.getTimestampInSeconds() + this.crossServiceTokenCacheTTL

    if (token.session === undefined) {
      return crossServiceTokenDefaultCacheExpiration
    }

    const sessionAccessExpiration = this.timer.convertStringDateToSeconds(token.session.access_expiration)
    const sessionRefreshExpiration = this.timer.convertStringDateToSeconds(token.session.refresh_expiration)

    return Math.min(crossServiceTokenDefaultCacheExpiration, sessionAccessExpiration, sessionRefreshExpiration)
  }
}
