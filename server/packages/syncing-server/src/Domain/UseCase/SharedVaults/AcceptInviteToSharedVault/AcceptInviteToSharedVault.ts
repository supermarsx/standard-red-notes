import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'
import { AcceptInviteToSharedVaultDTO } from './AcceptInviteToSharedVaultDTO'
import { SharedVaultInviteRepositoryInterface } from '../../../SharedVault/User/Invite/SharedVaultInviteRepositoryInterface'
import { AddUserToSharedVault } from '../AddUserToSharedVault/AddUserToSharedVault'
import { SharedVaultUserRepositoryInterface } from '../../../SharedVault/User/SharedVaultUserRepositoryInterface'
import { InviteRealtimeDomainEventProducer } from '../../../Invite/InviteRealtimeDomainEventProducer'
import { InviteMutationTransactionRunner } from '../../../Invite/InviteMutationTransactionRunner'

export class AcceptInviteToSharedVault implements UseCaseInterface<void> {
  constructor(
    private addUserToSharedVault: AddUserToSharedVault,
    private sharedVaultInviteRepository: SharedVaultInviteRepositoryInterface,
    private sharedVaultUserRepository?: SharedVaultUserRepositoryInterface,
    private inviteMutationTransactionRunner?: InviteMutationTransactionRunner,
    private inviteRealtimeDomainEventProducer?: InviteRealtimeDomainEventProducer,
  ) {}

  async execute(dto: AcceptInviteToSharedVaultDTO): Promise<Result<void>> {
    if (this.inviteMutationTransactionRunner) {
      return this.inviteMutationTransactionRunner.execute(() => this.executeMutation(dto))
    }
    return this.executeMutation(dto)
  }

  private async executeMutation(dto: AcceptInviteToSharedVaultDTO): Promise<Result<void>> {
    const inviteUuidOrError = Uuid.create(dto.inviteUuid)
    if (inviteUuidOrError.isFailed()) {
      return Result.fail(inviteUuidOrError.getError())
    }
    const inviteUuid = inviteUuidOrError.getValue()

    const originatorUuidOrError = Uuid.create(dto.originatorUuid)
    if (originatorUuidOrError.isFailed()) {
      return Result.fail(originatorUuidOrError.getError())
    }
    const originatorUuid = originatorUuidOrError.getValue()

    const invite = await this.sharedVaultInviteRepository.findByUuid(inviteUuid)
    if (!invite) {
      return Result.fail('Invite not found')
    }

    if (!invite.props.userUuid.equals(originatorUuid)) {
      return Result.fail('Only the recipient of the invite can accept it')
    }

    const result = await this.addUserToSharedVault.execute({
      sharedVaultUuid: invite.props.sharedVaultUuid.value,
      userUuid: invite.props.userUuid.value,
      permission: invite.props.permission.value,
    })
    if (result.isFailed()) {
      return Result.fail(result.getError())
    }
    const membership = result.getValue()

    await this.sharedVaultInviteRepository.remove(invite)

    const members = await this.sharedVaultUserRepository?.findBySharedVaultUuid(invite.props.sharedVaultUuid)
    const affectedUserUuids = [
      invite.props.senderUuid.value,
      invite.props.userUuid.value,
      ...(members ?? []).map((member) => member.props.userUuid.value),
    ]
    await this.inviteRealtimeDomainEventProducer?.recordSharedVaultInvite({
      action: 'accepted',
      inviteUuid: invite.id.toString(),
      sharedVaultUuid: invite.props.sharedVaultUuid.value,
      affectedUserUuids,
    })
    await this.inviteRealtimeDomainEventProducer?.recordSharedVaultMembership({
      action: 'accepted',
      inviteUuid: invite.id.toString(),
      membershipUuid: membership.id.toString(),
      sharedVaultUuid: invite.props.sharedVaultUuid.value,
      memberUserUuid: invite.props.userUuid.value,
      role: membership.props.permission.value as 'read' | 'write' | 'admin',
      revision: String(membership.props.timestamps.updatedAt),
      affectedUserUuids,
    })

    return Result.ok()
  }
}
