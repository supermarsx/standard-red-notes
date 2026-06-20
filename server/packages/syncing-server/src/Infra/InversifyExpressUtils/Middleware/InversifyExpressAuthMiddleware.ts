import { NextFunction, Request, Response } from 'express'
import { BaseMiddleware } from 'inversify-express-utils'
import { verify } from 'jsonwebtoken'
import { CrossServiceTokenData } from '@standardnotes/security'
import * as winston from 'winston'
import { RoleName } from '@standardnotes/domain-core'
import { ResponseLocals } from '../ResponseLocals'

export class InversifyExpressAuthMiddleware extends BaseMiddleware {
  constructor(
    private authJWTSecret: string,
    private logger: winston.Logger,
  ) {
    super()
  }

  async handler(request: Request, response: Response, next: NextFunction): Promise<void> {
    try {
      if (!request.header('X-Auth-Token')) {
        this.logger.debug('Missing X-Auth-Token header')

        return this.sendInvalidAuthResponse(response)
      }

      const authToken = request.header('X-Auth-Token') as string

      const decodedToken = verify(authToken, this.authJWTSecret, { algorithms: ['HS256'] }) as CrossServiceTokenData

      // Standard Red Notes: an MCP scoped token with access=read must be hard
      // enforced as read-only server-side (writes are rejected at SaveItems).
      // Tag-scope is carried for the client-side bridge only; not enforced here.
      const mcpScope = decodedToken.mcp_scope
      const readOnlyAccess = (decodedToken.session?.readonly_access ?? false) || mcpScope?.access === 'read'

      Object.assign(response.locals, {
        user: decodedToken.user,
        roles: decodedToken.roles,
        isFreeUser: decodedToken.roles.length === 1 && decodedToken.roles[0].name === RoleName.NAMES.CoreUser,
        session: decodedToken.session,
        readOnlyAccess,
        mcpScope,
        sharedVaultOwnerContext: decodedToken.shared_vault_owner_context,
        hasContentLimit: decodedToken.hasContentLimit,
      } as ResponseLocals)

      return next()
    } catch (error) {
      this.logger.error(`Could not verify JWT Auth Token ${(error as Error).message}`)

      return this.sendInvalidAuthResponse(response)
    }
  }

  private sendInvalidAuthResponse(response: Response) {
    response.status(401).send({
      error: {
        tag: 'invalid-auth',
        message: 'Invalid login credentials.',
      },
    })
  }
}
