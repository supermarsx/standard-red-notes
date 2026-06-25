import { observer } from 'mobx-react-lite'
import {
  FormEventHandler,
  FunctionComponent,
  KeyboardEventHandler,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { AccountMenuPane } from './AccountMenuPane'
import Button from '@/Components/Button/Button'
import DecoratedInput from '@/Components/Input/DecoratedInput'
import DecoratedPasswordInput from '@/Components/Input/DecoratedPasswordInput'
import Icon from '@/Components/Icon/Icon'
import IconButton from '@/Components/Button/IconButton'
import AdvancedOptions from './AdvancedOptions'
import HorizontalSeparator from '../Shared/HorizontalSeparator'
import { useTranslation } from 'react-i18next'

type Props = {
  setMenuPane: (pane: AccountMenuPane) => void
  email: string
  setEmail: React.Dispatch<React.SetStateAction<string>>
  password: string
  setPassword: React.Dispatch<React.SetStateAction<string>>
  // Standard Red Notes: optional workspace name for "multiple accounts per
  // email" (server flag WORKSPACES_PER_EMAIL_ENABLED). Always shown as optional;
  // ignored server-side when the flag is off.
  workspaceIdentifier: string
  setWorkspaceIdentifier: React.Dispatch<React.SetStateAction<string>>
}

const CreateAccount: FunctionComponent<Props> = ({
  setMenuPane,
  email,
  setEmail,
  password,
  setPassword,
  workspaceIdentifier,
  setWorkspaceIdentifier,
}) => {
  const { t } = useTranslation('auth')
  const emailInputRef = useRef<HTMLInputElement>(null)
  const passwordInputRef = useRef<HTMLInputElement>(null)
  const [isPrivateUsername, setIsPrivateUsername] = useState(false)

  useEffect(() => {
    if (emailInputRef.current) {
      emailInputRef.current?.focus()
    }
  }, [])

  const handleEmailChange = useCallback(
    (text: string) => {
      setEmail(text)
    },
    [setEmail],
  )

  const handlePasswordChange = useCallback(
    (text: string) => {
      setPassword(text)
    },
    [setPassword],
  )

  // Standard Red Notes: optional workspace name (WORKSPACES_PER_EMAIL_ENABLED).
  const handleWorkspaceIdentifierChange = useCallback(
    (text: string) => {
      setWorkspaceIdentifier(text)
    },
    [setWorkspaceIdentifier],
  )

  const handleRegisterFormSubmit: FormEventHandler = useCallback(
    (e) => {
      e.preventDefault()

      if (!email || email.length === 0) {
        emailInputRef.current?.focus()
        return
      }

      if (!password || password.length === 0) {
        passwordInputRef.current?.focus()
        return
      }

      setEmail(email)
      setPassword(password)
      setMenuPane(AccountMenuPane.ConfirmPassword)
    },
    [email, password, setPassword, setMenuPane, setEmail],
  )

  const handleKeyDown: KeyboardEventHandler = useCallback(
    (e) => {
      if (e.key === 'Enter') {
        handleRegisterFormSubmit(e)
      }
    },
    [handleRegisterFormSubmit],
  )

  const handleClose = useCallback(() => {
    setMenuPane(AccountMenuPane.GeneralMenu)
    setEmail('')
    setPassword('')
  }, [setEmail, setMenuPane, setPassword])

  const onPrivateUsernameChange = useCallback(
    (isPrivateUsername: boolean, privateUsernameIdentifier?: string) => {
      setIsPrivateUsername(isPrivateUsername)
      if (isPrivateUsername && privateUsernameIdentifier) {
        setEmail(privateUsernameIdentifier)
      }
    },
    [setEmail],
  )

  return (
    <>
      <div className="mb-3 mt-1 flex items-center px-3">
        <IconButton
          icon="arrow-left"
          title={t('goBack')}
          className="mr-2 flex p-0 text-neutral"
          onClick={handleClose}
          focusable={true}
        />
        <div className="text-base font-bold">{t('createAccount')}</div>
      </div>
      <form onSubmit={handleRegisterFormSubmit} className="mb-1 px-3">
        <DecoratedInput
          className={{ container: 'mb-2' }}
          disabled={isPrivateUsername}
          left={[<Icon type="email" className="text-neutral" />]}
          onChange={handleEmailChange}
          onKeyDown={handleKeyDown}
          placeholder={t('account:email')}
          ref={emailInputRef}
          type="email"
          value={email}
          spellcheck={false}
        />
        <DecoratedPasswordInput
          className={{ container: 'mb-2' }}
          left={[<Icon type="password" className="text-neutral" />]}
          onChange={handlePasswordChange}
          onKeyDown={handleKeyDown}
          placeholder={t('account:password')}
          ref={passwordInputRef}
          value={password}
        />
        {/*
          Standard Red Notes: optional workspace name. Lets a server with
          WORKSPACES_PER_EMAIL_ENABLED register multiple independent accounts
          ("workspaces") under one email. Leave blank for the default workspace.
          On a server with the feature off, this field is ignored.
        */}
        <DecoratedInput
          className={{ container: 'mb-2' }}
          left={[<Icon type="user" className="text-neutral" />]}
          onChange={handleWorkspaceIdentifierChange}
          onKeyDown={handleKeyDown}
          placeholder={t('workspaceNameOptional')}
          type="text"
          value={workspaceIdentifier}
          spellcheck={false}
        />
        <Button
          className="mt-1"
          label={t('common:next')}
          primary
          onClick={handleRegisterFormSubmit}
          fullWidth={true}
        />
      </form>
      <HorizontalSeparator classes="my-2" />
      <AdvancedOptions onPrivateUsernameModeChange={onPrivateUsernameChange} />
    </>
  )
}

export default observer(CreateAccount)
