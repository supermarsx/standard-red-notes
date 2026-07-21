import { SharedSubscriptionInvitationCreatedEvent } from '@standardnotes/domain-events'
import { Result } from '@standardnotes/domain-core'

import { InviteeIdentifierType } from '../SharedSubscription/InviteeIdentifierType'
import { AcceptSharedSubscriptionInvitation } from '../UseCase/AcceptSharedSubscriptionInvitation/AcceptSharedSubscriptionInvitation'

import { SharedSubscriptionInvitationCreatedEventHandler } from './SharedSubscriptionInvitationCreatedEventHandler'

describe('SharedSubscriptionInvitationCreatedEventHandler', () => {
  let acceptSharedSubscriptionInvitation: AcceptSharedSubscriptionInvitation

  const sharedSubscriptionInvitationUuid = '00000000-0000-0000-0000-000000000000'

  const eventWith = (inviteeIdentifierType: string) =>
    ({
      payload: { sharedSubscriptionInvitationUuid, inviteeIdentifierType },
    }) as unknown as jest.Mocked<SharedSubscriptionInvitationCreatedEvent>

  const createHandler = () => new SharedSubscriptionInvitationCreatedEventHandler(acceptSharedSubscriptionInvitation)

  beforeEach(() => {
    acceptSharedSubscriptionInvitation = {} as jest.Mocked<AcceptSharedSubscriptionInvitation>
    acceptSharedSubscriptionInvitation.execute = jest.fn().mockResolvedValue(Result.ok('accepted'))
  })

  it('should auto-accept an invitation addressed by hash', async () => {
    await createHandler().handle(eventWith(InviteeIdentifierType.Hash))

    expect(acceptSharedSubscriptionInvitation.execute).toHaveBeenCalledWith({ sharedSubscriptionInvitationUuid })
  })

  it('should leave an email-addressed invitation for the invitee to accept', async () => {
    await createHandler().handle(eventWith(InviteeIdentifierType.Email))

    expect(acceptSharedSubscriptionInvitation.execute).not.toHaveBeenCalled()
  })
})
