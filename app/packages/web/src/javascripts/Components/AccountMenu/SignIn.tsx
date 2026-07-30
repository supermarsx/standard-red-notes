import { isDev } from '@/Utils'
import { observer } from 'mobx-react-lite'
import React, { FunctionComponent, KeyboardEventHandler, useCallback, useEffect, useRef, useState } from 'react'
import { AccountMenuPane } from './AccountMenuPane'
import Button from '@/Components/Button/Button'
import Checkbox from '@/Components/Checkbox/Checkbox'
import DecoratedInput from '@/Components/Input/DecoratedInput'
import DecoratedPasswordInput from '@/Components/Input/DecoratedPasswordInput'
import Icon from '@/Components/Icon/Icon'
import IconButton from '@/Components/Button/IconButton'
import AdvancedOptions from './AdvancedOptions'
import HorizontalSeparator from '../Shared/HorizontalSeparator'
import { getErrorFromErrorResponse, isErrorResponse, getCaptchaHeader } from '@standardnotes/snjs'
import { useApplication } from '../ApplicationProvider'
import { useCaptcha } from '@/Hooks/useCaptcha'
import MergeLocalDataCheckbox from './MergeLocalDataCheckbox'
import ConfirmNoMergeDialog from './ConfirmNoMergeDialog'
import { useTranslation } from 'react-i18next'
import { achievements, METRICS } from '@/Achievements'

type Props = {
  setMenuPane: (pane: AccountMenuPane) => void
}

