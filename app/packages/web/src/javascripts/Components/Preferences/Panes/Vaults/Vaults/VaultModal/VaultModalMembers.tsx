import { useCallback, useState } from 'react'
import { useApplication } from '@/Components/ApplicationProvider'
import { SharedVaultUserPermissionValue, SharedVaultUserServerHash, VaultListingInterface } from '@standardnotes/snjs'
import Icon from '@/Components/Icon/Icon'
import Button from '@/Components/Button/Button'
import ModalOverlay from '@/Components/Modal/ModalOverlay'
import DesignateSurvivorModal from './DesignateSurvivorModal'

/**
 * A member row only ever knows whether this device could resolve the member to a local
 * TrustedContact. That establishes "we have a trusted record for them" or "we do not" — it does NOT
 * establish that the member is *untrusted*, which is a claim about them rather than about what we
 * could look up. The row used to label every unresolved member "Untrusted", which read as an
 * accusation even for the signed-in user's own admin membership (rendered as a bare uuid labelled
 * Untrusted whenever the account had no self-contact). Unresolvable and untrusted are now distinct.
 */
const resolutionBadge = (params: { hasContact: boolean; isCurrentUser: boolean }) => {
  if (params.hasContact) {
    return {
      label: 'Trusted',
      title: 'You hold a trusted contact record for this member, so their keys can be verified.',
      icon: 'check-circle' as const,
      className: 'bg-success text-success-contrast',
    }
  }

  if (params.isCurrentUser) {
    return {
      label: 'Not yet identified',
      title:
        "This is your own membership, but your account's contact record is not available on this device yet. It is created once syncing completes.",
      icon: 'warning' as const,
      className: 'bg-warning text-warning-contrast',
    }
  }

  return {
    label: 'Not in your contacts',
    title:
      'This member is not one of your trusted contacts, so their keys cannot be verified on this device. Add them as a contact to verify them.',
    icon: 'warning' as const,
    className: 'bg-warning text-warning-contrast',
  }
}

/**
 * The permissions a given actor may SET on a given member, in the order they escalate.
 *
 * `admin` is owner-only on the server ("Only the owner can grant admin permission in a
 * shared vault"), so an admin member is not offered it -- the same reasoning that moved
 * the remove button off `isCurrentUserAdmin`: an affordance that can only ever fail is
 * worse than no affordance. It is still listed when the member ALREADY holds it, because
 * a select whose value is missing from its options silently renders as something else.
 */
const assignablePermissions = (params: {
  currentPermission: string
  isActorVaultOwner: boolean
}): SharedVaultUserPermissionValue[] => {
  const permissions: SharedVaultUserPermissionValue[] = ['read', 'write']

  if (params.isActorVaultOwner || params.currentPermission === 'admin') {
    permissions.push('admin')
  }

  return permissions
}

