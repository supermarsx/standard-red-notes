import { useCallback, useRef, useState } from 'react'
import { WebApplication } from '@/Application/WebApplication'
import { observer } from 'mobx-react-lite'
import Button from '@/Components/Button/Button'
import Icon from '../Icon/Icon'
import AlertDialog from '../AlertDialog/AlertDialog'

type Props = {
  application: WebApplication
}

const ConfirmOtherSessionsSignOut = observer(({ application }: Props) => {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [isRevoking, setIsRevoking] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string>()

  const closeDialog = useCallback(() => {
    application.accountMenuController.setOtherSessionsSignOut(false)
  }, [application])

  const dismissDialog = useCallback(() => {
    if (!isRevoking) {
      closeDialog()
    }
  }, [closeDialog, isRevoking])

  const confirm = useCallback(async () => {
    setErrorMessage(undefined)
    setIsRevoking(true)

    try {
      const result = await application.revokeAllOtherSessions()

      if (result.failures.length > 0) {
        const requestedCount = result.requestedSessionIds.length
        const revokedCount = result.revokedSessionIds.length
        const failedCount = result.failures.length
        const sessionLabel = failedCount === 1 ? 'session' : 'sessions'

        setErrorMessage(
          revokedCount === 0
            ? `No other sessions were ended. ${failedCount} of ${requestedCount} ${sessionLabel} could not be ended. Please try again.`
            : `${revokedCount} of ${requestedCount} other sessions were ended. ${failedCount} ${sessionLabel} could not be ended. Please try again.`,
        )
        setIsRevoking(false)
        return
      }

      setIsRevoking(false)
      closeDialog()
      const successMessage =
        result.requestedSessionIds.length === 0
          ? 'There were no other active sessions to end.'
          : 'You have successfully ended your sessions on other devices.'
      application.alerts.alert(successMessage, undefined, 'Finish').catch(console.error)
    } catch (error) {
      setErrorMessage(
        error instanceof Error && error.message
          ? `Other sessions could not be ended: ${error.message}`
          : 'Other sessions could not be ended. Please try again.',
      )
      setIsRevoking(false)
    }
  }, [application, closeDialog])

  return (
    <AlertDialog closeDialog={dismissDialog}>
      <div className="flex items-center justify-between text-lg font-bold capitalize">
        End all other sessions?
        <button
          aria-label="Close"
          className="hover:bg-contrast rounded p-1 font-bold"
          disabled={isRevoking}
          onClick={dismissDialog}
        >
          <Icon type="close" />
        </button>
      </div>
      <div className="sk-panel-row">
        <p className="text-foreground text-base lg:text-sm">
          This action will sign out all other devices signed into your account, and remove your data from those devices
          when they next regain connection to the internet. You may sign back in on those devices at any time.
        </p>
      </div>
      {errorMessage && (
        <p className="text-danger mt-3 text-sm" role="alert">
          {errorMessage}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button ref={cancelRef} disabled={isRevoking} onClick={dismissDialog}>
          Cancel
        </Button>
        <Button primary colorStyle="danger" disabled={isRevoking} onClick={confirm}>
          {isRevoking ? 'Ending Sessions…' : 'End Sessions'}
        </Button>
      </div>
    </AlertDialog>
  )
})

ConfirmOtherSessionsSignOut.displayName = 'ConfirmOtherSessionsSignOut'

const OtherSessionsSignOutContainer = (props: Props) => {
  if (!props.application.accountMenuController.otherSessionsSignOut) {
    return null
  }
  return <ConfirmOtherSessionsSignOut {...props} />
}

export default observer(OtherSessionsSignOutContainer)
