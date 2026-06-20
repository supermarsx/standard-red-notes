export enum WebSocketsServiceEvent {
  UserRoleMessageReceived = 'WebSocketMessageReceived',
  NotificationAddedForUser = 'NotificationAddedForUser',
  MessageSentToUser = 'MessageSentToUser',
  UserInvitedToSharedVault = 'UserInvitedToSharedVault',
  ItemsChangedOnServer = 'ItemsChangedOnServer',
  // Standard Red Notes (Phase 1A): the server pushed the changed encrypted item
  // payloads + the new sync token over the socket. The client may apply them
  // directly (no HTTP pull) when its current token matches the push's base token,
  // and otherwise discards the push and falls back to a normal HTTP sync.
  SyncItemsPushed = 'SyncItemsPushed',
  // Emitted when the websocket (re)connects. The sync service performs a full
  // HTTP sync on this event to backfill anything missed while disconnected.
  WebSocketDidOpen = 'WebSocketDidOpen',
  // Standard Red Notes: push-MFA. Emitted on a trusted session when an untrusted
  // device starts a sign-in that needs 2FA, so the UI can prompt the user to
  // approve or deny the sign-in.
  MfaApprovalRequested = 'MfaApprovalRequested',
}
