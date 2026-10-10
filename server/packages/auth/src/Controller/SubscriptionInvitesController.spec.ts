import 'reflect-metadata'

import { SubscriptionInvitesController } from './SubscriptionInvitesController'
import { User } from '../Domain/User/User'
import { InviteToSharedSubscription } from '../Domain/UseCase/InviteToSharedSubscription/InviteToSharedSubscription'
import { AcceptSharedSubscriptionInvitation } from '../Domain/UseCase/AcceptSharedSubscriptionInvitation/AcceptSharedSubscriptionInvitation'
import { DeclineSharedSubscriptionInvitation } from '../Domain/UseCase/DeclineSharedSubscriptionInvitation/DeclineSharedSubscriptionInvitation'
import { CancelSharedSubscriptionInvitation } from '../Domain/UseCase/CancelSharedSubscriptionInvitation/CancelSharedSubscriptionInvitation'
import { ListSharedSubscriptionInvitations } from '../Domain/UseCase/ListSharedSubscriptionInvitations/ListSharedSubscriptionInvitations'
import { ApiVersion } from '../Domain/Api/ApiVersion'

describe('SubscriptionInvitesController', () => {
  let inviteToSharedSubscription: InviteToSharedSubscription
  let acceptSharedSubscriptionInvitation: AcceptSharedSubscriptionInvitation
  let declineSharedSubscriptionInvitation: DeclineSharedSubscriptionInvitation
  let cancelSharedSubscriptionInvitation: CancelSharedSubscriptionInvitation
  let listSharedSubscriptionInvitations: ListSharedSubscriptionInvitations

  let user: User

  const createController = () =>
    new SubscriptionInvitesController(
      inviteToSharedSubscription,
      acceptSharedSubscriptionInvitation,
      declineSharedSubscriptionInvitation,
      cancelSharedSubscriptionInvitation,
      listSharedSubscriptionInvitations,
    )

  beforeEach(() => {
    user = {} as jest.Mocked<User>
    user.uuid = '123'
    user.email = 'test@test.te'

    inviteToSharedSubscription = {} as jest.Mocked<InviteToSharedSubscription>
    inviteToSharedSubscription.execute = jest.fn()

    acceptSharedSubscriptionInvitation = {} as jest.Mocked<AcceptSharedSubscriptionInvitation>
    acceptSharedSubscriptionInvitation.execute = jest.fn()

    declineSharedSubscriptionInvitation = {} as jest.Mocked<DeclineSharedSubscriptionInvitation>
    declineSharedSubscriptionInvitation.execute = jest.fn()

    cancelSharedSubscriptionInvitation = {} as jest.Mocked<CancelSharedSubscriptionInvitation>
    cancelSharedSubscriptionInvitation.execute = jest.fn()

    listSharedSubscriptionInvitations = {} as jest.Mocked<ListSharedSubscriptionInvitations>
    listSharedSubscriptionInvitations.execute = jest.fn()
  })

  it('should get invitations to subscription sharing', async () => {
    listSharedSubscriptionInvitations.execute = jest.fn().mockReturnValue({
      invitations: [],
    })

    const result = await createController().listInvites({
      api: ApiVersion.VERSIONS.v20200115,
      inviterEmail: 'test@test.te',
    })

    expect(listSharedSubscriptionInvitations.execute).toHaveBeenCalledWith({
      inviterEmail: 'test@test.te',
    })

    expect(result.status).toEqual(200)
  })

  it('should cancel invitation to subscription sharing', async () => {
    cancelSharedSubscriptionInvitation.execute = jest.fn().mockReturnValue({
      success: true,
    })

    const result = await createController().cancelInvite({
      api: ApiVersion.VERSIONS.v20200115,
      inviteUuid: '1-2-3',
      inviterEmail: 'test@test.te',
    })

    expect(cancelSharedSubscriptionInvitation.execute).toHaveBeenCalledWith({
      sharedSubscriptionInvitationUuid: '1-2-3',
      inviterEmail: 'test@test.te',
    })

    expect(result.status).toEqual(200)
  })

  it('should not cancel invitation to subscription sharing if the workflow fails', async () => {
    cancelSharedSubscriptionInvitation.execute = jest.fn().mockReturnValue({
      success: false,
    })

    const result = await createController().cancelInvite({
      api: ApiVersion.VERSIONS.v20200115,
      inviteUuid: '1-2-3',
    })

    expect(result.status).toEqual(400)
  })

  it('should decline invitation to subscription sharing', async () => {
    declineSharedSubscriptionInvitation.execute = jest.fn().mockReturnValue({
      success: true,
    })

    const result = await createController().declineInvite({
      api: ApiVersion.VERSIONS.v20200115,
      inviteUuid: '1-2-3',
    })

    expect(declineSharedSubscriptionInvitation.execute).toHaveBeenCalledWith({
      sharedSubscriptionInvitationUuid: '1-2-3',
    })

    expect(result.status).toEqual(200)
  })

  it('should not decline invitation to subscription sharing if the workflow fails', async () => {
    declineSharedSubscriptionInvitation.execute = jest.fn().mockReturnValue({
      success: false,
    })

    const result = await createController().declineInvite({
      api: ApiVersion.VERSIONS.v20200115,
      inviteUuid: '1-2-3',
    })

    expect(declineSharedSubscriptionInvitation.execute).toHaveBeenCalledWith({
      sharedSubscriptionInvitationUuid: '1-2-3',
    })

    expect(result.status).toEqual(400)
  })

  it('should accept invitation to subscription sharing', async () => {
    acceptSharedSubscriptionInvitation.execute = jest.fn().mockReturnValue({
      success: true,
    })

    const result = await createController().acceptInvite({
      api: ApiVersion.VERSIONS.v20200115,
      inviteUuid: '1-2-3',
    })

    expect(acceptSharedSubscriptionInvitation.execute).toHaveBeenCalledWith({
      sharedSubscriptionInvitationUuid: '1-2-3',
    })

    expect(result.status).toEqual(200)
  })

  it('should not accept invitation to subscription sharing if the workflow fails', async () => {
    acceptSharedSubscriptionInvitation.execute = jest.fn().mockReturnValue({
      success: false,
    })

    const result = await createController().acceptInvite({
      api: ApiVersion.VERSIONS.v20200115,
      inviteUuid: '1-2-3',
    })

    expect(acceptSharedSubscriptionInvitation.execute).toHaveBeenCalledWith({
      sharedSubscriptionInvitationUuid: '1-2-3',
    })

    expect(result.status).toEqual(400)
  })

  it('should invite to user subscription', async () => {
    inviteToSharedSubscription.execute = jest.fn().mockReturnValue({
      success: true,
    })

    const result = await createController().invite({
      api: ApiVersion.VERSIONS.v20200115,
      identifier: 'invitee@test.te',
      inviterUuid: '1-2-3',
      inviterEmail: 'test@test.te',
      inviterRoles: ['CORE_USER'],
    })

    expect(inviteToSharedSubscription.execute).toHaveBeenCalledWith({
      inviterEmail: 'test@test.te',
      inviterUuid: '1-2-3',
      inviteeIdentifier: 'invitee@test.te',
      inviterRoles: ['CORE_USER'],
    })

    expect(result.status).toEqual(200)
  })

  it('should not invite to user subscription if the identifier is missing in request', async () => {
    const result = await createController().invite({
      api: ApiVersion.VERSIONS.v20200115,
      identifier: '',
      inviterUuid: '1-2-3',
      inviterEmail: 'test@test.te',
      inviterRoles: ['CORE_USER'],
    })

    expect(inviteToSharedSubscription.execute).not.toHaveBeenCalled()

    expect(result.status).toEqual(400)
  })

  it('should not invite to user subscription if the workflow does not run', async () => {
    inviteToSharedSubscription.execute = jest.fn().mockReturnValue({
      success: false,
      refusal: 'no-shareable-subscription',
    })

    const result = await createController().invite({
      api: ApiVersion.VERSIONS.v20200115,
      identifier: 'invitee@test.te',
      inviterUuid: '1-2-3',
      inviterEmail: 'test@test.te',
      inviterRoles: ['CORE_USER'],
    })

    expect(result.status).toEqual(400)
  })

  it('tells the caller WHY an invite was refused, and tells the five refusals apart', async () => {
    // This route answered `400 {"success": false}` to all five refusals. On
    // both shipped topologies that single answer covered the one refusal every
    // account gets (no `user_subscriptions` row under the default entitlement
    // mode), so the feature read as mysteriously broken. Each refusal must now
    // carry its own message, and `success: false` must survive beside it
    // because that is the field the client reads.
    const messages = new Set<string>()
    for (const refusal of [
      'not-entitled',
      'no-shareable-subscription',
      'subscription-already-shared',
      'invite-limit-reached',
      'already-invited',
    ] as const) {
      inviteToSharedSubscription.execute = jest.fn().mockReturnValue({ success: false, refusal })

      const result = await createController().invite({
        api: ApiVersion.VERSIONS.v20200115,
        identifier: 'invitee@test.te',
        inviterUuid: '1-2-3',
        inviterEmail: 'test@test.te',
        inviterRoles: ['CORE_USER'],
      })

      expect(result.status).toEqual(400)
      const data = result.data as { success: boolean; error?: { message?: string } }
      expect(data.success).toBe(false)
      expect(typeof data.error?.message).toBe('string')
      expect(data.error?.message?.length).toBeGreaterThan(0)
      // No identifier, address or count may leak into an invite refusal.
      expect(data.error?.message).not.toContain('invitee@test.te')
      expect(data.error?.message).not.toContain('test@test.te')
      expect(data.error?.message).not.toContain('1-2-3')
      messages.add(data.error?.message as string)
    }
    // Five DISTINCT messages: a shared sentence would put us back where we
    // started with a different amount of text.
    expect(messages.size).toBe(5)
  })

  it('surfaces the no-subscription refusal as its own sentence, not the entitlement one', async () => {
    inviteToSharedSubscription.execute = jest.fn().mockReturnValue({
      success: false,
      refusal: 'no-shareable-subscription',
    })

    const result = await createController().invite({
      api: ApiVersion.VERSIONS.v20200115,
      identifier: 'invitee@test.te',
      inviterUuid: '1-2-3',
      inviterEmail: 'test@test.te',
      inviterRoles: ['PRO_USER'],
    })

    expect(result.status).toEqual(400)
    expect((result.data as { error?: { message?: string } }).error?.message).toContain('no subscription to share')
  })
})