const SignInPane: FunctionComponent<Props> = ({ setMenuPane }) => {
  const application = useApplication()
  const { t } = useTranslation('auth')

  const { notesAndTagsCount } = application.accountMenuController
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  // Standard Red Notes: optional workspace name for "multiple accounts per
  // email" (server flag WORKSPACES_PER_EMAIL_ENABLED). Always shown as optional;
  // leave blank for the default workspace. Ignored server-side when the flag is
  // off. NOTE: only the normal sign-in path carries this; recovery-code sign-in
  // resolves accounts differently and does not support workspace disambiguation.
  const [workspaceIdentifier, setWorkspaceIdentifier] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState('')
  const [accountRecoveryCode, setAccountRecoveryCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newPasswordConfirmation, setNewPasswordConfirmation] = useState('')
  const [freshAccountRecoveryCode, setFreshAccountRecoveryCode] = useState('')
  const [savedFreshRecoveryCode, setSavedFreshRecoveryCode] = useState(false)
  const [recoveryNotice, setRecoveryNotice] = useState('')
  const [error, setError] = useState('')
  const [isEphemeral, setIsEphemeral] = useState(false)

  const [isStrictSignin, setIsStrictSignin] = useState(false)
  const [isSigningIn, setIsSigningIn] = useState(false)
  const [shouldMergeLocal, setShouldMergeLocal] = useState(true)
  const [isPrivateUsername, setIsPrivateUsername] = useState(false)

  const [isRecoverySignIn, setIsRecoverySignIn] = useState(false)
  const [isAccountRecovery, setIsAccountRecovery] = useState(false)
  const [showNoMergeConfirmation, setShowNoMergeConfirmation] = useState(false)

  const [captchaURL, setCaptchaURL] = useState('')
  const [showCaptcha, setShowCaptcha] = useState(false)
  const [hvmToken, setHVMToken] = useState('')
  const captchaIframe = useCaptcha(captchaURL, (token) => {
    setHVMToken(token)
    setShowCaptcha(false)
    setCaptchaURL('')
  })

  const emailInputRef = useRef<HTMLInputElement>(null)
  const passwordInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (emailInputRef?.current) {
      emailInputRef.current?.focus()
    }
    if (isDev && window.devAccountEmail) {
      setEmail(window.devAccountEmail)
      setPassword(window.devAccountPassword as string)
    }
  }, [])

  const resetInvalid = useCallback(() => {
    if (error.length) {
      setError('')
    }
  }, [setError, error])

  const handleEmailChange = useCallback((text: string) => {
    setEmail(text)
  }, [])

  const handlePasswordChange = useCallback(
    (text: string) => {
      if (error.length) {
        setError('')
      }
      setPassword(text)
    },
    [setPassword, error],
  )

  // Standard Red Notes: optional workspace name (WORKSPACES_PER_EMAIL_ENABLED).
  const handleWorkspaceIdentifierChange = useCallback((text: string) => {
    setWorkspaceIdentifier(text)
  }, [])

  const handleEphemeralChange = useCallback(() => {
    setIsEphemeral(!isEphemeral)
  }, [isEphemeral])

  const handleStrictSigninChange = useCallback(() => {
    setIsStrictSignin(!isStrictSignin)
  }, [isStrictSignin])

  const onRecoveryCodesChange = useCallback(
    (newIsRecoverySignIn: boolean, recoveryCodes?: string) => {
      setIsRecoverySignIn(newIsRecoverySignIn)
      if (newIsRecoverySignIn && recoveryCodes) {
        setRecoveryCodes(recoveryCodes)
      }
    },
    [setRecoveryCodes],
  )

  const handleShouldMergeChange = useCallback(() => {
    setShouldMergeLocal(!shouldMergeLocal)
  }, [shouldMergeLocal])

  const signIn = useCallback(() => {
    setIsSigningIn(true)
    emailInputRef?.current?.blur()
    passwordInputRef?.current?.blur()

    application
      // Standard Red Notes: pass the optional workspace name through to sign-in.
      // Empty string means the default workspace; ignored server-side unless
      // WORKSPACES_PER_EMAIL_ENABLED is on.
      .signIn(
        email,
        password,
        isStrictSignin,
        isEphemeral,
        shouldMergeLocal,
        false,
        hvmToken,
        workspaceIdentifier || undefined,
      )
      .then((response) => {
        const captchaURL = getCaptchaHeader(response)
        if (captchaURL) {
          setCaptchaURL(captchaURL)
        }
        if (isErrorResponse(response)) {
          throw new Error(getErrorFromErrorResponse(response).message)
        }
        application.accountMenuController.closeAccountMenu()
      })
      .catch((err) => {
        console.error(err)
        achievements.increment(METRICS.failedLoginsTotal)
        setError(err.message ?? err.toString())
        setPassword('')
        setHVMToken('')
        passwordInputRef?.current?.blur()
      })
      .finally(() => {
        setIsSigningIn(false)
      })
  }, [application, email, hvmToken, isEphemeral, isStrictSignin, password, shouldMergeLocal, workspaceIdentifier])

  const recoverySignIn = useCallback(() => {
    setIsSigningIn(true)
    emailInputRef?.current?.blur()
    passwordInputRef?.current?.blur()

    application.signInWithRecoveryCodes
      .execute({
        recoveryCodes,
        username: email,
        password: password,
        hvmToken,
        mergeLocal: shouldMergeLocal,
      })
      .then((result) => {
        if (result.isFailed()) {
          const error = result.getError()
          try {
            const parsed = JSON.parse(error)
            if (parsed.captchaURL) {
              setCaptchaURL(parsed.captchaURL)
              return
            }
          } catch {
            setCaptchaURL('')
          }
          throw new Error(error)
        }
        application.accountMenuController.closeAccountMenu()
      })
      .catch((err) => {
        console.error(err)
        achievements.increment(METRICS.failedLoginsTotal)
        setError(err.message ?? err.toString())
        setPassword('')
        setHVMToken('')
        passwordInputRef?.current?.blur()
      })
      .finally(() => {
        setIsSigningIn(false)
      })
  }, [
    application.accountMenuController,
    application.signInWithRecoveryCodes,
    email,
    hvmToken,
    password,
    recoveryCodes,
    shouldMergeLocal,
  ])

  const recoverAccount = useCallback(() => {
    setIsSigningIn(true)
    setError('')
    application.recoverAccount
      .execute({
        recoveryCode: accountRecoveryCode,
        newPassword,
        newPasswordConfirmation,
        mergeLocal: shouldMergeLocal,
      })
      .then((result) => {
        if (result.isFailed()) {
          setError(result.getError())
          return
        }

        const outcome = result.getValue()
        setAccountRecoveryCode('')
        setNewPassword('')
        setNewPasswordConfirmation('')
        if (!outcome.passwordReset) {
          setRecoveryNotice(
            `You are signed in, but the password was not changed. ${
              outcome.passwordResetError ?? 'Retry the password change from Security preferences.'
            }`,
          )
          return
        }
        if (outcome.reenrollmentError) {
          setRecoveryNotice(
            `Your password was changed, but account recovery is now disabled. ${outcome.reenrollmentError}`,
          )
          return
        }
        if (outcome.recoveryCode) {
          setFreshAccountRecoveryCode(outcome.recoveryCode)
          setSavedFreshRecoveryCode(false)
          setRecoveryNotice('')
          return
        }

        setRecoveryNotice('Your password was changed. Enable account recovery again from Security preferences.')
      })
      .catch(() => {
        setError('Account recovery could not be completed.')
      })
      .finally(() => {
        setIsSigningIn(false)
      })
  }, [accountRecoveryCode, application.recoverAccount, newPassword, newPasswordConfirmation, shouldMergeLocal])

  const onPrivateUsernameChange = useCallback(
    (newisPrivateUsername: boolean, privateUsernameIdentifier?: string) => {
      setIsPrivateUsername(newisPrivateUsername)
      if (newisPrivateUsername && privateUsernameIdentifier) {
        setEmail(privateUsernameIdentifier)
      }
    },
    [setEmail],
  )

  const performSignIn = useCallback(() => {
    if (isAccountRecovery) {
      if (!accountRecoveryCode || !newPassword || !newPasswordConfirmation) {
        setError('Enter the account recovery code, a strong new password, and its confirmation.')
        return
      }
      if (notesAndTagsCount > 0 && !shouldMergeLocal) {
        setShowNoMergeConfirmation(true)
        return
      }
      recoverAccount()
      return
    }

    if (!email || email.length === 0) {
      emailInputRef?.current?.focus()
      return
    }

    if (!password || password.length === 0) {
      passwordInputRef?.current?.focus()
      return
    }

    if (notesAndTagsCount > 0 && !shouldMergeLocal) {
      setShowNoMergeConfirmation(true)
      return
    }

    if (isRecoverySignIn) {
      recoverySignIn()
      return
    }

    signIn()
  }, [
    accountRecoveryCode,
    email,
    isAccountRecovery,
    isRecoverySignIn,
    newPassword,
    newPasswordConfirmation,
    notesAndTagsCount,
    password,
    recoverAccount,
    recoverySignIn,
    shouldMergeLocal,
    signIn,
  ])

  const handleSignInFormSubmit = useCallback(
    (e: React.SyntheticEvent) => {
      e.preventDefault()

      if (captchaURL) {
        setShowCaptcha(true)
        return
      }

      performSignIn()
    },
    [captchaURL, performSignIn],
  )

  const handleKeyDown: KeyboardEventHandler = useCallback(
    (e) => {
      if (e.key === 'Enter') {
        handleSignInFormSubmit(e)
      }
    },
    [handleSignInFormSubmit],
  )

  useEffect(() => {
    if (!hvmToken) {
      return
    }

    performSignIn()
  }, [hvmToken, performSignIn])

  const copyFreshRecoveryCode = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(freshAccountRecoveryCode)
      setRecoveryNotice('')
    } catch {
      setRecoveryNotice('The recovery code could not be copied. Select it and save it manually.')
    }
  }, [freshAccountRecoveryCode])

  const finishRecoveredSignIn = useCallback(() => {
    if (!savedFreshRecoveryCode) {
      return
    }
    application.accountMenuController.closeAccountMenu()
  }, [application.accountMenuController, savedFreshRecoveryCode])

  const accountRecoveryForm = (
    <div className="mb-1 px-3">
      <div className="border-warning bg-warning-faded mb-3 rounded border border-solid p-3 text-sm">
        Your recovery code can decrypt your account keys. MFA is still required for server sign-in, but cannot protect a
        copied code from offline decryption. Only continue on a computer you trust.
      </div>
      <DecoratedInput
        className={{ container: `mb-2 ${error ? 'border-danger' : ''}` }}
        left={[<Icon type="restore" className="text-neutral" />]}
        type="text"
        placeholder="Account recovery code"
        value={accountRecoveryCode}
        onChange={(value) => {
          setAccountRecoveryCode(value)
          resetInvalid()
        }}
        onKeyDown={handleKeyDown}
        disabled={isSigningIn}
        spellcheck={false}
      />
      <DecoratedPasswordInput
        className={{ container: `mb-2 ${error ? 'border-danger' : ''}` }}
        disabled={isSigningIn}
        left={[<Icon type="password" className="text-neutral" />]}
        onChange={(value) => {
          setNewPassword(value)
          resetInvalid()
        }}
        onKeyDown={handleKeyDown}
        placeholder="Strong new password"
        value={newPassword}
      />
      <DecoratedPasswordInput
        className={{ container: `mb-2 ${error ? 'border-danger' : ''}` }}
        disabled={isSigningIn}
        left={[<Icon type="password" className="text-neutral" />]}
        onChange={(value) => {
          setNewPasswordConfirmation(value)
          resetInvalid()
        }}
        onKeyDown={handleKeyDown}
        placeholder="Confirm new password"
        value={newPasswordConfirmation}
      />
      {error ? <div className="text-danger my-2">{error}</div> : null}
      {recoveryNotice ? <div className="text-warning my-2">{recoveryNotice}</div> : null}
      <Button
        className="mt-1 mb-3"
        label={isSigningIn ? 'Recovering account…' : 'Recover account and change password'}
        primary
        onClick={handleSignInFormSubmit}
        disabled={isSigningIn}
        fullWidth
      />
      {notesAndTagsCount > 0 ? (
        <MergeLocalDataCheckbox
          checked={shouldMergeLocal}
          onChange={handleShouldMergeChange}
          disabled={isSigningIn}
          notesAndTagsCount={notesAndTagsCount}
        />
      ) : null}
      {recoveryNotice ? (
        <Button
          className="mt-3"
          label="Close"
          onClick={() => application.accountMenuController.closeAccountMenu()}
          fullWidth
        />
      ) : null}
      {!recoveryNotice ? (
        <button
          type="button"
          className="text-info mt-4 w-full cursor-pointer border-0 bg-transparent text-center"
          onClick={() => {
            setIsAccountRecovery(false)
            setError('')
            setRecoveryNotice('')
          }}
        >
          Back to sign in
        </button>
      ) : null}
    </div>
  )

  const freshRecoveryCodeForm = (
    <div className="mb-1 px-3">
      <div className="border-warning bg-warning-faded mb-3 rounded border border-solid p-3">
        <div className="font-bold">Save your new recovery code now</div>
        <div className="mt-1 text-sm">
          Your password was changed successfully. The old code no longer works, and this replacement is shown once.
        </div>
      </div>
      <textarea
        className="border-border bg-default min-h-24 w-full resize-y rounded border border-solid p-3 font-mono text-sm"
        readOnly
        value={freshAccountRecoveryCode}
        aria-label="New account recovery code"
      />
      <Button className="mt-2" label="Copy recovery code" onClick={() => void copyFreshRecoveryCode()} fullWidth />
      {recoveryNotice ? <div className="text-danger mt-2">{recoveryNotice}</div> : null}
      <div className="mt-3">
        <Checkbox
          name="fresh-account-recovery-code-saved"
          label="I saved this recovery code somewhere secure"
          checked={savedFreshRecoveryCode}
          onChange={() => setSavedFreshRecoveryCode((value) => !value)}
        />
      </div>
      <Button
        className="mt-3"
        primary
        label="Finish"
        disabled={!savedFreshRecoveryCode}
        onClick={finishRecoveredSignIn}
        fullWidth
      />
    </div>
  )

  const signInForm = (
    <>
      <div className="mb-1 px-3">
        <DecoratedInput
          className={{ container: `mb-2 ${error ? 'border-danger' : null}` }}
          left={[<Icon type="email" className="text-neutral" />]}
          type="email"
          placeholder={t('account:email')}
          value={email}
          onChange={handleEmailChange}
          onFocus={resetInvalid}
          onKeyDown={handleKeyDown}
          disabled={isSigningIn || isPrivateUsername}
          ref={emailInputRef}
          spellcheck={false}
        />
        <DecoratedPasswordInput
          className={{ container: `mb-2 ${error ? 'border-danger' : null}` }}
          disabled={isSigningIn}
          left={[<Icon type="password" className="text-neutral" />]}
          onChange={handlePasswordChange}
          onFocus={resetInvalid}
          onKeyDown={handleKeyDown}
          placeholder={t('account:password')}
          ref={passwordInputRef}
          value={password}
        />
        {/*
          Standard Red Notes: optional workspace name. On a server with
          WORKSPACES_PER_EMAIL_ENABLED, this selects which account ("workspace")
          under this email to sign into. Leave blank for the default workspace.
          Ignored on servers with the feature off.
        */}
        <DecoratedInput
          className={{ container: 'mb-2' }}
          left={[<Icon type="user" className="text-neutral" />]}
          type="text"
          placeholder={t('workspaceNameOptional')}
          value={workspaceIdentifier}
          onChange={handleWorkspaceIdentifierChange}
          onFocus={resetInvalid}
          onKeyDown={handleKeyDown}
          disabled={isSigningIn}
          spellcheck={false}
        />
        {error ? <div className="text-danger my-2">{error}</div> : null}
        <Button
          className="mt-1 mb-3"
          label={isSigningIn ? t('signingIn') : t('account:signIn')}
          primary
          onClick={handleSignInFormSubmit}
          disabled={isSigningIn}
          fullWidth={true}
        />
        <Checkbox
          name="is-ephemeral"
          label={t('staySignedIn')}
          checked={!isEphemeral}
          disabled={isSigningIn || isRecoverySignIn}
          onChange={handleEphemeralChange}
        />
        {notesAndTagsCount > 0 ? (
          <MergeLocalDataCheckbox
            checked={shouldMergeLocal}
            onChange={handleShouldMergeChange}
            disabled={isSigningIn}
            notesAndTagsCount={notesAndTagsCount}
          />
        ) : null}
      </div>
      <HorizontalSeparator classes="my-2" />
      <AdvancedOptions
        disabled={isSigningIn}
        onPrivateUsernameModeChange={onPrivateUsernameChange}
        onStrictSignInChange={handleStrictSigninChange}
        onRecoveryCodesChange={onRecoveryCodesChange}
      />
      <button
        type="button"
        className="text-info mt-3 w-full cursor-pointer border-0 bg-transparent px-3 text-center"
        disabled={isSigningIn}
        onClick={() => {
          setIsAccountRecovery(true)
          setIsRecoverySignIn(false)
          setError('')
        }}
      >
        Recover account with an account recovery code
      </button>
    </>
  )

  const closeNoMergeConfirmation = useCallback(() => {
    setShowNoMergeConfirmation(false)
  }, [])

  const confirmSignInWithoutMerge = useCallback(() => {
    setShowNoMergeConfirmation(false)
    if (isAccountRecovery) {
      recoverAccount()
    } else if (isRecoverySignIn) {
      recoverySignIn()
    } else {
      signIn()
    }
  }, [isAccountRecovery, isRecoverySignIn, recoverAccount, recoverySignIn, signIn])

  return (
    <>
      <div className="mt-1 mb-3 flex items-center px-3">
        <IconButton
          icon="arrow-left"
          title={t('goBack')}
          className="text-neutral mr-2 flex p-0"
          onClick={() => setMenuPane(AccountMenuPane.GeneralMenu)}
          focusable={true}
          disabled={isSigningIn}
        />
        <div className="text-base font-bold">
          {showCaptcha
            ? t('humanVerification')
            : isAccountRecovery
              ? freshAccountRecoveryCode
                ? 'Save recovery code'
                : 'Recover account'
              : t('account:signIn')}
        </div>
      </div>
      {showCaptcha ? (
        <div className="p-[10px]">{captchaIframe}</div>
      ) : freshAccountRecoveryCode ? (
        freshRecoveryCodeForm
      ) : isAccountRecovery ? (
        accountRecoveryForm
      ) : (
        signInForm
      )}
      {showNoMergeConfirmation && (
        <ConfirmNoMergeDialog onClose={closeNoMergeConfirmation} onConfirm={confirmSignInWithoutMerge} />
      )}
    </>
  )
}

export default observer(SignInPane)
