import { Request, Response } from 'express'
import { ServiceContainerInterface, ServiceIdentifier } from '@standardnotes/domain-core'

import { ServiceProxyInterface } from '../Proxy/ServiceProxyInterface'
import { ResponseLocals } from '../../Controller/ResponseLocals'

export class DirectCallServiceProxy implements ServiceProxyInterface {
  constructor(
    private serviceContainer: ServiceContainerInterface,
    private filesServerUrl: string,
  ) {}

  async validateSession(dto: {
    headers: {
      authorization: string
      sharedVaultOwnerContext?: string
    }
    cookies?: Map<string, string[]>
    retryAttempt?: number
    requestMetadata?: {
      snjs?: string
      application?: string
    }
  }): Promise<{
    status: number
    data: unknown
    headers: {
      contentType: string
    }
  }> {
    const authService = this.serviceContainer.get(ServiceIdentifier.create(ServiceIdentifier.NAMES.Auth).getValue())
    if (!authService) {
      throw new Error('Auth service not found')
    }

    let stringOfCookies = ''
    for (const cookieName of dto.cookies?.keys() ?? []) {
      for (const cookieValue of dto.cookies?.get(cookieName) as string[]) {
        stringOfCookies += `${cookieName}=${cookieValue}; `
      }
    }

    const serviceResponse = (await authService.handleRequest(
      {
        body: {
          authTokenFromHeaders: dto.headers.authorization,
          sharedVaultOwnerContext: dto.headers.sharedVaultOwnerContext,
        },
        headers: {
          'x-snjs-version': dto.requestMetadata?.snjs,
          'x-application-version': dto.requestMetadata?.application,
          cookie: stringOfCookies.trim(),
        },
      } as never,
      {} as never,
      'auth.sessions.validate',
    )) as {
      statusCode: number
      json: Record<string, unknown>
    }

    return {
      status: serviceResponse.statusCode,
      data: serviceResponse.json,
      headers: { contentType: 'application/json' },
    }
  }

  async callEmailServer(_request: Request, response: Response, _methodIdentifier: string): Promise<void> {
    response.status(400).send({
      error: {
        message: 'Email server is not available.',
      },
    })
  }

  async callAuthServer(request: never, response: never, methodIdentifier: string): Promise<void> {
    const authService = this.serviceContainer.get(ServiceIdentifier.create(ServiceIdentifier.NAMES.Auth).getValue())
    if (!authService) {
      throw new Error('Auth service not found')
    }

    const serviceResponse = (await authService.handleRequest(request, response, methodIdentifier)) as {
      statusCode: number
      json: Record<string, unknown>
    }

    this.sendDecoratedResponse(response, serviceResponse)
  }

  async callAuthServerWithLegacyFormat(
    _request: Request,
    response: Response,
    _methodIdentifier: string,
  ): Promise<void> {
    response.status(400).send({
      error: {
        message: 'Legacy auth endpoints are no longer available.',
      },
    })
  }

  async callRevisionsServer(request: never, response: never, methodIdentifier: string): Promise<void> {
    const service = this.serviceContainer.get(ServiceIdentifier.create(ServiceIdentifier.NAMES.Revisions).getValue())
    if (!service) {
      throw new Error('Revisions service not found')
    }

    const serviceResponse = (await service.handleRequest(request, response, methodIdentifier)) as {
      statusCode: number
      json: Record<string, unknown>
    }

    this.sendDecoratedResponse(response, serviceResponse)
  }

  async callSyncingServer(request: never, response: never, methodIdentifier: string): Promise<void> {
    const service = this.serviceContainer.get(
      ServiceIdentifier.create(ServiceIdentifier.NAMES.SyncingServer).getValue(),
    )
    if (!service) {
      throw new Error('Syncing service not found')
    }

    const serviceResponse = (await service.handleRequest(request, response, methodIdentifier)) as {
      statusCode: number
      json: Record<string, unknown>
    }

    this.sendDecoratedResponse(response, serviceResponse)
  }

  async callLegacySyncingServer(_request: Request, response: Response, _methodIdentifier: string): Promise<void> {
    response.status(400).send({
      error: {
        message: 'Legacy syncing server endpoints are no longer available.',
      },
    })
  }

  async callPaymentsServer(_request: Request, response: Response, _methodIdentifier: string): Promise<void> {
    response.status(400).send({
      error: {
        message: 'Payments server is not available.',
      },
    })
  }

  async callWebSocketServer(_request: Request, response: Response, methodIdentifier: string): Promise<void> {
    const webSocketServerUrl = process.env.WEB_SOCKET_SERVER_URL
    const locals = response.locals as ResponseLocals

    // Only the connection-token endpoint is relevant to the self-hosted gateway;
    // the AWS $connect/$disconnect registration endpoints are unused because the
    // gateway's ws server manages connection lifecycle directly.
    const isTokenRequest = methodIdentifier.toLowerCase().includes('token')

    if (!webSocketServerUrl || !isTokenRequest || !locals.user?.uuid || !locals.session?.uuid) {
      response.status(400).send({
        error: {
          message: 'Websockets server is not available.',
        },
      })
      return
    }

    try {
      const upstream = await fetch(`${webSocketServerUrl.replace(/\/$/, '')}/sockets/tokens`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-secret': process.env.WEBSOCKET_GATEWAY_INTERNAL_SECRET ?? '',
        },
        body: JSON.stringify({ userUuid: locals.user.uuid, sessionUuid: locals.session.uuid }),
      })
      const data = (await upstream.json()) as Record<string, unknown>
      response.status(upstream.status).send(data)
    } catch (_error) {
      response.status(502).send({
        error: {
          message: 'Could not reach the websockets gateway.',
        },
      })
    }
  }

  private sendDecoratedResponse(
    response: Response,
    serviceResponse: { statusCode: number; json: Record<string, unknown> },
  ): void {
    const locals = response.locals as ResponseLocals

    void response.status(serviceResponse.statusCode).send({
      meta: {
        auth: {
          userUuid: locals.user?.uuid,
          roles: locals.roles,
        },
        server: {
          filesServerUrl: this.filesServerUrl,
        },
      },
      data: serviceResponse.json,
    })
  }
}
