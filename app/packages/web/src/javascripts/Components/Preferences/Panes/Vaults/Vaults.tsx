import { observer } from 'mobx-react-lite'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '@/Components/Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import Icon from '@/Components/Icon/Icon'
import { useApplication } from '@/Components/ApplicationProvider'
import ContactItem from './Contacts/ContactItem'
import CollaborationIDSection from './Contacts/CollaborationIDSection'
import ModalOverlay from '@/Components/Modal/ModalOverlay'
import EditContactModal from './Contacts/EditContactModal'
import { useCallback, useEffect, useState } from 'react'
import {
  VaultListingInterface,
  TrustedContactInterface,
  InviteRecord,
  ContentType,
  SharedVaultServiceEvent,
  VaultUserServiceEvent,
  RoleName,
  ProtocolVersion,
  compareVersions,
  VaultInviteServiceEvent,
} from '@standardnotes/snjs'
import VaultItem from './Vaults/VaultItem'
import Button from '@/Components/Button/Button'
import InviteItem from './Invites/InviteItem'
import EditVaultModal from './Vaults/VaultModal/EditVaultModal'
import PreferencesPane from '../../PreferencesComponents/PreferencesPane'

const Vaults = observer(() => {
  const application = useApplication()

  const hasAccount = application.hasAccount()
  const isSharedVaultsEnabled = application.featuresController.isEntitledToSharedVaults()

  const [vaults, setVaults] = useState<VaultListingInterface[]>([])
  const [canCreateMoreVaults, setCanCreateMoreVaults] = useState(true)
  const [invites, setInvites] = useState<InviteRecord[]>([])
  const [contacts, setContacts] = useState<TrustedContactInterface[]>([])

  const [isAddContactModalOpen, setIsAddContactModalOpen] = useState(false)
  const closeAddContactModal = () => setIsAddContactModalOpen(false)

  const [isCreatingSharedVault, setIsCreatingSharedVault] = useState(false)
  const [isVaultModalOpen, setIsVaultModalOpen] = useState(false)
  const closeVaultModal = () => {
    setIsVaultModalOpen(false)
    setIsCreatingSharedVault(false)
  }

  const vaultService = application.vaults
  const contactService = application.contacts
  const featuresService = application.features

  const updateVaults = useCallback(async () => {
    const vaults = vaultService.getVaults()
    const ownedVaults = vaults.filter((vault) => {
      return !vault.isSharedVaultListing() ? true : application.vaultUsers.isCurrentUserSharedVaultOwner(vault)
    })

    if (featuresService.hasMinimumRole(RoleName.NAMES.ProUser)) {
      setCanCreateMoreVaults(true)
    } else if (featuresService.hasMinimumRole(RoleName.NAMES.PlusUser)) {
      setCanCreateMoreVaults(ownedVaults.length < 3)
    } else {
      setCanCreateMoreVaults(ownedVaults.length < 1)
    }

    setVaults(vaults)
  }, [vaultService, featuresService, application.vaultUsers])

  const updateInvites = useCallback(async () => {
    setInvites(application.vaultInvites.getCachedPendingInviteRecords())
  }, [application.vaultInvites])
  useEffect(() => {
    return application.vaultInvites.addEventObserver((event) => {
      if (event === VaultInviteServiceEvent.InvitesReloaded) {
        void updateInvites()
      }
    })
  }, [application.vaultInvites, updateInvites])

  const updateContacts = useCallback(async () => {
    setContacts(contactService.getAllContacts())
  }, [contactService])

  const updateAllData = useCallback(async () => {
    await Promise.all([updateVaults(), updateInvites(), updateContacts()])
  }, [updateContacts, updateInvites, updateVaults])

  useEffect(() => {
    return application.sharedVaults.addEventObserver((event) => {
      if (event === SharedVaultServiceEvent.SharedVaultStatusChanged) {
        void updateAllData()
      }
    })
  }, [application.sharedVaults, updateAllData])

  useEffect(() => {
    return application.sharedVaults.addEventObserver((event) => {
      if (event === SharedVaultServiceEvent.SharedVaultFileStorageUsageChanged) {
        void updateAllData()
      }
    })
  }, [application.sharedVaults, updateAllData])

  useEffect(() => {
    return application.vaultUsers.addEventObserver((event) => {
      if (event === VaultUserServiceEvent.UsersChanged) {
        void updateAllData()
      }
    })
  }, [application.vaultUsers, updateAllData])

  useEffect(() => {
    return application.vaultInvites.addEventObserver(() => {
      void updateAllData()
    })
  }, [application.vaultInvites, updateAllData])

  useEffect(() => {
    return application.items.streamItems([ContentType.TYPES.VaultListing, ContentType.TYPES.TrustedContact], () => {
      void updateAllData()
    })
  }, [application, updateAllData])

  useEffect(() => {
    void application.vaultInvites.downloadInboundInvites()
    void updateAllData()
  }, [updateAllData, application.vaultInvites])

  const createNewVault = useCallback(async () => {
    setIsVaultModalOpen(true)
  }, [])

  const createNewSharedVault = useCallback(async () => {
    setIsCreatingSharedVault(true)
    setIsVaultModalOpen(true)
  }, [])

  const createNewContact = useCallback(() => {
    setIsAddContactModalOpen(true)
  }, [])

  return (
    <PreferencesPane>
      <ModalOverlay isOpen={isAddContactModalOpen} close={closeAddContactModal}>
        <EditContactModal onCloseDialog={closeAddContactModal} />
      </ModalOverlay>
      <EditVaultModal
        isVaultModalOpen={isVaultModalOpen}
        creatingSharedVault={isCreatingSharedVault}
        closeVaultModal={closeVaultModal}
      />
      {/* What are vaults? — short, non-intrusive explainer at the top of the pane. */}
      <PreferencesGroup>
        <PreferencesSegment>
          <Title>What are vaults?</Title>
          <Subtitle>
            A vault is a private, encrypted collection that groups notes and files under their own separate key — like a
            safe inside your account.
          </Subtitle>
          <div className="border-border bg-contrast mt-2.5 rounded border p-3 text-sm">
            <div className="mb-1.5 flex items-center gap-2 font-semibold">
              <Icon type="info" size="small" />
              How vaults help
            </div>
            <ul className="ml-4 list-disc space-y-1">
              <li>
                Each vault has its <strong>own encryption key</strong>, so its contents stay protected even while the
                rest of your account is open.
              </li>
              <li>
                <strong>Lock</strong> a vault to hide its notes and require your vault password (or account) to reopen
                it.
              </li>
              <li>
                Turn a vault into a <strong>shared vault</strong> to collaborate: invite a trusted contact and co-edit
                notes together with end-to-end encryption.
              </li>
            </ul>
            <Text className="mt-2">
              Use vaults to wall off sensitive material — finances, journals, credentials — from your everyday notes.
            </Text>
          </div>
        </PreferencesSegment>
      </PreferencesGroup>
      {invites.length > 0 && (
        <PreferencesGroup>
          <PreferencesSegment>
            <Title>Incoming Invites</Title>
            <div className="my-2 flex flex-col gap-3.5">
              {invites.map((invite) => {
                return <InviteItem inviteRecord={invite} key={invite.invite.uuid} />
              })}
            </div>
          </PreferencesSegment>
        </PreferencesGroup>
      )}
      {hasAccount && isSharedVaultsEnabled && (
        <PreferencesGroup>
          <PreferencesSegment>
            <Title>Contacts</Title>
            {contacts.length > 0 && (
              <div className="my-2 flex flex-col gap-3.5">
                {contacts.map((contact) => {
                  return <ContactItem contact={contact} key={contact.uuid} />
                })}
              </div>
            )}
            <div className="mt-2.5 flex flex-row">
              <Button label="Add New Contact" className="mr-3" onClick={createNewContact} />
            </div>
          </PreferencesSegment>
        </PreferencesGroup>
      )}
      {hasAccount && isSharedVaultsEnabled && <CollaborationIDSection />}
      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Vaults</Title>
          {vaults.length > 0 && (
            <div className="my-2 flex flex-col gap-3.5">
              {vaults.map((vault) => {
                return <VaultItem vault={vault} key={vault.uuid} />
              })}
            </div>
          )}
          {canCreateMoreVaults && (
            <div className="mt-2.5 flex gap-3">
              <Button label="Create Vault" onClick={createNewVault} />
              {hasAccount && isSharedVaultsEnabled && (
                <Button label="Create Shared Vault" onClick={createNewSharedVault} />
              )}
            </div>
          )}
        </PreferencesSegment>
      </PreferencesGroup>
    </PreferencesPane>
  )
})

const VaultsWrapper = () => {
  const application = useApplication()
  const hasAccount = application.hasAccount()
  const accountProtocolVersion = application.getUserVersion()
  const isAccountProtocolNotSupported =
    accountProtocolVersion && compareVersions(accountProtocolVersion, ProtocolVersion.V004) < 0

  if (hasAccount && isAccountProtocolNotSupported) {
    return (
      <PreferencesPane>
        <PreferencesGroup>
          <Title>Account update required</Title>
          <Subtitle>
            In order to use Vaults, you must update your account to use the latest data encryption version.
          </Subtitle>
          <Button primary className="mt-3" onClick={() => application.upgradeProtocolVersion().catch(console.error)}>
            Update Account
          </Button>
        </PreferencesGroup>
      </PreferencesPane>
    )
  }

  return <Vaults />
}

export default observer(VaultsWrapper)
