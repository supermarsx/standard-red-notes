import { SessionEvent } from './../Session/SessionEvent'
import { StorageKey } from './../Storage/StorageKeys'
import { ApplicationStage } from './../Application/ApplicationStage'
import { StorageServiceInterface } from './../Storage/StorageServiceInterface'
import { InternalEventInterface } from './../Internal/InternalEventInterface'
import { SessionsClientInterface } from './../Session/SessionsClientInterface'
import { SubscriptionName } from '@standardnotes/common'
import { convertTimestampToMilliseconds } from '@standardnotes/utils'
import { ApplicationEvent } from './../Event/ApplicationEvent'
import { InternalEventHandlerInterface } from './../Internal/InternalEventHandlerInterface'
import { Invitation } from '@standardnotes/models'
import { SubscriptionApiServiceInterface } from '@standardnotes/api'
import { InternalEventBusInterface } from '../Internal/InternalEventBusInterface'
import { AbstractService } from '../Service/AbstractService'
import { SubscriptionManagerInterface } from './SubscriptionManagerInterface'
import { AppleIAPReceipt } from './AppleIAPReceipt'
import {
  AvailableSubscriptions,
  getErrorFromErrorResponse,
  isErrorResponse,
  Subscription,
} from '@standardnotes/responses'
import { SubscriptionManagerEvent } from './SubscriptionManagerEvent'
import { ApplicationStageChangedEventPayload } from '../Event/ApplicationStageChangedEventPayload'
import { IsApplicationUsingThirdPartyHost } from '../UseCase/IsApplicationUsingThirdPartyHost'
import { InviteRealtimeEvent } from '../Invite/InviteRealtimeEvent'
import { InviteRealtimeHandlerContext } from '../Invite/InviteRealtimeEventConsumer'

