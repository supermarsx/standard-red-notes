import { FunctionComponent } from 'react'
import Switch from '@/Components/Switch/Switch'
import { observer } from 'mobx-react-lite'
import { is2FADisabled, TwoFactorAuth } from '../TwoFactorAuth'
import Spinner from '@/Components/Spinner/Spinner'
import Button from '@/Components/Button/Button'

type Props = {
  auth: TwoFactorAuth
  canDisable2FA: boolean
}

const TwoFactorSwitch: FunctionComponent<Props> = ({ auth, canDisable2FA }) => {
  if (!auth.isLoggedIn()) {
    return null
  }

  if (auth.status === 'fetching') {
    return <Spinner className="h-4 w-4" />
  }
  if (auth.status === 'unavailable') {
    return <Button label="Retry" onClick={auth.fetchStatus} />
  }

  const shouldSwitchBeDisabled = auth.status === 'two-factor-enabled' && !canDisable2FA

  return <Switch checked={!is2FADisabled(auth.status)} onChange={auth.toggle2FA} disabled={shouldSwitchBeDisabled} />
}

export default observer(TwoFactorSwitch)
