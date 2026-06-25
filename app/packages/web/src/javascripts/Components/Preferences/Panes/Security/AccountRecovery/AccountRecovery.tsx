import { FunctionComponent, useCallback, useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { ToastType, addToast } from '@standardnotes/toast'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '@/Components/Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import Spinner from '@/Components/Spinner/Spinner'
import CopyButton from '../TwoFactorAuth/CopyButton'
import { achievements, METRICS } from '@/Achievements'

type Props = {
  application: WebApplication
}

const downloadRecoveryCode = (identifier: string, recoveryCode: string) => {
  const contents = [
    'Standard Red Notes — Account Recovery Code',
    '',
    `Account: ${identifier}`,
    `Recovery code: ${recoveryCode}`,
    '',
    'KEEP THIS SECRET AND SAFE. Anyone with this code AND access to your account',
    'escrow on the server can recover (and therefore read) your encrypted data.',
    'Without this code, the escrow on the server cannot be decrypted — not even by',
    'the server operator. Store it offline, separate from your password.',
    '',
    'To recover: use the "Recover account" flow and supply this exact code.',
  ].join('\n')

  const blob = new Blob([contents], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'standard-red-notes-recovery-code.txt'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

const AccountRecovery: FunctionComponent<Props> = ({ application }: Props) => {
  const [loading, setLoading] = useState(true)
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [identifier, setIdentifier] = useState('')
  // The one-time recovery code, shown only immediately after enabling.
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null)

  const refreshStatus = useCallback(async () => {
    setLoading(true)
    try {
      const result = await application.getAccountRecoveryStatus.execute()
      if (!result.isFailed()) {
        setEnabled(result.getValue())
      }
      setIdentifier(application.sessions.getUser()?.email ?? '')
    } finally {
      setLoading(false)
    }
  }, [application])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  const handleEnable = useCallback(async () => {
    // Explicit, unmistakable warning + confirm before any escrow is created.
    const confirmed = await application.alerts.confirm(
      'Enabling account recovery will store recovery key material for your account ON THE SERVER. ' +
        'This WEAKENS the end-to-end encryption guarantee for this account: the escrow is encrypted with a ' +
        'recovery code shown to you only once, but anyone who obtains BOTH the server-side escrow AND your ' +
        'recovery code could decrypt and read your notes. Standard Notes normally makes forgotten passwords ' +
        'unrecoverable BY DESIGN; this opt-in trades some of that protection for recoverability.\n\n' +
        'You must save the recovery code that follows — it is shown ONCE and never sent to the server. ' +
        'Without it, recovery is impossible.\n\nDo you understand and want to enable account recovery?',
      'Enable account recovery?',
      'I understand, enable it',
    )
    if (!confirmed) {
      return
    }

    const password = await application.challenges.promptForAccountPassword()
    if (!password) {
      return
    }

    setBusy(true)
    try {
      const result = await application.enableAccountRecovery.execute({ password })
      if (result.isFailed()) {
        addToast({ type: ToastType.Error, message: result.getError() })
        return
      }
      setRecoveryCode(result.getValue())
      setEnabled(true)
      achievements.markEvent(METRICS.recoveryMethodAdded)
      addToast({ type: ToastType.Success, message: 'Account recovery enabled. Save your recovery code now.' })
    } catch (error) {
      addToast({ type: ToastType.Error, message: `Failed to enable account recovery: ${(error as Error).message}` })
    } finally {
      setBusy(false)
    }
  }, [application])

  const handleDisable = useCallback(async () => {
    const confirmed = await application.alerts.confirm(
      'Disabling account recovery will permanently delete the recovery material escrowed on the server. ' +
        'Any previously shown recovery code will no longer work. Your account will return to the standard ' +
        'end-to-end guarantee (a forgotten password becomes unrecoverable). Continue?',
      'Disable account recovery?',
      'Disable and delete escrow',
    )
    if (!confirmed) {
      return
    }

    setBusy(true)
    try {
      const result = await application.disableAccountRecovery.execute()
      if (result.isFailed()) {
        addToast({ type: ToastType.Error, message: result.getError() })
        return
      }
      setEnabled(false)
      setRecoveryCode(null)
      addToast({ type: ToastType.Success, message: 'Account recovery disabled and escrow deleted.' })
    } catch (error) {
      addToast({ type: ToastType.Error, message: `Failed to disable account recovery: ${(error as Error).message}` })
    } finally {
      setBusy(false)
    }
  }, [application])

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>Account recovery</Title>
        <Text>
          By default, Standard Red Notes is end-to-end encrypted: your account password derives the key that protects
          your notes, and if you forget it, your data is unrecoverable by design. Account recovery is an{' '}
          <strong>optional, off-by-default</strong> escape hatch that escrows recovery key material so you can regain
          access if you forget your password.
        </Text>

        <div className="mt-4 rounded border border-solid border-warning bg-warning-faded p-3">
          <Subtitle className="text-warning">Enabling this weakens your end-to-end encryption</Subtitle>
          <Text className="mt-1">
            When enabled, the client encrypts your account key under a one-time recovery code and stores the resulting
            ciphertext on the server. The server stores <strong>ciphertext only</strong> and cannot decrypt it without
            your recovery code — but anyone who obtains both the server-side escrow and your recovery code could read
            your notes. This is a meaningful reduction of the end-to-end guarantee. Leave this disabled unless you
            understand and accept that tradeoff.
          </Text>
        </div>
      </PreferencesSegment>

      <HorizontalSeparator classes="my-4" />

      <PreferencesSegment>
        {loading && <Spinner className="mt-2 h-4 w-4" />}

        {!loading && !enabled && (
          <>
            <Subtitle>Account recovery is disabled</Subtitle>
            <Text className="mb-3">
              No recovery material is stored on the server for your account. This is the default and most private state.
            </Text>
            <Button label="Enable account recovery" disabled={busy} onClick={handleEnable} />
          </>
        )}

        {!loading && enabled && !recoveryCode && (
          <>
            <Subtitle>Account recovery is enabled</Subtitle>
            <Text className="mb-3">
              Recovery key material is currently escrowed on the server for your account. You can recover access using
              your one-time recovery code via the &ldquo;Recover account&rdquo; flow on the sign-in screen. Disable this
              to delete the escrow and restore the standard end-to-end guarantee.
            </Text>
            <Button label="Disable and delete escrow" disabled={busy} onClick={handleDisable} />
          </>
        )}

        {recoveryCode && (
          <div className="mt-1 rounded border border-solid border-border p-3">
            <Subtitle>Save your recovery code now — it is shown only once</Subtitle>
            <Text className="mb-2">
              This code is never sent to the server. Store it offline, separate from your password. You will need it to
              recover your account.
            </Text>
            <div className="flex flex-row items-center gap-2">
              <code className="select-text break-all rounded bg-contrast px-2 py-1 text-sm">{recoveryCode}</code>
              <CopyButton copyValue={recoveryCode} successMessage="Recovery code copied to clipboard" />
            </div>
            <div className="mt-3 flex flex-row gap-2">
              <Button label="Download" onClick={() => downloadRecoveryCode(identifier, recoveryCode)} />
              <Button
                primary
                label="I have saved it"
                onClick={() => {
                  setRecoveryCode(null)
                }}
              />
            </div>
          </div>
        )}
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default observer(AccountRecovery)
