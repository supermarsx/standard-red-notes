// Standard Red Notes: INVITE-URL signup control. Parsed shape of a launch that
// carried `?invite=<token>` — the raw invite-link token threaded into register.
export type InviteParams = {
  token: string
}
