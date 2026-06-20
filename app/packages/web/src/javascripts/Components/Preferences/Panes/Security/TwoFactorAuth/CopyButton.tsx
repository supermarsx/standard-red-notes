import { FunctionComponent, useState } from 'react'
import { addToast, ToastType } from '@standardnotes/toast'
import IconButton from '@/Components/Button/IconButton'

type Props = {
  copyValue: string
  successMessage?: string
}

const CopyButton: FunctionComponent<Props> = ({ copyValue: secretKey, successMessage = 'Copied to clipboard' }) => {
  const [isCopied, setCopied] = useState(false)
  return (
    <IconButton
      focusable={false}
      title="Copy to clipboard"
      icon={isCopied ? 'check' : 'copy'}
      className={`${isCopied ? 'success' : undefined} p-0`}
      onClick={() => {
        navigator?.clipboard
          ?.writeText(secretKey)
          .then(() => {
            setCopied(() => true)
            addToast({ type: ToastType.Success, message: successMessage })
          })
          .catch((error) => {
            console.error(error)
            addToast({ type: ToastType.Error, message: "Couldn't copy to clipboard" })
          })
      }}
    />
  )
}

export default CopyButton
