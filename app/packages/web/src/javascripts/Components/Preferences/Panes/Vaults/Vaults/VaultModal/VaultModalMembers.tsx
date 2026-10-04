import { useCallback, useState } from 'react'
import { useApplication } from '@/Components/ApplicationProvider'
import { SharedVaultUserServerHash, VaultListingInterface } from '@standardnotes/snjs'
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

  const removeMemberFromVault = useCallback(
    async (memberItem: SharedVaultUserServerHash) => {
      if (vault.isSharedVaultListing()) {
        await application.vaultUsers.removeUserFromSharedVault(vault, memberItem.user_uuid)
        onChange()
      }
    },
    [application.vaultUsers, vault, onChange],
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
              {isCurrentUserAdmin && !isMemberVaultOwner && (
                <Button
                  className="col-start-2 row-start-3 mt-1"
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
