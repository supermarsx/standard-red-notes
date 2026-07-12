import { SignupInviteUse } from './SignupInviteUse'

export interface SignupInviteUseRepositoryInterface {
  save(use: SignupInviteUse): Promise<void>
  /** How many signups a given referrer has driven (their "invited N people"). */
  countByReferrer(referrerUserUuid: string): Promise<number>
  /** How many signups a given link produced (usage audit). */
  countByLink(inviteLinkUuid: string): Promise<number>
}
