import { AuthResponseCreationResult } from '../Auth/AuthResponseCreationResult'

export type RegisterResponse =
  | {
      success: true
      result: AuthResponseCreationResult
    }
  | {
      // Standard Red Notes: APPROVAL QUEUE. When approvalRequired is ON and the
      // new user is created pending, Register returns this terminal response
      // instead of a live session — the controller returns a 200 with a
      // `pendingApproval` flag and NO Set-Cookie, and the web UI shows "awaiting
      // approval" instead of signing in.
      success: true
      pendingApproval: true
    }
  | {
      success: false
      errorMessage: string
    }