export class SubscriptionManager
  extends AbstractService<SubscriptionManagerEvent>
  implements SubscriptionManagerInterface, InternalEventHandlerInterface
{
  private onlineSubscription?: Subscription
  private availableSubscriptions?: AvailableSubscriptions | undefined
  private subscriptionInvitations?: Invitation[]

  constructor(
    private subscriptionApiService: SubscriptionApiServiceInterface,
    private sessions: SessionsClientInterface,
    private storage: StorageServiceInterface,
    private isApplicationUsingThirdPartyHostUseCase: IsApplicationUsingThirdPartyHost,
    protected override internalEventBus: InternalEventBusInterface,
  ) {
    super(internalEventBus)
  }

  async handleEvent(event: InternalEventInterface): Promise<void> {
    switch (event.type) {
      case ApplicationEvent.Launched: {
        void this.fetchOnlineSubscription()

        const isThirdPartyHostUsedOrError = this.isApplicationUsingThirdPartyHostUseCase.execute()
        if (isThirdPartyHostUsedOrError.isFailed()) {
          break
        }
        const isThirdPartyHostUsed = isThirdPartyHostUsedOrError.getValue()
        if (!isThirdPartyHostUsed) {
          void this.fetchAvailableSubscriptions()
        }
        break
      }

      case ApplicationEvent.UserRolesChanged:
      case SessionEvent.Restored:
      case ApplicationEvent.SignedIn:
        void this.fetchOnlineSubscription()
        break

      case ApplicationEvent.ApplicationStageChanged: {
        const stage = (event.payload as ApplicationStageChangedEventPayload).stage
        if (stage === ApplicationStage.StorageDecrypted_09) {
          this.loadSubscriptionFromStorage()
        }
      }
    }
  }

  loadSubscriptionFromStorage(): void {
    this.onlineSubscription = this.storage.getValue(StorageKey.Subscription)
    void this.notifyEvent(SubscriptionManagerEvent.DidFetchSubscription)
  }

  hasOnlineSubscription(): boolean {
    return this.onlineSubscription != undefined
  }

  getOnlineSubscription(): Subscription | undefined {
    return this.onlineSubscription
  }

  getAvailableSubscriptions(): AvailableSubscriptions | undefined {
    return this.availableSubscriptions
  }

  get userSubscriptionName(): string {
    if (!this.onlineSubscription) {
      throw new Error('Attempting to get subscription name without a subscription.')
    }

    if (
      this.availableSubscriptions &&
      this.availableSubscriptions[this.onlineSubscription.planName as SubscriptionName]
    ) {
      return this.availableSubscriptions[this.onlineSubscription.planName as SubscriptionName].name
    }

    return ''
  }

  get userSubscriptionExpirationDate(): Date | undefined {
    if (!this.onlineSubscription) {
      return undefined
    }

    return new Date(convertTimestampToMilliseconds(this.onlineSubscription.endsAt))
  }

  get isUserSubscriptionExpired(): boolean {
    if (!this.onlineSubscription) {
      throw new Error('Attempting to check subscription expiration without a subscription.')
    }

    if (!this.userSubscriptionExpirationDate) {
      return false
    }

    return this.userSubscriptionExpirationDate.getTime() < new Date().getTime()
  }

  get isUserSubscriptionCanceled(): boolean {
    if (!this.onlineSubscription) {
      throw new Error('Attempting to check subscription expiration without a subscription.')
    }

    return this.onlineSubscription.cancelled
  }

  async acceptInvitation(inviteUuid: string): Promise<{ success: true } | { success: false; message: string }> {
    try {
      const result = await this.subscriptionApiService.acceptInvite(inviteUuid)

      if (isErrorResponse(result)) {
        return { success: false, message: getErrorFromErrorResponse(result).message }
      }

      return result.data
    } catch {
      return { success: false, message: 'Could not accept invitation.' }
    }
  }

  async listSubscriptionInvitations(): Promise<Invitation[]> {
    try {
      const invitations = await this.requestSubscriptionInvitations()
      this.subscriptionInvitations = invitations
      return invitations
    } catch {
      return []
    }
  }

  getCachedSubscriptionInvitations(): Invitation[] | undefined {
    return this.subscriptionInvitations ? [...this.subscriptionInvitations] : undefined
  }

  async handleInviteRealtimeEvents(
    events: readonly InviteRealtimeEvent[],
    context?: InviteRealtimeHandlerContext,
  ): Promise<void> {
    const subscriptionEvents = events.filter((event) => event.kind === 'subscription-invite')
    if (subscriptionEvents.length === 0) {
      return
    }
    if (!this.sessions.isSignedIn()) {
      throw new Error('Cannot reconcile subscription invitations without an authenticated session.')
    }
    context?.assertCurrent()
    const userUuid = this.sessions.userUuid

    const invitations = await this.requestSubscriptionInvitations()
    const shouldRefreshSubscription = subscriptionEvents.some(
      (event) => event.action === 'accepted' || event.action === 'canceled',
    )
    const subscription = shouldRefreshSubscription ? await this.requestOnlineSubscription(userUuid) : undefined

    this.assertRealtimeSession(userUuid, context)
    this.subscriptionInvitations = invitations
    if (shouldRefreshSubscription) {
      this.handleReceivedOnlineSubscriptionFromServer(subscription)
    }
    await this.notifyEvent(SubscriptionManagerEvent.DidChangeInvitations)
  }

  async inviteToSubscription(inviteeEmail: string): Promise<boolean> {
    try {
      const result = await this.subscriptionApiService.invite(inviteeEmail)

      if (isErrorResponse(result)) {
        return false
      }

      return result.data.success === true
    } catch {
      return false
    }
  }

  async cancelInvitation(inviteUuid: string): Promise<boolean> {
    try {
      const result = await this.subscriptionApiService.cancelInvite(inviteUuid)

      if (isErrorResponse(result)) {
        return false
      }

      return result.data.success === true
    } catch {
      return false
    }
  }

  public async fetchOnlineSubscription(): Promise<void> {
    if (!this.sessions.isSignedIn()) {
      return
    }

    try {
      const subscription = await this.requestOnlineSubscription(this.sessions.userUuid)
      this.handleReceivedOnlineSubscriptionFromServer(subscription)
    } catch (error) {
      void error
    }
  }

  private async requestSubscriptionInvitations(): Promise<Invitation[]> {
    const result = await this.subscriptionApiService.listInvites()
    if (isErrorResponse(result)) {
      throw new Error('Could not reconcile subscription invitations after a realtime invalidation.')
    }
    return result.data.invitations ?? []
  }

  private async requestOnlineSubscription(userUuid: string): Promise<Subscription | undefined> {
    const result = await this.subscriptionApiService.getUserSubscription({ userUuid })
    if (isErrorResponse(result)) {
      throw new Error('Could not reconcile subscription entitlements after a realtime invalidation.')
    }
    return result.data.subscription
  }

  private assertRealtimeSession(userUuid: string, context?: InviteRealtimeHandlerContext): void {
    context?.assertCurrent()
    if (!this.sessions.isSignedIn() || this.sessions.userUuid !== userUuid) {
      throw new Error('Subscription invitation session changed during authoritative reload.')
    }
  }

  private handleReceivedOnlineSubscriptionFromServer(subscription: Subscription | undefined): void {
    this.onlineSubscription = subscription

    this.storage.setValue(StorageKey.Subscription, subscription)

    void this.notifyEvent(SubscriptionManagerEvent.DidFetchSubscription)
  }

  async fetchAvailableSubscriptions(): Promise<void> {
    try {
      const response = await this.subscriptionApiService.getAvailableSubscriptions()

      if (isErrorResponse(response)) {
        return
      }

      this.availableSubscriptions = response.data
    } catch (error) {
      void error
    }
  }

  async confirmAppleIAP(
    params: AppleIAPReceipt,
    subscriptionToken: string,
  ): Promise<{ success: true } | { success: false; message: string }> {
    try {
      const result = await this.subscriptionApiService.confirmAppleIAP({
        ...params,
        subscription_token: subscriptionToken,
      })

      if (isErrorResponse(result)) {
        return { success: false, message: getErrorFromErrorResponse(result).message }
      }

      return result.data
    } catch {
      return { success: false, message: 'Could not confirm IAP.' }
    }
  }
}
