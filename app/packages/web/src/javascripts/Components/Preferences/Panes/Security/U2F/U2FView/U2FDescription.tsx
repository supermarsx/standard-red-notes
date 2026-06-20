import { FunctionComponent } from 'react'
import { observer } from 'mobx-react-lite'

import { Text } from '@/Components/Preferences/PreferencesComponents/Content'
import { useApplication } from '@/Components/ApplicationProvider'

type Props = {
  is2FAEnabled: boolean
}

const U2FDescription: FunctionComponent<Props> = ({ is2FAEnabled }) => {
  const application = useApplication()

  if (application.sessions.getUser() === undefined) {
    return <Text>Sign in or register for an account to configure passkeys and hardware security keys.</Text>
  }

  return (
    <div>
      <Text>
        Authenticate with a passkey (Touch ID, Windows Hello, your phone) or a hardware security key such as a YubiKey.
        A passkey is a strong WebAuthn authentication factor; your account password is still required to decrypt your
        data.
      </Text>
      {!application.isFullU2FClient && (
        <Text className="italic">Please visit the web app in order to add a passkey or security key.</Text>
      )}
      {!is2FAEnabled && (
        <Text className="italic">
          You must enable two-factor authentication before adding a passkey or security key.
        </Text>
      )}
    </div>
  )
}

export default observer(U2FDescription)
