import {
  Result,
  SharedVaultUser,
  SharedVaultUserPermission,
  Timestamps,
  UseCaseInterface,
  Uuid,
} from '@standardnotes/domain-core'
import { DomainEventPublisherInterface } from '@standardnotes/domain-events'
import { TimerInterface } from '@standardnotes/time'

import { UpdateSharedVaultUserPermissionDTO } from './UpdateSharedVaultUserPermissionDTO'
import { SharedVaultRepositoryInterface } from '../../../SharedVault/SharedVaultRepositoryInterface'
import { SharedVaultUserRepositoryInterface } from '../../../SharedVault/User/SharedVaultUserRepositoryInterface'
import { DomainEventFactoryInterface } from '../../../Event/DomainEventFactoryInterface'
import { InviteRealtimeDomainEventProducer } from '../../../Invite/InviteRealtimeDomainEventProducer'
import { InviteMutationTransactionRunner } from '../../../Invite/InviteMutationTransactionRunner'

/**
 * Changes an existing member's permission IN PLACE.
 *
 * Before this existed, promoting a member read -> write meant removing them and
 * re-inviting: the vault key was rotated, the member lost access until they accepted
 * again, and `DeleteSharedVault`-adjacent machinery ran for what is a one-column change.
 *
 * Authorization lives HERE, in the use case, and not in middleware, because
 * `DirectCallServiceProxy` (the bundled single-container / `MODE=home-server` topology)
 * hands the request straight to the controller and never runs the gateway's Express
 * middleware stack. A guard placed in middleware would be absent on exactly the
 * deployment this operator ships.
 *
 * Server authorization for a shared vault is PURELY `shared_vault_users.permission`
 * (per-item signature trust exists in the tree but has no production call site), so this
 * row is the whole of the access decision and the rules below are the whole of its
 * protection:
 *
 *   - the originator must own the vault, or hold `admin` in it;
 *   - granting `admin` is owner-only, so an admin cannot mint a peer who could then
 *     outlive their own demotion;
 *   - the originator may never target THEMSELVES. The requirement was "not upward", but
 *     a self-change has no legitimate use here -- an owner steps back through
 *     `designate-survivor`/transfer, not by editing their own row -- and "upward" is not
 *     a total order worth encoding when refusing all of it costs nothing;
 *   - the vault OWNER's row is never changed, so an admin cannot demote the owner;
 *   - the target must already be a member. Granting access is `invite`/`accept`; this
 *     use case cannot create a membership, and a vanished member is reported as such
 *     rather than silently re-added.
 *
 * KNOWN GAP -- like `AddUserToSharedVault` and `RemoveUserFromSharedVault`, this is not
 * written to the security audit log, because `syncing-server` has no audit writer bound
 * at all. See the full note on `AddUserToSharedVault`: the natural seam is a consumer of
 * the domain event this publishes, which carries the actor, the subject and both
 * permissions precisely so that consumer needs nothing more.
 */
export class UpdateSharedVaultUserPermission implements UseCaseInterface<SharedVaultUser> {
  constructor(
    private sharedVaultUsersRepository: SharedVaultUserRepositoryInterface,
    private sharedVaultRepository: SharedVaultRepositoryInterface,
    private timer: TimerInterface,
    private domainEventFactory: DomainEventFactoryInterface,
    private domainEventPublisher: DomainEventPublisherInterface,
    private inviteMutationTransactionRunner: InviteMutationTransactionRunner,
    private inviteRealtimeDomainEventProducer: InviteRealtimeDomainEventProducer,
  ) {}

  async execute(dto: UpdateSharedVaultUserPermissionDTO): Promise<Result<SharedVaultUser>> {
    return this.inviteMutationTransactionRunner.execute(() => this.executeMutation(dto))
  }

