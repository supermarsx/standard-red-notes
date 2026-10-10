import { DomainEventInterface } from './DomainEventInterface'
import { UserPermissionChangedInSharedVaultEventPayload } from './UserPermissionChangedInSharedVaultEventPayload'

/**
 * A shared-vault member's permission changed IN PLACE -- no removal, no re-invite.
 *
 * This is deliberately NOT `USER_ADDED_TO_SHARED_VAULT` with a new permission. The auth
 * service mirrors membership rows into `auth_shared_vault_users` from that event via
 * `AddSharedVaultUser`, which mints a FRESH uuid and INSERTs; the table has no unique
 * index on (user_uuid, shared_vault_uuid), so re-publishing the add event for a
 * permission change would leave two rows for one membership and
 * `CreateCrossServiceToken` would project whichever the query returned first. The
 * distinct type lets the consumer UPDATE the row it already has.
 */
export interface UserPermissionChangedInSharedVaultEvent extends DomainEventInterface {
  type: 'USER_PERMISSION_CHANGED_IN_SHARED_VAULT'
  payload: UserPermissionChangedInSharedVaultEventPayload
}
