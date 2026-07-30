import { FunctionComponent, useCallback, useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { ToastType, addToast } from '@standardnotes/toast'
import { AccountRecoveryStatus } from '@standardnotes/snjs'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '@/Components/Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import Spinner from '@/Components/Spinner/Spinner'
import DecoratedPasswordInput from '@/Components/Input/DecoratedPasswordInput'
import Checkbox from '@/Components/Checkbox/Checkbox'

type Props = {
  application: WebApplication
}

const AccountRecovery: FunctionComponent<Props> = ({ application }: Props) => {
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<AccountRecoveryStatus>('disabled')
  const [busy, setBusy] = useState(false)
  const [password, setPassword] = useState('')
  const [oneTimeCode, setOneTimeCode] = useState('')
  const [confirmedSaved, setConfirmedSaved] = useState(false)

  const refreshStatus = useCallback(async () => {
    setLoading(true)
    try {
      const result = await application.getAccountRecoveryStatus.execute()
      if (result.isFailed()) {
        addToast({ type: ToastType.Error, message: result.getError() })
      } else {
        setStatus(result.getValue())
      }
    } finally {
      setLoading(false)
    }
  }, [application])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  const handleEnableOrRotate = useCallback(async () => {
    if (!password) {
      addToast({ type: ToastType.Error, message: 'Enter your current account password.' })
      return
    }

    setBusy(true)
    try {
      const result = await application.enableAccountRecovery.execute({ password })
      if (result.isFailed()) {
        addToast({ type: ToastType.Error, message: result.getError() })
        return
      }
      setStatus('enabled')
      setPassword('')
      setConfirmedSaved(false)
      setOneTimeCode(result.getValue())
    } catch {
      addToast({ type: ToastType.Error, message: 'Account recovery could not be enabled.' })
    } finally {
      setBusy(false)
    }
  }, [application, password])

  const handleDisable = useCallback(async () => {
    if (!password) {
      addToast({ type: ToastType.Error, message: 'Enter your current account password.' })
      return
    }
    const confirmed = await application.alerts.confirm(
      'This permanently deletes the recovery escrow stored on the server. Every previously issued account recovery code will stop working.',
      status === 'legacy' ? 'Delete legacy recovery escrow?' : 'Disable account recovery?',
      status === 'legacy' ? 'Delete legacy escrow' : 'Disable recovery',
    )
    if (!confirmed) {
      return
    }

    setBusy(true)
    try {
      const result = await application.disableAccountRecovery.execute({ password })
      if (result.isFailed()) {
        addToast({ type: ToastType.Error, message: result.getError() })
        return
      }
      setStatus('disabled')
      setPassword('')
      setOneTimeCode('')
      addToast({ type: ToastType.Success, message: 'Account recovery disabled.' })
    } catch {
      addToast({ type: ToastType.Error, message: 'Account recovery could not be disabled.' })
    } finally {
      setBusy(false)
    }
  }, [application, password, status])

  const copyCode = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(oneTimeCode)
      addToast({ type: ToastType.Success, message: 'Account recovery code copied.' })
    } catch {
      addToast({
        type: ToastType.Error,
        message: 'The recovery code could not be copied. Select it and save it manually.',
      })
    }
  }, [oneTimeCode])

  if (oneTimeCode) {
    return (
      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Save your new account recovery code</Title>
          <div className="border-warning bg-warning-faded mt-3 rounded border border-solid p-3">
            <Subtitle className="text-warning">This code is shown once</Subtitle>
            <Text className="mt-1">
              Save it in a secure password manager or offline location. The code can decrypt your account keys. MFA
              remains required for server sign-in, but it does not make a copied recovery code safe. Protect both this
              code and the computer where you use it.
            </Text>
          </div>
          <textarea
            className="border-border bg-default mt-3 min-h-24 w-full resize-y rounded border border-solid p-3 font-mono text-sm"
            readOnly
            value={oneTimeCode}
            aria-label="New account recovery code"
          />
          <Button className="mt-2" label="Copy recovery code" onClick={() => void copyCode()} />
          <div className="mt-3">
            <Checkbox
              name="account-recovery-code-saved"
              label="I saved this recovery code somewhere secure"
              checked={confirmedSaved}
              onChange={() => setConfirmedSaved((value) => !value)}
            />
          </div>
          <Button
            className="mt-3"
            primary
            label="Finish"
            disabled={!confirmedSaved}
            onClick={() => setOneTimeCode('')}
          />
        </PreferencesSegment>
      </PreferencesGroup>
    )
  }

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>Account recovery</Title>
        <Text>
          Account recovery is optional and off by default. When enabled, the server stores only client-encrypted
          recovery escrow. Your recovery code is the only key to that escrow and is never sent to the server.
        </Text>
        <div className="border-warning bg-warning-faded mt-4 rounded border border-solid p-3">
          <Subtitle className="text-warning">Understand the tradeoff</Subtitle>
          <Text className="mt-1">
            Anyone who obtains your code can retrieve and decrypt the escrowed account keys. MFA still protects server
            sign-in, but cannot protect a copied code from offline decryption. Keep independent, tested backups too.
          </Text>
        </div>
      </PreferencesSegment>

      <HorizontalSeparator classes="my-4" />

      <PreferencesSegment>
        {loading && <Spinner className="mt-2 h-4 w-4" />}

        {!loading && status === 'legacy' && (
          <>
            <Subtitle className="text-warning">Legacy recovery escrow found</Subtitle>
            <Text className="mb-3">
              This older format cannot be used by the current recovery flow. It can only be deleted. Deleting it does
              not affect your notes or password.
            </Text>
            <DecoratedPasswordInput
              className={{ container: 'mb-3' }}
              value={password}
              onChange={setPassword}
              placeholder="Current account password"
              disabled={busy}
            />
            <Button label="Delete legacy escrow" disabled={busy || !password} onClick={() => void handleDisable()} />
          </>
        )}

        {!loading && status !== 'legacy' && (
          <>
            <Subtitle>{status === 'enabled' ? 'Account recovery is enabled' : 'Account recovery is disabled'}</Subtitle>
            <Text className="mb-3">
              {status === 'enabled'
                ? 'Replacing the code immediately invalidates the previous code.'
                : 'Enter your current account password to create a one-time recovery code.'}
            </Text>
            <DecoratedPasswordInput
              className={{ container: 'mb-3' }}
              value={password}
              onChange={setPassword}
              placeholder="Current account password"
              disabled={busy}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                primary
                label={status === 'enabled' ? 'Replace recovery code' : 'Enable account recovery'}
                disabled={busy || !password}
                onClick={() => void handleEnableOrRotate()}
              />
              {status === 'enabled' && (
                <Button label="Disable account recovery" disabled={busy} onClick={() => void handleDisable()} />
              )}
            </div>
          </>
        )}
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default observer(AccountRecovery)