  private async executeMutation(dto: UpdateSharedVaultUserPermissionDTO): Promise<Result<SharedVaultUser>> {
    const sharedVaultUuidOrError = Uuid.create(dto.sharedVaultUuid)
    if (sharedVaultUuidOrError.isFailed()) {
      return Result.fail(sharedVaultUuidOrError.getError())
    }
    const sharedVaultUuid = sharedVaultUuidOrError.getValue()

    const originatorUuidOrError = Uuid.create(dto.originatorUuid)
    if (originatorUuidOrError.isFailed()) {
      return Result.fail(originatorUuidOrError.getError())
    }
    const originatorUuid = originatorUuidOrError.getValue()

    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(userUuidOrError.getError())
    }
    const userUuid = userUuidOrError.getValue()

    const permissionOrError = SharedVaultUserPermission.create(dto.permission)
    if (permissionOrError.isFailed()) {
      return Result.fail(permissionOrError.getError())
    }
    const permission = permissionOrError.getValue()

    const sharedVault = await this.sharedVaultRepository.findByUuid(sharedVaultUuid)
    if (!sharedVault) {
      return Result.fail('Shared vault not found')
    }

    if (userUuid.equals(originatorUuid)) {
      return Result.fail('Cannot change your own permission in a shared vault')
    }

    if (sharedVault.props.userUuid.equals(userUuid)) {
      return Result.fail('Cannot change the permission of the shared vault owner')
    }

    const members = await this.sharedVaultUsersRepository.findBySharedVaultUuid(sharedVaultUuid)

    const originatorIsOwner = sharedVault.props.userUuid.equals(originatorUuid)
    const originatorIsAdmin = members.some(
      (member) =>
        member.props.userUuid.equals(originatorUuid) &&
        member.props.permission.value === SharedVaultUserPermission.PERMISSIONS.Admin,
    )
    if (!originatorIsOwner && !originatorIsAdmin) {
      return Result.fail('Only the owner or an admin can change a shared vault member permission')
    }

    if (permission.value === SharedVaultUserPermission.PERMISSIONS.Admin && !originatorIsOwner) {
      return Result.fail('Only the owner can grant admin permission in a shared vault')
    }

    const member = members.find((candidate) => candidate.props.userUuid.equals(userUuid))
    if (!member) {
      return Result.fail('User is not a member of the shared vault')
    }

    const previousPermission = member.props.permission.value
    if (previousPermission === permission.value) {
      // Idempotent on purpose, and deliberately WITHOUT a write or an event: bumping
      // `updatedAt` would spend a revision on nothing, and the client fences membership
      // invalidations on a strictly increasing revision per membership row.
      return Result.ok(member)
    }

    // Clamped strictly above the row's previous `updatedAt`. The client fences membership
    // invalidations per membership row on a STRICTLY greater revision, so a Timer that is
    // behind the row's last write would otherwise make this change invisible to the one
    // person it is about -- and would move the row backwards in time while doing it.
    const updatedAt = Math.max(this.timer.getTimestampInMicroseconds(), member.props.timestamps.updatedAt + 1)

    member.props.permission = permission
    member.props.timestamps = Timestamps.create(member.props.timestamps.createdAt, updatedAt).getValue()

    await this.sharedVaultUsersRepository.save(member)

    await this.domainEventPublisher.publish(
      this.domainEventFactory.createUserPermissionChangedInSharedVaultEvent({
        sharedVaultUuid: sharedVaultUuid.value,
        userUuid: userUuid.value,
        permission: permission.value,
        previousPermission,
        originatorUuid: originatorUuid.value,
        updatedAt,
      }),
    )

    // The member's own client reads its write-capability from `VaultUserCache`, and this
    // event is the only thing that refreshes it.
    await this.inviteRealtimeDomainEventProducer.recordSharedVaultMembership({
      action: 'role-changed',
      sharedVaultUuid: sharedVaultUuid.value,
      memberUserUuid: userUuid.value,
      membershipUuid: member.id.toString(),
      role: permission.value as 'read' | 'write' | 'admin',
      revision: String(updatedAt),
      affectedUserUuids: [...members.map((candidate) => candidate.props.userUuid.value), originatorUuid.value],
    })

    return Result.ok(member)
  }
}
