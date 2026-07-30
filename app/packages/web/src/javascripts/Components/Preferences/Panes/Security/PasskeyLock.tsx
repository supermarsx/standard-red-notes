import { observer } from 'mobx-react-lite'
import { useCallback, useEffect, useState } from 'react'
import { WebApplication } from '@/Application/WebApplication'
import { Title, Text } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '@/Components/Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import Button from '@/Components/Button/Button'
import { addToast, ToastType } from '@standardnotes/toast'
import { ApplicationEvent } from '@standardnotes/snjs'
import {
  getAppLockPasskeyCredential,
  hasAppLockPasscodeFallback,
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
  const [hasPasscodeFallback, setHasPasscodeFallback] = useState(() => hasAppLockPasscodeFallback(application))
  const [isRegistering, setIsRegistering] = useState(false)

  const refresh = useCallback(() => {
    setHasPasskey(getAppLockPasskeyCredential(application) !== null)
    setHasPasscodeFallback(hasAppLockPasscodeFallback(application))
  }, [application])

  useEffect(() => {
    refresh()
    return application.addEventObserver(async () => refresh(), ApplicationEvent.KeyStatusChanged)
  }, [application, refresh])

  const onRegister = useCallback(async () => {
    if (!hasAppLockPasscodeFallback(application)) {
      addToast({
        type: ToastType.Error,
        message: 'Set an app passcode before registering a passkey so you keep a recovery method.',
      })
      return
    }

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
          keys. Your app passcode remains the recovery method if the passkey becomes unavailable.
        </Text>

        {!hasPasskey && (
          <>
            {!hasPasscodeFallback && (
              <Text className="text-warning mb-3">
                Set an app passcode first. Passkey lock is not enabled without a separate recovery method.
              </Text>
            )}
            <Button
              label={isRegistering ? 'Waiting for passkey…' : 'Register passkey'}
              disabled={isRegistering || !hasPasscodeFallback}
              onClick={onRegister}
              primary
            />
          </>
        )}

        {hasPasskey && (
          <>
            <Text className="mb-3">
              {hasPasscodeFallback
                ? 'A passkey is registered. You can use it to unlock the app on this device.'
                : 'A passkey credential is stored but inactive because no recovery passcode is set.'}
            </Text>
            <Button colorStyle="danger" label="Remove passkey" onClick={onRemove} />
          </>
        )}
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default observer(PasskeyLock)
