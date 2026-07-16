import { WebApplication } from '@/Application/WebApplication'
import { addToast, ToastType } from '@standardnotes/toast'
import { useState } from 'react'

import Button from '../Button/Button'
import Icon from '../Icon/Icon'
import StyledTooltip from '../StyledTooltip/StyledTooltip'

const RecoveryCodeBanner = ({ application }: { application: WebApplication }) => {
  const [recoveryCode, setRecoveryCode] = useState<string>()
  const [errorMessage, setErrorMessage] = useState<string>()

  const onClickShow = async () => {
    const password = await application.challenges.promptForAccountPassword()

    if (!password) {
      return
    }

    const recoveryCodeOrError = await application.getRecoveryCodes.execute({ password })
    if (recoveryCodeOrError.isFailed()) {
      setErrorMessage(recoveryCodeOrError.getError())
      return
    }

    setRecoveryCode(recoveryCodeOrError.getValue())
  }

  return (
    <div className="border-border grid grid-cols-1 rounded-md border p-4">
      <div className="flex items-center">
        <Icon className="text-info group-disabled:text-passive-2 mr-1 -ml-1 h-5 w-5" type="asterisk" />
        <h1 className="sk-h3 m-0 text-sm font-semibold">Save your recovery code</h1>
      </div>
      <p className="col-start-1 col-end-3 m-0 mt-1 text-sm">
        Your recovery code allows you access to your account in the event you lose your 2FA authenticating device or
        app. Save your recovery code in a safe place outside your account.
      </p>
      {errorMessage && <div>{errorMessage}</div>}
      {!recoveryCode && (
        <Button primary small className="col-start-1 col-end-3 mt-3 justify-self-start" onClick={onClickShow}>
          Show recovery code
        </Button>
      )}
      {recoveryCode && (
        <div className="group border-border relative mt-2 rounded border px-3 py-2 text-sm font-semibold">
          <StyledTooltip label="Copy to clipboard" className="!z-modal">
            <button
              className="border-border bg-default hover:bg-contrast absolute top-2 right-2 flex rounded border p-1 opacity-0 group-hover:opacity-100 focus:opacity-100"
              onClick={() => {
                navigator.clipboard.writeText(recoveryCode).then(
                  () => {
                    addToast({ type: ToastType.Success, message: 'Recovery code copied to clipboard' })
                  },
                  (error) => {
                    console.error(error)
                    addToast({ type: ToastType.Error, message: "Couldn't copy to clipboard" })
                  },
                )
              }}
            >
              <Icon type="copy" size="small" />
            </button>
          </StyledTooltip>
          {recoveryCode}
        </div>
      )}
    </div>
  )
}

export default RecoveryCodeBanner
