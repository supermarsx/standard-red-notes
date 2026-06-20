import { FunctionComponent, useCallback, useState } from 'react'
import { observer } from 'mobx-react-lite'
import {
  readSharedServerAccessKey,
  persistSharedServerAccessKey,
  clearSharedServerAccessKey,
} from '@standardnotes/snjs'
import { ToastType, addToast } from '@standardnotes/toast'

import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '@/Components/Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import DecoratedInput from '@/Components/Input/DecoratedInput'

/**
 * Standard Red Notes: lets the user enter a server-wide shared access key.
 *
 * This is an instance-level OBFUSCATION key provided by the self-hosted server
 * operator — NOT your account password and NOT end-to-end security. It only lets
 * this device pass an optional gateway gate that makes the server refuse clients
 * that do not present it. The key is stored locally on this device (localStorage,
 * never synced) and attached as a header on outgoing requests.
 */
const ServerAccessKey: FunctionComponent = () => {
  const [value, setValue] = useState<string>(() => readSharedServerAccessKey() ?? '')
  const [savedKeyPresent, setSavedKeyPresent] = useState<boolean>(() => (readSharedServerAccessKey() ?? '') !== '')

  const handleSave = useCallback(() => {
    const trimmed = value.trim()
    if (trimmed.length === 0) {
      clearSharedServerAccessKey()
      setSavedKeyPresent(false)
      addToast({ type: ToastType.Success, message: 'Server access key cleared on this device.' })
      return
    }

    persistSharedServerAccessKey(trimmed)
    setValue(trimmed)
    setSavedKeyPresent(true)
    addToast({
      type: ToastType.Success,
      message: 'Server access key saved on this device. New requests will include it.',
    })
  }, [value])

  const handleClear = useCallback(() => {
    clearSharedServerAccessKey()
    setValue('')
    setSavedKeyPresent(false)
    addToast({ type: ToastType.Success, message: 'Server access key cleared on this device.' })
  }, [])

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>Server Access Key</Title>
        <Text>
          Some self-hosted servers require a shared <span className="font-semibold">server access key</span> before they
          will respond to a client. If your server operator gave you one, enter it here so this device can reach the
          server.
        </Text>
        <Text className="mt-2">
          This is an instance-level obfuscation key set by the server operator — it is{' '}
          <span className="font-semibold">not</span> your account password, and it does{' '}
          <span className="font-semibold">not</span> provide end-to-end security. Your note content is still protected by
          end-to-end encryption regardless of this setting. The key is stored only on this device (it is never synced)
          and is sent as a header with your requests.
        </Text>
      </PreferencesSegment>

      <HorizontalSeparator classes="my-4" />

      <PreferencesSegment>
        <Subtitle>Key for this device</Subtitle>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
          <DecoratedInput
            className={{ container: 'min-w-0 flex-grow' }}
            type="password"
            placeholder="Enter the server access key"
            value={value}
            onChange={(newValue) => setValue(newValue)}
          />
          <Button className="flex-shrink-0" label="Save" primary onClick={handleSave} />
          {savedKeyPresent && <Button className="flex-shrink-0" label="Clear" onClick={handleClear} />}
        </div>
        {savedKeyPresent ? (
          <Text className="mt-2">A server access key is configured on this device and is sent with each request.</Text>
        ) : (
          <Text className="mt-2">
            No server access key is configured. Leave this blank if your server does not require one.
          </Text>
        )}
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default observer(ServerAccessKey)
