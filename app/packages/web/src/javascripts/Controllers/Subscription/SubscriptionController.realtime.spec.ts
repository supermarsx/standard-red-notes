import {
  FeaturesClientInterface,
  InternalEventBusInterface,
  Invitation,
  SessionsClientInterface,
  SubscriptionManagerEvent,
  SubscriptionManagerInterface,
} from '@standardnotes/snjs'

import { SubscriptionController } from './SubscriptionController'

describe('SubscriptionController realtime invitations', () => {
  it('registers for invitation changes and replaces the visible invitation list', async () => {
    const invitation = { uuid: 'invite-1' } as Invitation
    const subscriptions = {
      listSubscriptionInvitations: jest.fn(),
      getCachedSubscriptionInvitations: jest.fn().mockReturnValue([invitation]),
      getOnlineSubscription: jest.fn(),
    } as unknown as jest.Mocked<SubscriptionManagerInterface>
    const sessions = {
      isSignedIn: jest.fn().mockReturnValue(true),
    } as unknown as jest.Mocked<SessionsClientInterface>
    const features = {} as jest.Mocked<FeaturesClientInterface>
    const eventBus = {
      addEventHandler: jest.fn(),
      publish: jest.fn(),
      publishSync: jest.fn(),
    } as unknown as jest.Mocked<InternalEventBusInterface>
    const controller = new SubscriptionController(subscriptions, sessions, features, eventBus)

    expect(eventBus.addEventHandler).toHaveBeenCalledWith(controller, SubscriptionManagerEvent.DidChangeInvitations)

    await controller.handleEvent({ type: SubscriptionManagerEvent.DidChangeInvitations, payload: undefined })

    expect(subscriptions.listSubscriptionInvitations).not.toHaveBeenCalled()
    expect(controller.subscriptionInvitations).toEqual([invitation])
  })
})
