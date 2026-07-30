import { FunctionComponent, useCallback, useEffect, useState } from 'react'
import { WebApplication } from '@/Application/WebApplication'
import { ProtectedIllustration } from '@standardnotes/icons'
import Button from '@/Components/Button/Button'
import ModalOverlay from '@/Components/Modal/ModalOverlay'
import Modal from '@/Components/Modal/Modal'
import { classNames } from '@standardnotes/utils'
import { MutuallyExclusiveMediaQueryBreakpoints, useMediaQuery } from '@/Hooks/useMediaQuery'
import {
  authenticateAppLockPasskey,
  disableAppLockPasskeyAfterVerifiedPasscode,
} from '@/AppLockPasskey/appLockPasskeyService'

type Props = {
  application: WebApplication
  /** Called when the passkey assertion succeeds; the caller should grant unlock. */
  onUnlocked: () => void
}

/**
 * Local passkey unlock screen.
 *
 * Shown after the existing local unlock (passcode/biometric) has been satisfied,
 * when an app-lock passkey is registered on this device. Running a successful
 * WebAuthn assertion calls `onUnlocked`, which the parent uses to grant access
 * through the SAME gate (`needsUnlock === false`) the other unlock methods use.
 *
 * SECURITY SCOPE: this is a LOCAL ACCESS GATE — it gates the app UI on this
 * device. It does not decrypt data and does not affect the E2E encryption keys.
 *
 * Cancellation / failure keeps the app locked and shows a retry. Because the
 * passcode has already been verified before this screen is mounted, it can also
 * be used as a recovery factor to disable an unavailable passkey.
 */
const AppLockPasskeyScreen: FunctionComponent<Props> = ({ application, onUnlocked }) => {
  const [isAuthenticating, setIsAuthenticating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isMobileScreen = useMediaQuery(MutuallyExclusiveMediaQueryBreakpoints.sm)

  const attempt = useCallback(async () => {
    setIsAuthenticating(true)
    setError(null)
    try {
      const success = await authenticateAppLockPasskey(application)
      if (success) {
        onUnlocked()
      } else {
        setError('Passkey verification was cancelled or failed. Please try again.')
      }
    } finally {
      setIsAuthenticating(false)
    }
  }, [application, onUnlocked])

  const useVerifiedPasscode = useCallback(async () => {
    const confirmed = await application.alerts.confirm(
      'Use your verified app passcode and disable the passkey lock on this device?',
      'Use passcode instead?',
      'Use passcode',
    )
    if (!confirmed) {
      return
    }

    setIsAuthenticating(true)
    setError(null)
    try {
      const disabled = await disableAppLockPasskeyAfterVerifiedPasscode(application)
      if (disabled) {
        onUnlocked()
      } else {
        setError('The passkey lock could not be disabled. Lock and unlock the app with your passcode, then try again.')
      }
    } catch (error) {
      console.error('Unable to disable app-lock passkey after passcode verification', error)
      setError('The passkey lock could not be disabled. Please try again.')
    } finally {
      setIsAuthenticating(false)
    }
  }, [application, onUnlocked])

  // Auto-prompt once on mount so the OS passkey dialog appears immediately.
  useEffect(() => {
    void attempt()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <ModalOverlay
      isOpen={true}
      close={() => {}}
      hideOnInteractOutside={false}
      backdropClassName="bg-passive-5"
      className={classNames(
        'sn-component challenge-modal border-border bg-default relative m-0 flex h-full w-full flex-col items-center rounded border-solid p-0 md:h-auto md:!w-max',
        !isMobileScreen && 'shadow-overlay-light',
      )}
    >
      <Modal title="Unlock with passkey" close={() => {}} customHeader={<></>} customFooter={<></>}>
        <div className="flex min-h-0 w-full flex-grow flex-col items-center overflow-auto p-8">
          <ProtectedIllustration className="mb-4 h-30 w-30 flex-shrink-0" />
          <div className="mb-3 max-w-76 text-center text-lg font-bold">Unlock with passkey</div>
          <div className="break-word mb-4 max-w-76 text-center text-sm">
            Verify with your passkey to unlock this app on this device.
          </div>
          {error && <div className="text-danger mb-3 max-w-76 text-center text-sm">{error}</div>}
          <Button primary disabled={isAuthenticating} className="mb-2 min-w-76" onClick={() => void attempt()}>
            {isAuthenticating ? 'Waiting for passkey…' : 'Unlock with passkey'}
          </Button>
          <Button disabled={isAuthenticating} className="min-w-76" onClick={() => void useVerifiedPasscode()}>
            Use verified passcode instead
          </Button>
        </div>
      </Modal>
    </ModalOverlay>
  )
}

export default AppLockPasskeyScreen
