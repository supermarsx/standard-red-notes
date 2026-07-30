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

type Props = {
  application: WebApplication
}

/**
 * The repository currently contains only the cryptographic escrow substrate. It
 * has no verified logged-out retrieval, restricted recovery session, credential
 * rotation, or sign-in flow. New enrollment must therefore remain fail-closed.
 *
 * Keep the status/disable path available so accounts that enabled the old
 * experimental UI can remove their server-side escrow.
 */
const AccountRecovery: FunctionComponent<Props> = ({ application }: Props) => {
  const [loading, setLoading] = useState(true)
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)

  const refreshStatus = useCallback(async () => {
    setLoading(true)
    try {
      const result = await application.getAccountRecoveryStatus.execute()
      if (!result.isFailed()) {
        setEnabled(result.getValue())
      }
    } finally {
      setLoading(false)
    }
  }, [application])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  const handleDisable = useCallback(async () => {
    const confirmed = await application.alerts.confirm(
      'This will permanently delete the experimental recovery escrow stored on the server. ' +
        'Any previously issued recovery code will stop working. Continue?',
      'Delete experimental recovery escrow?',
      'Delete escrow',
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
      addToast({ type: ToastType.Success, message: 'Experimental recovery escrow deleted.' })
    } catch (error) {
      addToast({ type: ToastType.Error, message: `Failed to delete recovery escrow: ${(error as Error).message}` })
    } finally {
      setBusy(false)
    }
  }, [application])

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>Account recovery</Title>
        <Text>
          Forgotten-password recovery is not available. Standard Red Notes cannot reset your password or decrypt your
          notes, so keep your password and independently usable backups safe.
        </Text>

        <div className="border-warning bg-warning-faded mt-4 rounded border border-solid p-3">
          <Subtitle className="text-warning">Experimental escrow enrollment is disabled</Subtitle>
          <Text className="mt-1">
            This source tree contains cryptographic escrow primitives, but it does not contain a verified logged-out
            retrieval, credential-rotation, and sign-in flow. Enabling escrow would weaken the normal end-to-end
            guarantee without providing a dependable recovery path, so new enrollment is blocked.
          </Text>
        </div>
      </PreferencesSegment>

      <HorizontalSeparator classes="my-4" />

      <PreferencesSegment>
        {loading && <Spinner className="mt-2 h-4 w-4" />}

        {!loading && !enabled && (
          <>
            <Subtitle>No recovery escrow is stored</Subtitle>
            <Text>This is the default and most private state. New recovery enrollment is unavailable.</Text>
          </>
        )}

        {!loading && enabled && (
          <>
            <Subtitle className="text-danger">Incomplete recovery escrow is enabled</Subtitle>
            <Text className="mb-3">
              This escrow does not provide a working forgotten-password recovery flow. Delete it to restore the normal
              end-to-end guarantee. Keep any independent backups until you have verified they can be restored.
            </Text>
            <Button label="Delete experimental escrow" disabled={busy} onClick={handleDisable} />
          </>
        )}
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default observer(AccountRecovery)
