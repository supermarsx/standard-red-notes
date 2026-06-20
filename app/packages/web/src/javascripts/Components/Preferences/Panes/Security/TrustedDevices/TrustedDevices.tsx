import { FunctionComponent, useCallback, useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { isErrorResponse } from '@standardnotes/snjs'
import { ToastType, addToast } from '@standardnotes/toast'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '@/Components/Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import Spinner from '@/Components/Spinner/Spinner'
import { getTrustedDeviceToken, persistTrustedDeviceToken, clearTrustedDeviceToken } from './trustedDeviceStorage'

type Props = {
  application: WebApplication
}

type TrustedDevice = {
  uuid: string
  label: string
  createdAt: number
  lastUsedAt: number | null
  expiresAt: number
}

const formatDate = (value: number | null): string => {
  if (!value) {
    return 'Never'
  }
  const date = new Date(value)
  return isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString()
}

const deriveDeviceLabel = (): string => {
  const platform = (navigator as { platform?: string }).platform || 'Unknown platform'
  const ua = navigator.userAgent || ''
  let browser = 'Browser'
  if (ua.includes('Firefox')) {
    browser = 'Firefox'
  } else if (ua.includes('Edg')) {
    browser = 'Edge'
  } else if (ua.includes('Chrome')) {
    browser = 'Chrome'
  } else if (ua.includes('Safari')) {
    browser = 'Safari'
  }
  return `${browser} on ${platform}`
}

const TrustedDevices: FunctionComponent<Props> = ({ application }: Props) => {
  const [trustedDevices, setTrustedDevices] = useState<TrustedDevice[]>([])
  const [loading, setLoading] = useState(false)
  const [trusting, setTrusting] = useState(false)
  const [thisDeviceTrusted, setThisDeviceTrusted] = useState<boolean>(getTrustedDeviceToken() !== null)

  const loadTrustedDevices = useCallback(async () => {
    setLoading(true)
    try {
      const response = await application.legacyApi.listTrustedDevices()
      if (!isErrorResponse(response)) {
        const data = (response as { data?: { trustedDevices?: TrustedDevice[] } }).data
        setTrustedDevices(data?.trustedDevices ?? [])
      }
    } catch (error) {
      console.error(error)
    } finally {
      setLoading(false)
    }
  }, [application])

  useEffect(() => {
    void loadTrustedDevices()
  }, [loadTrustedDevices])

  const handleTrustThisDevice = useCallback(async () => {
    setTrusting(true)
    try {
      const response = await application.legacyApi.createTrustedDevice(deriveDeviceLabel())
      if (isErrorResponse(response)) {
        const data = response.data as { error?: { message?: string } } | undefined
        addToast({ type: ToastType.Error, message: data?.error?.message ?? 'Failed to trust this device.' })
        return
      }

      const device = (response as { data?: { trustedDevice?: { token?: string } } }).data?.trustedDevice
      if (device?.token) {
        // The plaintext token is shown exactly once. Persist it so future
        // sign-ins on this device can present it to skip the 2FA prompt.
        persistTrustedDeviceToken(device.token)
        setThisDeviceTrusted(true)
        addToast({ type: ToastType.Success, message: 'This device is now trusted for two-factor sign-in.' })
      }
      await loadTrustedDevices()
    } catch (error) {
      console.error(error)
      addToast({ type: ToastType.Error, message: 'Failed to trust this device.' })
    } finally {
      setTrusting(false)
    }
  }, [application, loadTrustedDevices])

  const handleRevoke = useCallback(
    async (deviceId: string) => {
      const confirmed = await application.alerts.confirm(
        'Revoke this trusted device? It will be required to complete two-factor authentication on its next sign-in.',
        'Revoke Trusted Device',
        'Revoke',
      )
      if (!confirmed) {
        return
      }

      try {
        const response = await application.legacyApi.deleteTrustedDevice(deviceId)
        if (isErrorResponse(response)) {
          addToast({ type: ToastType.Error, message: 'Failed to revoke trusted device.' })
          return
        }
        // If the user revoked the device they're currently on, clear the local
        // token so it stops bypassing the second factor here too.
        clearTrustedDeviceToken()
        setThisDeviceTrusted(false)
        await loadTrustedDevices()
      } catch (error) {
        console.error(error)
        addToast({ type: ToastType.Error, message: 'Failed to revoke trusted device.' })
      }
    },
    [application, loadTrustedDevices],
  )

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>Trusted Devices</Title>
        <Text>
          A trusted device can skip the interactive two-factor (authenticator) prompt on future sign-ins, within a
          time-limited trust window. Trust only ever bypasses the second factor — your account password is still
          required every time, and it never unlocks your encrypted data on its own.
        </Text>
        <Text className="mt-2">
          Revoke a device to immediately require two-factor again on its next sign-in. Trust also expires
          automatically after the server-configured period.
        </Text>
      </PreferencesSegment>

      <HorizontalSeparator classes="my-4" />

      <PreferencesSegment>
        <Subtitle>This device</Subtitle>
        {thisDeviceTrusted ? (
          <Text className="mt-2">This device is trusted. It can skip the two-factor prompt until trust expires.</Text>
        ) : (
          <>
            <Text className="mt-2">
              Mark this device as trusted to skip the two-factor prompt on future sign-ins from this browser.
            </Text>
            <Button className="mt-3" label="Trust this device" primary disabled={trusting} onClick={handleTrustThisDevice} />
          </>
        )}
      </PreferencesSegment>

      <HorizontalSeparator classes="my-4" />

      <PreferencesSegment>
        <Subtitle>Your trusted devices</Subtitle>
        {loading && <Spinner className="mt-2 h-4 w-4" />}
        {!loading && trustedDevices.length === 0 && <Text className="mt-2">You have no trusted devices.</Text>}
        {!loading &&
          trustedDevices.map((device) => (
            <div
              key={device.uuid}
              className="mt-2 flex flex-row items-center justify-between rounded border border-solid border-border p-3"
            >
              <div className="flex flex-col">
                <span className="text-base font-medium lg:text-sm">{device.label}</span>
                <span className="text-sm text-passive-0 lg:text-xs">
                  Trusted {formatDate(device.createdAt)} · Last used {formatDate(device.lastUsedAt)} · Expires{' '}
                  {formatDate(device.expiresAt)}
                </span>
              </div>
              <Button label="Revoke" onClick={() => handleRevoke(device.uuid)} />
            </div>
          ))}
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default observer(TrustedDevices)
