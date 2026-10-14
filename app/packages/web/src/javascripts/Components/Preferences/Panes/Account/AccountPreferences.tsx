import { observer } from 'mobx-react-lite'

import { WebApplication } from '@/Application/WebApplication'
import Authentication from './Authentication'
import Credentials from './Credentials'
import Sync from './Sync'
import SessionsAndDevices from './SessionsAndDevices'
import AccountStorage from './AccountStorage'
import SignOutWrapper from './SignOutView'
import PreferencesPane from '../../PreferencesComponents/PreferencesPane'
import Email from './Email/Email'
import ProfilePicture from './ProfilePicture'
import DeleteAccount from '@/Components/Preferences/Panes/Account/DeleteAccount'

type Props = {
  application: WebApplication
}

const AccountPreferences = ({ application }: Props) => {
  const isUsingThirdPartyServer = !application.sessions.isSignedIntoFirstPartyServer()

  return (
    <PreferencesPane>
      {!application.hasAccount() ? (
        <Authentication application={application} />
      ) : (
        <>
          <ProfilePicture application={application} />
          <Credentials application={application} />
          <Sync application={application} />
          <SessionsAndDevices application={application} />
          <AccountStorage application={application} />
        </>
      )}
      {application.hasAccount() && !isUsingThirdPartyServer && <Email application={application} />}
      <SignOutWrapper application={application} />
      <DeleteAccount application={application} />
    </PreferencesPane>
  )
}

export default observer(AccountPreferences)
