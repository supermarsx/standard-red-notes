import { Request, Response } from 'express'
import { ServiceContainerInterface, ServiceIdentifier } from '@standardnotes/domain-core'

import { ServiceProxyInterface } from '../Proxy/ServiceProxyInterface'
import { ResponseLocals } from '../../Controller/ResponseLocals'
import { webSocketGatewayAccessService } from '../Sync/SyncWebSocketRuntime'
import { createDirectCallResponse } from '../Sync/DirectCallResponse'
import { createDirectCallRequest } from '../Sync/DirectCallRequest'

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

    // `BaseSessionsController.validate` is declared `validate(request: Request)`
    // and never names a response, so the bare `{}` that used to sit here was
    // unreachable -- but it was the same fabrication that failed 100 % of the
    // websocket sync lane at `e2e87e10` once the controller on the other end
    // grew a `setHeader`, and this one runs on EVERY single-container request.
    // The locals are empty on purpose: this call is what establishes the
    // session, so there is nothing authenticated to project yet.
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
      createDirectCallResponse({}) as never,
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

  /**
   * The four methods on this class that answer a fixed 400 read NO argument at
   * all, so their `_payload` is deliberately unread -- but it is still
   * DECLARED. `ServiceProxyInterface` says four parameters; an implementation
   * that admits to three is the shape that denied 100 % of collaboration on
   * this topology (see `callSyncingServer`), and "this one happens not to need
   * it" is exactly the reasoning that left the hole open the first time.
   * `ServiceProxyArity.spec.ts` holds every method of every implementation to
   * the interface's width for that reason.
   */
  async callEmailServer(
    _request: Request,
    response: Response,
    _methodIdentifier: string,
    _payload?: Record<string, unknown> | string,
  ): Promise<void> {
    response.status(400).send({
      error: {
        message: 'Email server is not available.',
      },
    })
  }

  /**
   * `payload` is forwarded as the request body, exactly as `callSyncingServer`
   * does it and for the same reason -- see the note there.
   *
   * Almost every caller of this method passes `request.body`, which is already
   * the body of the request being forwarded, so for them the argument is
   * redundant and dropping it changed nothing. TWO callers pass a body that
   * exists ONLY as this argument, and both were reading `undefined` on this
   * topology:
   *
   *  - `SessionsController.deleteSession` sends `{ uuid: request.params.uuid }`
   *    for `DELETE /v1/sessions/:uuid`, and `BaseSessionController.deleteSession`
   *    reads `request.body.uuid`. MEASURED on two containers built from the
   *    same tree: revoking another device's session over a bodyless
   *    `DELETE /v1/sessions/<uuid>` answered **500** and left the session alive
   *    on the single container, against **204** and gone on compose. The 500 is
   *    `TypeError: Cannot read properties of undefined (reading 'uuid')` --
   *    Express 5 leaves `request.body` undefined for a bodyless request, and
   *    with the payload discarded that is what the controller read. With an
   *    empty `{}` body it degraded instead to
   *    `400 Please provide the session identifier.`, a refusal naming a
   *    parameter the caller HAD supplied. Today's SNJS client also repeats the
   *    uuid in the DELETE body, which is the only reason the app itself did not
   *    see this; any other client, and the idiomatic bodyless form, did.
   *  - `ValetTokenFileResourceAuthorizer.authorizePersonalResource` mints
   *    `POST valet-tokens` with `{ operation, resources }`, a body
   *    `BaseValetTokenController.create` reads in full. That composition runs
   *    only in the standalone api-gateway process (where the bound proxy is the
   *    HTTP or gRPC one), so it was latent rather than live -- but it is latent
   *    only because of a binding in `Container.ts`, not because of anything in
   *    this method.
   */
  async callAuthServer(
    request: never,
    response: never,
    methodIdentifier: string,
    payload?: Record<string, unknown> | string,
  ): Promise<void> {
    const authService = this.serviceContainer.get(ServiceIdentifier.create(ServiceIdentifier.NAMES.Auth).getValue())
    if (!authService) {
      throw new Error('Auth service not found')
    }

    const serviceResponse = (await authService.handleRequest(
      this.requestWithPayload(request, payload),
      response,
      methodIdentifier,
    )) as {
      statusCode: number
      json: Record<string, unknown>
    }

    this.sendDecoratedResponse(response, serviceResponse)
  }

  async callAuthServerWithLegacyFormat(
    _request: Request,
    response: Response,
    _methodIdentifier: string,
    _payload?: Record<string, unknown> | string,
  ): Promise<void> {
    response.status(400).send({
      error: {
        message: 'Legacy auth endpoints are no longer available.',
      },
    })
  }

  /** `payload` is forwarded as the request body -- see `callAuthServer`. */
  async callRevisionsServer(
    request: never,
    response: never,
    methodIdentifier: string,
    payload?: Record<string, unknown> | string,
  ): Promise<void> {
    const service = this.serviceContainer.get(ServiceIdentifier.create(ServiceIdentifier.NAMES.Revisions).getValue())
    if (!service) {
      throw new Error('Revisions service not found')
    }

    const serviceResponse = (await service.handleRequest(
      this.requestWithPayload(request, payload),
      response,
      methodIdentifier,
    )) as {
      statusCode: number
      json: Record<string, unknown>
    }

    this.sendDecoratedResponse(response, serviceResponse)
  }

  /**
   * `payload` is the FOURTH parameter `ServiceProxyInterface` declares, and
   * dropping it denied 100 % of collaboration on every single-container
   * deployment.
   *
   * Almost every caller of this method passes no payload, because the body the
   * syncing server should read is already on the Express request being
   * forwarded. `CollaborationAuthorizationService` is the exception: it calls
   * `POST items/collaboration-authorization` with `{ itemUuid }`, a body that
   * exists ONLY as this argument -- the request it forwards carries the
   * client's `{ noteUuid, collaborationProtocolVersion, ... }` instead, and
   * `BaseItemsController.authorizeCollaboration` reads `request.body.itemUuid`.
   * With the payload discarded that read was `undefined`, the controller FAILED
   * CLOSED to `{ authorized: false }`, and every note -- a personal note owned
   * by the caller included -- was refused a collaboration capability. No error
   * was logged anywhere, because nothing had gone wrong as far as either side
   * could tell. `ValetTokenFileResourceAuthorizer`'s shared-vault valet-token
   * mint passes a payload the same way.
   *
   * This is the single-container TWIN of the multi-container defect
   * `DirectCallRequest` was written for: there, a fabricated request carried no
   * `method`, axios defaulted it to GET, and the same check read the same
   * `{ authorized: false }`. One lane, two transports, both silently denying,
   * and `yarn build` green on both -- because the interface's optional
   * parameter is simply absent from the implementation's signature, which
   * TypeScript accepts without complaint.
   *
   * So the payload is merged in as the request body, through the same factory
   * that fixed the other half, rather than being spread onto the request (an
   * object spread drops `get`/`header`/`is`).
   */
  async callSyncingServer(
    request: never,
    response: never,
    methodIdentifier: string,
    payload?: Record<string, unknown> | string,
  ): Promise<void> {
    const service = this.serviceContainer.get(
      ServiceIdentifier.create(ServiceIdentifier.NAMES.SyncingServer).getValue(),
    )
    if (!service) {
      throw new Error('Syncing service not found')
    }

    const serviceResponse = (await service.handleRequest(
      this.requestWithPayload(request, payload),
      response,
      methodIdentifier,
    )) as {
      statusCode: number
      json: Record<string, unknown>
    }

    this.sendDecoratedResponse(response, serviceResponse)
  }

  /**
   * The request a direct-called service should see for a given payload. An
   * absent or empty payload leaves the request untouched, byte for byte, so no
   * existing caller changes behaviour; `HttpServiceProxy.getRequestData` treats
   * the same set of values as "no body" for exactly the same reason.
   */
  private requestWithPayload(request: never, payload?: Record<string, unknown> | string): never {
    if (
      payload === undefined ||
      payload === null ||
      payload === '' ||
      (typeof payload === 'object' && Object.keys(payload).length === 0)
    ) {
      return request
    }

    return createDirectCallRequest({ from: request as unknown as Request, body: payload }) as unknown as never
  }

  async callLegacySyncingServer(
    _request: Request,
    response: Response,
    _methodIdentifier: string,
    _payload?: Record<string, unknown> | string,
  ): Promise<void> {
    response.status(400).send({
      error: {
        message: 'Legacy syncing server endpoints are no longer available.',
      },
    })
  }

  async callPaymentsServer(
    _request: Request,
    response: Response,
    _methodIdentifier: string,
    _payload?: Record<string, unknown> | string,
  ): Promise<void> {
    response.status(400).send({
      error: {
        message: 'Payments server is not available.',
      },
    })
  }

  /**
   * `_payload` is declared and deliberately unread: nothing here forwards a
   * request anywhere. The connection token is minted from `response.locals`
   * against the in-process gateway, so there is no body for a caller's payload
   * to become. `WebSocketsController` passes `request.body` and the mint reads
   * none of it.
   */
  async callWebSocketServer(
    _request: Request,
    response: Response,
    methodIdentifier: string,
    _payload?: Record<string, unknown> | string,
  ): Promise<void> {
    const locals = response.locals as ResponseLocals

    // Only the connection-token endpoint is relevant to the self-hosted gateway;
    // the AWS $connect/$disconnect registration endpoints are unused because the
    // gateway's ws server manages connection lifecycle directly.
    const isTokenRequest = methodIdentifier.toLowerCase().includes('token')

    if (!isTokenRequest || !locals.user?.uuid || !locals.session?.uuid || !locals.authToken) {
      response.status(400).send({
        error: {
          message: 'Websockets server is not available.',
        },
      })
      return
    }

    let statusCode = 500
    let data: Record<string, unknown> = { error: { message: 'Could not reach the websockets gateway.' } }
    const tokenResponse: { writeHead(status: number): unknown; end(body?: string): void } = {
      writeHead: (status: number): unknown => {
        statusCode = status
        return tokenResponse
      },
      end: (body?: string): void => {
        try {
          data = body ? (JSON.parse(body) as Record<string, unknown>) : {}
        } catch {
          statusCode = 502
        }
      },
    }
    const handled = webSocketGatewayAccessService.mintConnectionToken(
      {
        headers: { 'x-auth-token': locals.authToken },
        body: { userUuid: locals.user.uuid, sessionUuid: locals.session.uuid },
      } as unknown as Request,
      tokenResponse as never,
    )
    if (!handled) {
      response.status(503).send({ error: { message: 'Websockets server is not available.' } })
      return
    }
    this.sendDecoratedResponse(response, { statusCode, json: data })
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
