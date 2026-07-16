import { useCallback, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { QRCodeSVG } from 'qrcode.react'
import { ButtonType } from '@standardnotes/snjs'
import { ToastType, addToast } from '@standardnotes/toast'
import { Subtitle, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '@/Components/Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import Button from '@/Components/Button/Button'
import ModalOverlay from '@/Components/Modal/ModalOverlay'
import PasswordWizard from '@/Components/PasswordWizard/PasswordWizard'
import { useApplication } from '@/Components/ApplicationProvider'

/**
 * Standard Red Notes: the CollaborationID section of Preferences → Vaults,
 * extracted from Vaults.tsx and extended with:
 * - a QR code rendering of the CollaborationID for in-person pairing
 * - a "Regenerate" flow. The CollaborationID is derived from the account's
 *   asymmetric keypairs, which snjs only rotates during a credentials change
 *   (see SessionManager.changeCredentials → SessionEvent.UserKeyPairChanged →
 *   HandleKeyPairChange). There is no standalone rotation API, so the button
 *   explains the consequences and hands off to the existing password-change
 *   wizard rather than hacking a bespoke rotation path.
 */
const CollaborationIDSection = () => {
  const application = useApplication()
  const contactService = application.contacts

  const [isQRVisible, setIsQRVisible] = useState(false)
  const [shouldShowPasswordWizard, setShouldShowPasswordWizard] = useState(false)

  const isCollaborationEnabled = contactService.isCollaborationEnabled()
  const collaborationID = isCollaborationEnabled ? contactService.getCollaborationID() : undefined

  const copyCollaborationID = useCallback(async () => {
    if (!collaborationID) {
      return
    }
    try {
      await navigator.clipboard.writeText(collaborationID)
      addToast({
        type: ToastType.Success,
        message: 'Copied to clipboard',
      })
    } catch (error) {
      addToast({
        type: ToastType.Error,
        message: 'Failed to copy to clipboard',
      })
      console.error(error)
    }
  }, [collaborationID])

  const promptToRegenerate = useCallback(async () => {
    const confirmed = await application.alerts.confirmV2({
      title: 'Regenerate CollaborationID',
      text:
        'Your CollaborationID is derived from your account’s encryption and signing keys, so it cannot be' +
        ' regenerated on its own. These keys are rotated when you change your account password, which produces a' +
        ' new CollaborationID.' +
        '<br/><br/><strong>Before you continue, understand the consequences:</strong>' +
        '<br/>• Contacts who added you with your current CollaborationID still hold your old keys and may see' +
        ' you as unverified or untrusted until they re-verify you.' +
        '<br/>• You may need to share your new CollaborationID with them again.' +
        '<br/>• Pending invites to shared vaults you administer may need to be re-sent.' +
        '<br/><br/>To proceed, continue to the change-password flow.',
      confirmButtonText: 'Change Password…',
      confirmButtonType: ButtonType.Danger,
      cancelButtonText: 'Cancel',
    })

    if (confirmed) {
      setShouldShowPasswordWizard(true)
    }
  }, [application.alerts])

  const dismissPasswordWizard = useCallback(() => {
    setShouldShowPasswordWizard(false)
  }, [])

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>CollaborationID</Title>
        <Subtitle>Share your CollaborationID with collaborators to join their vaults.</Subtitle>
        {isCollaborationEnabled && collaborationID ? (
          <>
            <code className="border-border bg-contrast mt-2.5 overflow-hidden rounded border p-3 break-words whitespace-pre-wrap">
              {collaborationID}
            </code>
            {isQRVisible && (
              <div className="bg-info mt-3 flex w-fit items-center justify-center p-2">
                <QRCodeSVG
                  className="border-neutral-contrast border-2 border-solid"
                  value={collaborationID}
                  size={180}
                />
              </div>
            )}
            <div className="mt-2 flex flex-row flex-wrap gap-3">
              <Button label="Copy ID" onClick={copyCollaborationID} />
              <Button
                label={isQRVisible ? 'Hide QR Code' : 'Show QR Code'}
                onClick={() => setIsQRVisible((visible) => !visible)}
              />
              <Button label="Regenerate…" onClick={promptToRegenerate} />
            </div>
          </>
        ) : (
          <div className="mt-2.5 flex flex-row">
            <Button
              label="Enable Vault Sharing"
              className="mr-3 text-xs"
              onClick={() => contactService.enableCollaboration()}
            />
          </div>
        )}
      </PreferencesSegment>
      <ModalOverlay isOpen={shouldShowPasswordWizard} close={dismissPasswordWizard}>
        <PasswordWizard application={application} dismissModal={dismissPasswordWizard} />
      </ModalOverlay>
    </PreferencesGroup>
  )
}

export default observer(CollaborationIDSection)
