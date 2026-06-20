import { WebApplicationGroup } from '@/Application/WebApplicationGroup'
import { observer } from 'mobx-react-lite'
import { FunctionComponent, useState } from 'react'
import { AccountMenuPane } from './AccountMenuPane'
import ConfirmPassword from './ConfirmPassword'
import CreateAccount from './CreateAccount'
import GeneralAccountMenu from './GeneralAccountMenu'
import SignInPane from './SignIn'

type Props = {
  mainApplicationGroup: WebApplicationGroup
  menuPane: AccountMenuPane
  setMenuPane: (pane: AccountMenuPane) => void
  closeMenu: () => void
}

const MenuPaneSelector: FunctionComponent<Props> = ({ menuPane, setMenuPane, closeMenu, mainApplicationGroup }) => {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  // Standard Red Notes: optional workspace name for the "multiple accounts per
  // email" feature (server flag WORKSPACES_PER_EMAIL_ENABLED). Threaded from the
  // CreateAccount pane through to the register call in ConfirmPassword. When the
  // server flag is off, any value here is ignored server-side (no-op), so the
  // field is shown as always-optional.
  const [workspaceIdentifier, setWorkspaceIdentifier] = useState('')

  switch (menuPane) {
    case AccountMenuPane.GeneralMenu:
      return (
        <GeneralAccountMenu
          mainApplicationGroup={mainApplicationGroup}
          setMenuPane={setMenuPane}
          closeMenu={closeMenu}
        />
      )
    case AccountMenuPane.SignIn:
      return <SignInPane setMenuPane={setMenuPane} />
    case AccountMenuPane.Register:
      return (
        <CreateAccount
          setMenuPane={setMenuPane}
          email={email}
          setEmail={setEmail}
          password={password}
          setPassword={setPassword}
          workspaceIdentifier={workspaceIdentifier}
          setWorkspaceIdentifier={setWorkspaceIdentifier}
        />
      )
    case AccountMenuPane.ConfirmPassword:
      return (
        <ConfirmPassword
          setMenuPane={setMenuPane}
          email={email}
          password={password}
          workspaceIdentifier={workspaceIdentifier}
        />
      )
  }
}

export default observer(MenuPaneSelector)
