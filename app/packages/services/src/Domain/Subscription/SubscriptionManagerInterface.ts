import { ApplicationServiceInterface } from './../Service/ApplicationServiceInterface'
import { Invitation } from '@standardnotes/models'
import { AppleIAPReceipt } from './AppleIAPReceipt'
import { AvailableSubscriptions, Subscription } from '@standardnotes/responses'
import { SubscriptionManagerEvent } from './SubscriptionManagerEvent'
import { InviteRealtimeEvent } from '../Invite/InviteRealtimeEvent'
import { InviteRealtimeHandlerContext } from '../Invite/InviteRealtimeEventConsumer'

export interface SubscriptionManagerInterface extends ApplicationServiceInterface<SubscriptionManagerEvent, unknown> {
  getOnlineSubscription(): Subscription | undefined
  getAvailableSubscriptions(): AvailableSubscriptions | undefined
  hasOnlineSubscription(): boolean

  get userSubscriptionName(): string
  get userSubscriptionExpirationDate(): Date | undefined
  get isUserSubscriptionExpired(): boolean
  get isUserSubscriptionCanceled(): boolean

  fetchOnlineSubscription(): Promise<void>
  listSubscriptionInvitations(): Promise<Invitation[]>
  getCachedSubscriptionInvitations(): Invitation[] | undefined
  inviteToSubscription(inviteeEmail: string): Promise<boolean>
  cancelInvitation(inviteUuid: string): Promise<boolean>
  acceptInvitation(inviteUuid: string): Promise<{ success: true } | { success: false; message: string }>
  handleInviteRealtimeEvents(
    events: readonly InviteRealtimeEvent[],
    context?: InviteRealtimeHandlerContext,
  ): Promise<void>
  confirmAppleIAP(
    receipt: AppleIAPReceipt,
    subscriptionToken: string,
  ): Promise<{ success: true } | { success: false; message: string }>
}
