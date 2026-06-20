export enum WebSocketsServiceEvent {
  UserRoleMessageReceived = 'WebSocketMessageReceived',
  NotificationAddedForUser = 'NotificationAddedForUser',
  MessageSentToUser = 'MessageSentToUser',
  UserInvitedToSharedVault = 'UserInvitedToSharedVault',
  ItemsChangedOnServer = 'ItemsChangedOnServer',
  // Standard Red Notes: push-MFA. Emitted on a trusted session when an untrusted
  // device starts a sign-in that needs 2FA, so the UI can prompt the user to
  // approve or deny the sign-in.
  MfaApprovalRequested = 'MfaApprovalRequested',
}
