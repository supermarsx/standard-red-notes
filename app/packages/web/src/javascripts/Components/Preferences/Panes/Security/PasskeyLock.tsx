import { observer } from 'mobx-react-lite'
import { useCallback, useEffect, useState } from 'react'
import { WebApplication } from '@/Application/WebApplication'
import { Title, Text } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '@/Components/Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import Button from '@/Components/Button/Button'
import { addToast, ToastType } from '@standardnotes/toast'
import {
  getAppLockPasskeyCredential,
  isAppLockPasskeySupported,
  registerAppLockPasskey,
  removeAppLockPasskey,
} from '@/AppLockPasskey/appLockPasskeyService'

type Props = {
  application: WebApplication
}

/**
 * Security → "Unlock with passkey".
 *
 * Registers / removes a *local* platform passkey that gates UNLOCK of the app on
 * this device, in addition to the passcode lock. This is a LOCAL ACCESS GATE: a
 * successful passkey assertion grants local UI unlock, exactly like entering the
 * passcode does. It does NOT change the end-to-end encryption keys (those still
 * derive from the account password / local passcode) and it does not, on its own,
 * decrypt any data. Removing it simply disables passkey unlock; the passcode (if
 * set) remains in force as the fallback.
 */
const PasskeyLock = ({ application }: Props) => {
  const supported = isAppLockPasskeySupported(application)
  const [hasPasskey, setHasPasskey] = useState(() => getAppLockPasskeyCredential(application) !== null)
  const [isRegistering, setIsRegistering] = useState(false)

  const refresh = useCallback(() => {
    setHasPasskey(getAppLockPasskeyCredential(application) !== null)
  }, [application])

  useEffect(() => {
    refresh()
  }, [refresh])

  const onRegister = useCallback(async () => {
    setIsRegistering(true)
    try {
      const credential = await registerAppLockPasskey(application)
      if (credential) {
        refresh()
        addToast({
          type: ToastType.Success,
          message: 'Passkey registered. You can now unlock the app with your passkey.',
        })
      } else {
        addToast({
          type: ToastType.Error,
          message: 'Passkey registration was cancelled or failed.',
        })
      }
    } finally {
      setIsRegistering(false)
    }
  }, [application, refresh])

  const onRemove = useCallback(async () => {
    const confirmed = await application.alerts.confirm(
      'Remove the passkey used to unlock this app on this device? You will still be able to unlock with your passcode.',
      'Remove passkey?',
      'Remove passkey',
    )
    if (!confirmed) {
      return
    }
    await removeAppLockPasskey(application)
    refresh()
    addToast({
      type: ToastType.Success,
      message: 'Passkey removed.',
    })
  }, [application, refresh])

  if (!supported) {
    return null
  }

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>Unlock with passkey</Title>
        <Text className="mb-3">
          Register a passkey (Touch ID, Windows Hello, or a security key) to unlock this app on this device. This is a
          local access gate only: it controls access to the app UI on this device and does not change your encryption
          keys, which still come from your account password{application.hasPasscode() ? ' and passcode' : ''}.
        </Text>

        {!hasPasskey && (
          <Button
            label={isRegistering ? 'Waiting for passkey…' : 'Register passkey'}
            disabled={isRegistering}
            onClick={onRegister}
            primary
          />
        )}

        {hasPasskey && (
          <>
            <Text className="mb-3">A passkey is registered. You can use it to unlock the app on this device.</Text>
            <Button colorStyle="danger" label="Remove passkey" onClick={onRemove} />
          </>
        )}
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default observer(PasskeyLock)
