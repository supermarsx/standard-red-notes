import 'reflect-metadata'

import { TimerInterface } from '@standardnotes/time'

import { SharedSubscriptionInvitation } from '../../SharedSubscription/SharedSubscriptionInvitation'
import { SharedSubscriptionInvitationRepositoryInterface } from '../../SharedSubscription/SharedSubscriptionInvitationRepositoryInterface'

import { DeclineSharedSubscriptionInvitation } from './DeclineSharedSubscriptionInvitation'
import { AuthInviteMutationTransactionRunner } from '../../Invite/AuthInviteMutationTransactionRunner'
import { AuthInviteRealtimeOutboxProducer } from '../../Invite/AuthInviteRealtimeOutboxProducer'
import { AuthInviteAffectedUserResolver } from '../../Invite/AuthInviteAffectedUserResolver'

describe('DeclineSharedSubscriptionInvitation', () => {
  let sharedSubscriptionInvitationRepository: SharedSubscriptionInvitationRepositoryInterface
  let timer: TimerInterface
  let invitation: SharedSubscriptionInvitation

  const createUseCase = (
    runner?: AuthInviteMutationTransactionRunner,
    producer?: AuthInviteRealtimeOutboxProducer,
    resolver?: AuthInviteAffectedUserResolver,
  ) =>
    new DeclineSharedSubscriptionInvitation(
      sharedSubscriptionInvitationRepository,
      timer,
      runner,
      producer,
      resolver,
    )

  // In production the container always supplies the runner, so this — not the bare
  // path the other cases exercise — is how the use case actually executes.
  const recordingRunner = () => {
    const commits: boolean[] = []
    const runner = {
      execute: jest.fn(async (operation: () => Promise<{ success: boolean }>, succeeded) => {
        const result = await operation()
        commits.push(succeeded(result))
        return result
      }),
    }
    return { runner: runner as unknown as AuthInviteMutationTransactionRunner, commits, spy: runner.execute }
  }

  beforeEach(() => {
    invitation = {
      subscriptionId: 3,
    } as jest.Mocked<SharedSubscriptionInvitation>

    sharedSubscriptionInvitationRepository = {} as jest.Mocked<SharedSubscriptionInvitationRepositoryInterface>
    sharedSubscriptionInvitationRepository.findOneByUuidAndStatus = jest.fn().mockReturnValue(invitation)
    sharedSubscriptionInvitationRepository.save = jest.fn()

    timer = {} as jest.Mocked<TimerInterface>
    timer.getTimestampInMicroseconds = jest.fn().mockReturnValue(1)
  })

  it('should decline the invitation', async () => {
    expect(
      await createUseCase().execute({
        sharedSubscriptionInvitationUuid: '1-2-3',
      }),
    ).toEqual({
      success: true,
    })

    expect(sharedSubscriptionInvitationRepository.save).toHaveBeenCalledWith({
      status: 'declined',
      subscriptionId: 3,
      updatedAt: 1,
    })
  })

  it('should not decline the invitation if it does not exist', async () => {
    sharedSubscriptionInvitationRepository.findOneByUuidAndStatus = jest.fn().mockReturnValue(null)
    expect(
      await createUseCase().execute({
        sharedSubscriptionInvitationUuid: '1-2-3',
      }),
    ).toEqual({
      success: false,
    })

    expect(sharedSubscriptionInvitationRepository.save).not.toHaveBeenCalled()
  })

  it('runs the mutation inside the invite transaction runner and enqueues the realtime event', async () => {
    const { runner, commits, spy } = recordingRunner()
    invitation.uuid = 'invite-1'
    invitation.inviterIdentifier = 'inviter@test.com'
    invitation.inviteeIdentifier = 'invitee@test.com'
    const producer = { recordSubscriptionInvite: jest.fn().mockResolvedValue('inserted') }
    const resolver = { resolve: jest.fn().mockResolvedValue(['inviter-uuid', 'invitee-uuid']) }

    expect(
      await createUseCase(
        runner,
        producer as unknown as AuthInviteRealtimeOutboxProducer,
        resolver as unknown as AuthInviteAffectedUserResolver,
      ).execute({ sharedSubscriptionInvitationUuid: '1-2-3' }),
    ).toEqual({ success: true })

    expect(spy).toHaveBeenCalledTimes(1)
    expect(sharedSubscriptionInvitationRepository.save).toHaveBeenCalled()
    expect(commits).toEqual([true])
    expect(resolver.resolve).toHaveBeenCalledWith([], ['inviter@test.com', 'invitee@test.com'])
    // Enqueued inside the runner, so it commits or rolls back with the mutation.
    expect(producer.recordSubscriptionInvite).toHaveBeenCalledWith({
      action: 'declined',
      inviteUuid: 'invite-1',
      affectedUserUuids: ['inviter-uuid', 'invitee-uuid'],
    })
  })

  it('skips the realtime event when no affected user could be resolved', async () => {
    const { runner } = recordingRunner()
    const producer = { recordSubscriptionInvite: jest.fn() }
    const resolver = { resolve: jest.fn().mockResolvedValue([]) }

    expect(
      await createUseCase(
        runner,
        producer as unknown as AuthInviteRealtimeOutboxProducer,
        resolver as unknown as AuthInviteAffectedUserResolver,
      ).execute({ sharedSubscriptionInvitationUuid: '1-2-3' }),
    ).toEqual({ success: true })

    expect(producer.recordSubscriptionInvite).not.toHaveBeenCalled()
  })

  it('tells the runner to roll back when the invitation does not exist', async () => {
    sharedSubscriptionInvitationRepository.findOneByUuidAndStatus = jest.fn().mockReturnValue(null)
    const { runner, commits } = recordingRunner()

    expect(await createUseCase(runner).execute({ sharedSubscriptionInvitationUuid: '1-2-3' })).toEqual({
      success: false,
    })

    // The predicate is what decides commit vs rollback; a miss must not commit.
    expect(commits).toEqual([false])
    expect(sharedSubscriptionInvitationRepository.save).not.toHaveBeenCalled()
  })
})
