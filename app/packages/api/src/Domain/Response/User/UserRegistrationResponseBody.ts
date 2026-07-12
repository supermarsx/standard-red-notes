import { KeyParamsData, SessionBody } from '@standardnotes/responses'

export type UserRegistrationResponseBody = {
  session: SessionBody
  key_params: KeyParamsData
  user: {
    uuid: string
    email: string
  }
  /**
   * Standard Red Notes: APPROVAL / waitlist queue. When approval mode is on the
   * server creates the account in a pending (access-blocked) state and returns
   * this terminal response INSTEAD of a live session — `pendingApproval: true`
   * with no `session`/`key_params`/`user`. The client shows an "awaiting approval"
   * message rather than signing in. Absent (the default) means a normal signup
   * that DID return a session.
   */
  pendingApproval?: boolean
}
