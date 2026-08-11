import { FunctionComponent } from 'react'
import { Text } from '@/Components/Preferences/PreferencesComponents/Content'

type Props = {
  unavailableReason?: string
}

const U2FDescription: FunctionComponent<Props> = ({ unavailableReason }) => {
  return (
    <div>
      <Text>
        Authenticate with a passkey (Touch ID, Windows Hello, your phone) or a hardware security key such as a YubiKey.
        A passkey is a strong WebAuthn authentication factor; your account password is still required to decrypt your
        data.
      </Text>
      {unavailableReason && <Text className="text-warning italic">Registration unavailable: {unavailableReason}</Text>}
    </div>
  )
}

export default U2FDescription
