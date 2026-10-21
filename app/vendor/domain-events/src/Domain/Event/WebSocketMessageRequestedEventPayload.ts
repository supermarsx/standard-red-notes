export interface WebSocketMessageRequestedEventPayload {
  userUuid: string
  message: string
  originatingSessionUuid?: string
}