export const VaultModalMembers = ({
  members,
  isCurrentUserAdmin,
  vault,
  onChange,
}: {
  members: SharedVaultUserServerHash[]
  vault: VaultListingInterface
  isCurrentUserAdmin: boolean
  onChange: () => void
}) => {
  const application = useApplication()
  const currentUserUuid = application.sessions.getUser()?.uuid

  /**
   * Removing a member is OWNER-only, not admin-only, at both of the layers that actually decide:
   * `VaultUserService.removeUserFromSharedVault` throws unless the signed-in user owns the vault, and
   * the server's `RemoveUserFromSharedVault` rejects "only owner can remove other users from shared
   * vault". The button used to be gated on `isCurrentUserAdmin`, so an admin member who is not the
   * owner was offered an action that could only ever fail.
   */
  const isCurrentUserVaultOwner =
    vault.isSharedVaultListing() && application.vaultUsers.isCurrentUserSharedVaultOwner(vault)

  const removeMemberFromVault = useCallback(
    async (memberItem: SharedVaultUserServerHash) => {
      if (!vault.isSharedVaultListing()) {
        return
      }

      // `removeUserFromSharedVault` THROWS rather than returning a failed Result for its own
      // preconditions (not the owner, vault locked), and it rotates the vault key AFTER the server
      // has already dropped the membership, which can fail on its own. Unhandled, that was a silent
      // dead click: the modal neither refreshed nor said anything.
      //
      // `onChange` runs either way, deliberately. A thrown precondition changed nothing, so a
      // refetch is merely redundant; a failure after the server call means the member really is gone
      // and the list on screen is the stale one.
      try {
        const result = await application.vaultUsers.removeUserFromSharedVault(vault, memberItem.user_uuid)
        if (result.isFailed()) {
          void application.alerts.alert(result.getError())
        }
      } catch (error) {
        void application.alerts.alert(error instanceof Error ? error.message : String(error))
      }

      onChange()
    },
    [application.alerts, application.vaultUsers, vault, onChange],
  )

  /**
   * The member whose permission change is in flight, so the row that is changing is the
   * only one disabled. A single boolean would freeze every row in a large vault.
   */
  const [pendingPermissionChangeFor, setPendingPermissionChangeFor] = useState<string | undefined>(undefined)

  const changeMemberPermission = useCallback(
    async (memberItem: SharedVaultUserServerHash, permission: SharedVaultUserPermissionValue) => {
      if (!vault.isSharedVaultListing() || permission === memberItem.permission) {
        return
      }

      setPendingPermissionChangeFor(memberItem.user_uuid)

      // `changeMemberPermission` returns a failed Result for every refusal, including its
      // own precondition, so there is nothing to catch here -- but the server's message is
      // the only thing that distinguishes "you may not grant admin" from "you cannot change
      // your own permission", and both have to reach the person who clicked.
      try {
        const result = await application.vaultUsers.changeMemberPermission(vault, memberItem.user_uuid, permission)
        if (result.isFailed()) {
          void application.alerts.alert(result.getError())
        }
      } catch (error) {
        void application.alerts.alert(error instanceof Error ? error.message : String(error))
      } finally {
        setPendingPermissionChangeFor(undefined)
      }

      onChange()
    },
    [application.alerts, application.vaultUsers, vault, onChange],
  )

  const vaultHasNoDesignatedSurvivor = vault.isSharedVaultListing() && !vault.sharing.designatedSurvivor
  const [isDesignateSurvivorModalOpen, setIsDesignateSurvivorModalOpen] = useState(false)
  const openDesignateSurvivorModal = () => setIsDesignateSurvivorModalOpen(true)
  const closeDesignateSurvivorModal = () => setIsDesignateSurvivorModalOpen(false)

  return (
    <div>
      <div className="mb-3 text-lg">Vault Members</div>
      {vaultHasNoDesignatedSurvivor && members.length > 1 && isCurrentUserAdmin && (
        <div className="bg-danger-faded text-danger mb-3 grid grid-cols-[auto_1fr] gap-x-[0.65rem] gap-y-0.5 overflow-hidden rounded p-2.5">
          <Icon type="warning" className="place-self-center" />
          <div className="text-base font-semibold">No designated survivor</div>
          <div className="col-start-2">
            Vaults that have no designated survivor will be deleted when the owner account is deleted. In order to
            ensure that no data is lost, please designate a survivor who will be transferred ownership of the vault.
          </div>
          <Button small className="col-start-2 mt-1.5" onClick={openDesignateSurvivorModal}>
            Designate survivor
          </Button>
          <ModalOverlay isOpen={isDesignateSurvivorModalOpen} close={closeDesignateSurvivorModal}>
            <DesignateSurvivorModal vault={vault} members={members} closeModal={closeDesignateSurvivorModal} />
          </ModalOverlay>
        </div>
      )}
      <div className="space-y-3.5">
        {members.map((member) => {
          const isMemberVaultOwner = application.vaultUsers.isVaultUserOwner(member)
          const contact = application.contacts.findContactForServerUser(member)
          const permission = application.vaultUsers.getFormattedMemberPermission(member.permission)
          const isCurrentUser = currentUserUuid !== undefined && member.user_uuid === currentUserUuid
          const badge = resolutionBadge({ hasContact: contact !== undefined, isCurrentUser })
          // Never fall back to the raw uuid for the signed-in user: it identifies nobody to them and
          // was the whole of symptom "Vault Members / <uuid> / Untrusted / Admin".
          const displayName = isCurrentUser ? 'You' : contact?.name || member.user_uuid

          return (
            <div
              key={contact?.uuid || member.user_uuid}
              className="grid grid-cols-[auto_1fr] gap-x-[0.65rem] gap-y-0.5 text-base font-medium md:text-sm"
            >
              <Icon type="user" className="col-start-1 col-end-2 place-self-center" />
              <div className="flex items-center gap-2 overflow-hidden text-base font-bold text-ellipsis">
                <span>{displayName}</span>
                <div
                  className={`${badge.className} flex items-center gap-1 rounded px-1 py-0.5 pr-1.5 text-xs`}
                  title={badge.title}
                >
                  <Icon type={badge.icon} size="small" />
                  {badge.label}
                </div>
                {member.is_designated_survivor && (
                  <div className="bg-info text-success-contrast flex items-center gap-1 rounded px-1 py-0.5 text-xs">
                    <Icon type="security" size="small" />
                    Designated survivor
                  </div>
                )}
              </div>
              <div className="col-start-2 row-start-2">{permission}</div>
              {isCurrentUserAdmin && !isMemberVaultOwner && !isCurrentUser && (
                <div className="col-start-2 row-start-3 mt-1 flex items-center gap-2">
                  <label className="text-passive-0" htmlFor={`vault-member-permission-${member.user_uuid}`}>
                    Permission
                  </label>
                  <select
                    id={`vault-member-permission-${member.user_uuid}`}
                    className="border-border bg-default text-text rounded border px-2 py-1"
                    value={member.permission}
                    disabled={pendingPermissionChangeFor === member.user_uuid}
                    onChange={(event) =>
                      void changeMemberPermission(member, event.target.value as SharedVaultUserPermissionValue)
                    }
                  >
                    {assignablePermissions({
                      currentPermission: member.permission,
                      isActorVaultOwner: isCurrentUserVaultOwner,
                    }).map((assignable) => (
                      <option key={assignable} value={assignable}>
                        {application.vaultUsers.getFormattedMemberPermission(assignable)}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {isCurrentUserVaultOwner && !isMemberVaultOwner && (
                <Button
                  className="col-start-2 row-start-4 mt-1"
                  label="Remove From Vault"
                  onClick={() => removeMemberFromVault(member)}
                  small
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
