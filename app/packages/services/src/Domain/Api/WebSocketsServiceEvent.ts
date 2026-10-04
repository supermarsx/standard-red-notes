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
  // Emitted when the legacy push/collaboration websocket (re)connects. Sync
  // resume is owned by the dedicated worker and does not blindly HTTP-backfill.
  WebSocketDidOpen = 'WebSocketDidOpen',
  // Emitted on every close so encrypted realtime consumers can synchronously
  // tear down room keys/providers and fall back to ordinary note persistence.
  WebSocketDidClose = 'WebSocketDidClose',
  // Standard Red Notes: push-MFA. Emitted on a trusted session when an untrusted
  // device starts a sign-in that needs 2FA, so the UI can prompt the user to
  // approve or deny the sign-in.
  MfaApprovalRequested = 'MfaApprovalRequested',
  // Standard Red Notes: push-MFA. The mirror of the above — emitted on every one of
  // the account's sessions once SOME trusted session has approved or denied the
  // request, so an inbox that is still showing it can drop the row (and a toast
  // raised for it can be dismissed) without re-GETting the inbox over HTTP.
  MfaApprovalResolved = 'MfaApprovalResolved',
}
