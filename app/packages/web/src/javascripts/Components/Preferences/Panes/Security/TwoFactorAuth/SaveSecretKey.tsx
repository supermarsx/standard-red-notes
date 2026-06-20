import DecoratedInput from '@/Components/Input/DecoratedInput'
import IconButton from '@/Components/Button/IconButton'
import { observer } from 'mobx-react-lite'
import { FunctionComponent } from 'react'
import CopyButton from './CopyButton'
import Bullet from './Bullet'
import { downloadSecretKey } from './download-secret-key'
import { TwoFactorActivation } from './TwoFactorActivation'

type Props = {
  activation: TwoFactorActivation
}

const SaveSecretKey: FunctionComponent<Props> = ({ activation: act }) => {
  return (
    <div className="h-33 flex flex-row items-center px-4 py-4">
      <div className="flex flex-grow flex-col">
        <div className="flex flex-row flex-wrap items-center gap-1">
          <Bullet />
          <div className="text-sm">
            <b>Save your secret key</b> somewhere safe:
          </div>
          <DecoratedInput
            disabled={true}
            right={[
              <CopyButton copyValue={act.secretKey} successMessage="Secret key copied to clipboard" />,
              <IconButton
                focusable={false}
                title="Download"
                icon="download"
                className="p-0"
                onClick={() => {
                  downloadSecretKey(act.secretKey)
                }}
              />,
            ]}
            value={act.secretKey}
            className={{ container: 'ml-2' }}
          />
        </div>
        <div className="h-2" />
        <div className="flex flex-row items-center">
          <Bullet />
          <div className="min-w-1" />
          <div className="text-sm">
            You can use this key to generate codes if you lose access to your authenticator app.
          </div>
        </div>
      </div>
    </div>
  )
}

export default observer(SaveSecretKey)
