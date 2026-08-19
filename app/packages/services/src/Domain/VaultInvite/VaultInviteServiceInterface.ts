import { InviteRecord } from './InviteRecord'
import { ApplicationServiceInterface } from '../Service/ApplicationServiceInterface'
import { SharedVaultListingInterface, TrustedContactInterface } from '@standardnotes/models'
import { ClientDisplayableError, SharedVaultInviteServerHash } from '@standardnotes/responses'
import { VaultInviteServiceEvent } from './VaultInviteServiceEvent'
import { Result } from '@standardnotes/domain-core'
import { InviteRealtimeEvent } from '../Invite/InviteRealtimeEvent'
import { InviteRealtimeHandlerContext } from '../Invite/InviteRealtimeEventConsumer'

export interface VaultInviteServiceInterface extends ApplicationServiceInterface<VaultInviteServiceEvent, unknown> {
  getInvitableContactsForSharedVault(sharedVault: SharedVaultListingInterface): Promise<TrustedContactInterface[]>
  inviteContactToSharedVault(
    sharedVault: SharedVaultListingInterface,
    contact: TrustedContactInterface,
    permission: string,
  ): Promise<Result<SharedVaultInviteServerHash>>
  getCachedPendingInviteRecords(): InviteRecord[]
  deleteInvite(invite: SharedVaultInviteServerHash): Promise<ClientDisplayableError | void>
  downloadInboundInvites(
    context?: InviteRealtimeHandlerContext,
  ): Promise<ClientDisplayableError | SharedVaultInviteServerHash[]>
  getOutboundInvites(
    sharedVault?: SharedVaultListingInterface,
  ): Promise<SharedVaultInviteServerHash[] | ClientDisplayableError>
  acceptInvite(pendingInvite: InviteRecord): Promise<Result<void>>
  handleInviteRealtimeEvents(
    events: readonly InviteRealtimeEvent[],
    context?: InviteRealtimeHandlerContext,
  ): Promise<void>
}
