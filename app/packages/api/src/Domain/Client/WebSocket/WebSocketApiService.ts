import { ErrorMessage } from '../../Error/ErrorMessage'
import { ApiCallError } from '../../Error/ApiCallError'

import { WebSocketApiServiceInterface } from './WebSocketApiServiceInterface'
import { WebSocketApiOperations } from './WebSocketApiOperations'
import { WebSocketServerInterface } from '../../Server'
import { HttpResponse } from '@standardnotes/responses'
import { WebSocketConnectionTokenResponseBody, CollaborationAuthorizationResponseBody } from '../../Response'

export class WebSocketApiService implements WebSocketApiServiceInterface {
  private operationsInProgress: Map<WebSocketApiOperations, boolean>
  private collaborationAuthorizations = new Map<string, Promise<HttpResponse<CollaborationAuthorizationResponseBody>>>()

  constructor(private webSocketServer: WebSocketServerInterface) {
    this.operationsInProgress = new Map()
  }

  async createConnectionToken(): Promise<HttpResponse<WebSocketConnectionTokenResponseBody>> {
    if (this.operationsInProgress.get(WebSocketApiOperations.CreatingConnectionToken)) {
      throw new ApiCallError(ErrorMessage.GenericInProgress)
    }

    this.operationsInProgress.set(WebSocketApiOperations.CreatingConnectionToken, true)

    try {
      const response = await this.webSocketServer.createConnectionToken({})

      this.operationsInProgress.set(WebSocketApiOperations.CreatingConnectionToken, false)

      return response
    } catch {
      throw new ApiCallError(ErrorMessage.GenericFail)
    }
  }

  async authorizeCollaboration(
    noteUuid: string,
    leaseRequestId?: string,
    bootstrapChallenge?: string,
    expectedRoomEpoch?: string,
  ): Promise<HttpResponse<CollaborationAuthorizationResponseBody>> {
    if (!isValidCollaborationEpoch(expectedRoomEpoch)) {
      throw new ApiCallError(ErrorMessage.GenericFail)
    }
    const authorizationKey = JSON.stringify([
      'grant',
      noteUuid,
      leaseRequestId ?? null,
      bootstrapChallenge ?? null,
      expectedRoomEpoch,
    ])
    const existing = this.collaborationAuthorizations.get(authorizationKey)
    if (existing) {
      return existing
    }

    // Multiple open editors reauthorize together after one socket reconnect.
    // Coalesce duplicate requests for the same note, but allow different notes
    // to authorize concurrently; a single global lock would strand every editor
    // except the first until another reconnect happened.
    const request = this.webSocketServer
      .authorizeCollaboration({
        noteUuid,
        collaborationProtocolVersion: 3,
        epochDiscovery: false,
        expectedRoomEpoch,
        ...(leaseRequestId ? { leaseRequestId } : {}),
        ...(bootstrapChallenge ? { bootstrapChallenge } : {}),
      })
      .catch(() => {
        throw new ApiCallError(ErrorMessage.GenericFail)
      })
      .finally(() => {
        this.collaborationAuthorizations.delete(authorizationKey)
      })
    this.collaborationAuthorizations.set(authorizationKey, request)
    return request
  }

  async discoverCollaborationRoomEpoch(
    noteUuid: string,
  ): Promise<HttpResponse<CollaborationAuthorizationResponseBody>> {
    const authorizationKey = JSON.stringify(['discovery', noteUuid])
    const existing = this.collaborationAuthorizations.get(authorizationKey)
    if (existing) {
      return existing
    }
    const request = this.webSocketServer
      .authorizeCollaboration({
        noteUuid,
        collaborationProtocolVersion: 3,
        epochDiscovery: true,
      })
      .catch(() => {
        throw new ApiCallError(ErrorMessage.GenericFail)
      })
      .finally(() => this.collaborationAuthorizations.delete(authorizationKey))
    this.collaborationAuthorizations.set(authorizationKey, request)
    return request
  }
}

function isValidCollaborationEpoch(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value)
}
