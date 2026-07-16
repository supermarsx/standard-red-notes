import Icon from '@/Components/Icon/Icon'
import { FunctionComponent, ReactNode } from 'react'

type Props = {
  icon: ReactNode
  status: string
  checkmark?: boolean
}

const EncryptionStatusItem: FunctionComponent<Props> = ({ icon, status, checkmark = true }) => (
  <div className="text-input no-border bg-contrast focus-within:ring-info my-1 flex min-h-8 w-full flex-row items-center rounded px-3 py-1.5">
    {icon}
    <div className="min-h-1 min-w-3" />
    <div className="text-text flex-grow text-sm">{status}</div>
    <div className="min-h-1 min-w-3" />
    {checkmark && <Icon className="text-success min-h-4 min-w-4" type="check-bold" />}
  </div>
)

export default EncryptionStatusItem
