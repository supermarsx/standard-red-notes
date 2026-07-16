import { FunctionComponent, useCallback, useEffect, useMemo, useState } from 'react'
import Modal, { ModalAction } from '@/Components/Modal/Modal'
import ModalOverlay from '@/Components/Modal/ModalOverlay'
import DecoratedInput from '@/Components/Input/DecoratedInput'
import Icon from '@/Components/Icon/Icon'
import StyledTooltip from '@/Components/StyledTooltip/StyledTooltip'
import { useApplication } from '@/Components/ApplicationProvider'
import { ClientDisplayableError, InviteRecord, TrustedContactInterface } from '@standardnotes/snjs'
import { ToastType, addToast } from '@standardnotes/toast'
import ScanCollaborationIDModal, { isQRScanningSupported } from './ScanCollaborationIDModal'

type Props = {
  fromInvite?: InviteRecord
  editContactUuid?: string
  onCloseDialog: () => void
  onAddContact?: (contact: TrustedContactInterface) => void
}

const EditContactModal: FunctionComponent<Props> = ({ onCloseDialog, fromInvite, onAddContact, editContactUuid }) => {
  const application = useApplication()

  const [name, setName] = useState<string>('')
  const [collaborationID, setCollaborationID] = useState<string>('')
  const [editingContact, setEditingContact] = useState<TrustedContactInterface | undefined>(undefined)

  const [isQRScanAvailable, setIsQRScanAvailable] = useState(false)
  const [isScanModalOpen, setIsScanModalOpen] = useState(false)
  const closeScanModal = useCallback(() => setIsScanModalOpen(false), [])

  useEffect(() => {
    let mounted = true
    isQRScanningSupported()
      .then((supported) => {
        if (mounted) {
          setIsQRScanAvailable(supported)
        }
      })
      .catch(() => undefined)
    return () => {
      mounted = false
    }
  }, [])

  const handleScannedCollaborationID = useCallback((scannedID: string) => {
    setCollaborationID(scannedID)
    setIsScanModalOpen(false)
    addToast({
      type: ToastType.Success,
      message: 'CollaborationID scanned',
    })
  }, [])

  const handleDialogClose = useCallback(() => {
    onCloseDialog()
  }, [onCloseDialog])

  useEffect(() => {
    if (fromInvite) {
      setCollaborationID(application.contacts.getCollaborationIDFromInvite(fromInvite.invite))
    }
  }, [application.contacts, fromInvite])

  useEffect(() => {
    if (editContactUuid) {
      const contact = application.contacts.findContact(editContactUuid)
      if (!contact) {
        throw new Error(`Contact with uuid ${editContactUuid} not found`)
      }

      setEditingContact(contact)
      setName(contact.name)
      setCollaborationID(application.contacts.getCollaborationIDForTrustedContact(contact))
    }
  }, [application.contacts, application.vaults, editContactUuid])

  const handleSubmit = useCallback(async () => {
    if (editingContact) {
      void application.contacts.editTrustedContactFromCollaborationID(editingContact, { name, collaborationID })
      handleDialogClose()
    } else {
      try {
        const contact = await application.contacts.addTrustedContactFromCollaborationID(collaborationID, name)
        if (contact) {
          onAddContact?.(contact)
          handleDialogClose()
        } else {
          void application.alerts.alert('Unable to create contact. Please try again.')
        }
      } catch (error) {
        if (error instanceof ClientDisplayableError) {
          application.alerts.showErrorAlert(error).catch(console.error)
        }
        console.error(error)
      }
    }
  }, [editingContact, application.contacts, application.alerts, name, collaborationID, handleDialogClose, onAddContact])

  const modalActions = useMemo(
    (): ModalAction[] => [
      {
        label: editContactUuid ? 'Save Contact' : 'Add Contact',
        onClick: handleSubmit,
        type: 'primary',
        mobileSlot: 'right',
      },
      {
        label: 'Cancel',
        onClick: handleDialogClose,
        type: 'cancel',
        mobileSlot: 'left',
      },
    ],
    [editContactUuid, handleDialogClose, handleSubmit],
  )

  const focusInput = useCallback((input: HTMLInputElement | null) => {
    if (input) {
      setTimeout(() => {
        input.focus()
      })
    }
  }, [])

  return (
    <Modal
      title={editContactUuid ? 'Edit Contact' : 'Add New Contact'}
      close={handleDialogClose}
      actions={modalActions}
    >
      <div className="mb-3 flex w-full flex-col gap-4 px-4.5 pt-4 pb-1.5">
        <label>
          <div className="mb-1">Contact Name</div>
          <DecoratedInput
            id="invite-name-input"
            value={name}
            onChange={(value) => {
              setName(value)
            }}
            ref={focusInput}
            onEnter={handleSubmit}
          />
        </label>

        {!editingContact?.isMe && (
          <label>
            <div className="mb-1">CollaborationID</div>
            <DecoratedInput
              id="invite-email-input"
              value={collaborationID}
              onChange={(value) => {
                setCollaborationID(value)
              }}
              onEnter={handleSubmit}
              right={
                isQRScanAvailable
                  ? [
                      <StyledTooltip label="Scan QR code">
                        <button
                          type="button"
                          className="text-neutral hover:text-info flex cursor-pointer border-0 bg-transparent p-0"
                          aria-label="Scan QR code"
                          onClick={() => setIsScanModalOpen(true)}
                        >
                          <Icon type="camera" size="medium" />
                        </button>
                      </StyledTooltip>,
                    ]
                  : undefined
              }
            />
          </label>
        )}

        {!editContactUuid && (
          <p>
            Ask your contact for their Standard Red Notes CollaborationID via secure email or chat. Then, enter it here
            to add them as a contact.{' '}
            {isQRScanAvailable && 'You can also scan their CollaborationID QR code using the camera button above.'}
          </p>
        )}
      </div>
      <ModalOverlay isOpen={isScanModalOpen} close={closeScanModal}>
        <ScanCollaborationIDModal onScan={handleScannedCollaborationID} close={closeScanModal} />
      </ModalOverlay>
    </Modal>
  )
}

export default EditContactModal
