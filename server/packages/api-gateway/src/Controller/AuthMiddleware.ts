import { CrossServiceTokenData } from '@standardnotes/security'
import { TimerInterface } from '@standardnotes/time'
import { NextFunction, Request, Response } from 'express'
import { BaseMiddleware } from 'inversify-express-utils'
import { verify } from 'jsonwebtoken'
import { AxiosError } from 'axios'
import { Logger } from 'winston'

import { CrossServiceTokenCacheInterface } from '../Service/Cache/CrossServiceTokenCacheInterface'
import { ServiceProxyInterface } from '../Service/Proxy/ServiceProxyInterface'
import { ResponseLocals } from './ResponseLocals'
import { RoleName, SettingName } from '@standardnotes/domain-core'

export abstract class AuthMiddleware extends BaseMiddleware {
  constructor(
    private serviceProxy: ServiceProxyInterface,
    private jwtSecret: string,
    private crossServiceTokenCacheTTL: number,
    private crossServiceTokenCache: CrossServiceTokenCacheInterface,
    private timer: TimerInterface,
    protected logger: Logger,
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
            url: request.url,
            method: request.method,
            userAgent: request.headers['user-agent'],
            secChUa: request.headers['sec-ch-ua'] as string,
            ip: this.clientIpFromRequest(request),
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

      Object.assign(response.locals, {
        authToken: crossServiceToken,
        user: decodedToken.user,
        session: decodedToken.session,
        roles: decodedToken.roles,
        sharedVaultOwnerContext: decodedToken.shared_vault_owner_context,
        readOnlyAccess: decodedToken.session?.readonly_access ?? false,
        isFreeUser: decodedToken.roles.length === 1 && decodedToken.roles[0].name === RoleName.NAMES.CoreUser,
        belongsToSharedVaults: decodedToken.belongs_to_shared_vaults ?? [],
        authTokenVersion: decodedToken.version,
        // Standard Red Notes: project per-user feature settings carried by the
        // cross-service token onto response.locals.settings so feature controllers
        // (AssistantController, OcrController) can enforce per-user gates/limits.
        // Only defined keys are set so an absent flag stays "unresolved" (which the
        // AI/OCR gates treat as their respective default).
        settings: this.projectSettings(decodedToken),
      } as ResponseLocals)
    } catch (error) {
      let detailedErrorMessage = (error as Error).message
      if (error instanceof AxiosError) {
        detailedErrorMessage = `Status: ${error.status}, code: ${error.code}, message: ${error.message}`
      }

      this.logger.error(
        `Could not pass the request to sessions/validate on underlying service: ${detailedErrorMessage}`,
      )

      this.logger.debug(`Response error: ${JSON.stringify(error)}`)

      if ((error as AxiosError).response?.headers['content-type']) {
        response.setHeader('content-type', (error as AxiosError).response?.headers['content-type'] as string)
      }

      const errorCode =
        (error as AxiosError).isAxiosError && !isNaN(+((error as AxiosError).code as string))
          ? +((error as AxiosError).code as string)
          : 500

      const responseErrorMessage = (error as AxiosError).response?.data

      response
        .status(errorCode)
        .send(
          responseErrorMessage ??
            "Unfortunately, we couldn't handle your request. Please try again or contact our support if the error persists.",
        )

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

    return settings
  }

  private clientIpFromRequest(request: Request): string {
    const forwardedFor = request.headers['x-forwarded-for']
    if (forwardedFor) {
      const value = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor
      const leftmost = value.split(',')[0]?.trim()
      if (leftmost) {
        return leftmost
      }
    }

    return request.socket?.remoteAddress ?? request.ip ?? ''
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
