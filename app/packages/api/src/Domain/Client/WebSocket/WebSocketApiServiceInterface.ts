import { HttpResponse } from '@standardnotes/responses'
import { WebSocketConnectionTokenResponseBody, CollaborationAuthorizationResponseBody } from '../../Response'

export interface WebSocketApiServiceInterface {
  createConnectionToken(): Promise<HttpResponse<WebSocketConnectionTokenResponseBody>>
  authorizeCollaboration(
    noteUuid: string,
    leaseRequestId?: string,
    bootstrapChallenge?: string,
  ): Promise<HttpResponse<CollaborationAuthorizationResponseBody>>
}
