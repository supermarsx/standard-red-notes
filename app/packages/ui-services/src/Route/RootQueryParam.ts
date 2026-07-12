export enum RootQueryParam {
  Purchase = 'purchase',
  Settings = 'settings',
  DemoToken = 'demo-token',
  AcceptSubscriptionInvite = 'accept-subscription-invite',
  UserRequest = 'user-request',
  AppViewRoute = 'route',
  Shared = 'shared',
  EmailConfirmation = 'email_confirmation',
  // Standard Red Notes: INVITE-URL signup control. `?invite=<token>` carries a
  // unique invite-link token captured at launch and threaded into registration.
  Invite = 'invite',
}
