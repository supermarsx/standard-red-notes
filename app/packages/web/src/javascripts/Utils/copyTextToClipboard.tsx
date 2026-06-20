import { addToast, ToastType } from '@standardnotes/toast'

export function fallbackCopyTextToClipboard(text: string) {
  const textArea = document.createElement('textarea')
  textArea.value = text
  textArea.style.top = '0'
  textArea.style.left = '0'
  textArea.style.position = 'fixed'
  document.body.appendChild(textArea)
  textArea.focus()
  textArea.select()
  let succeeded = false
  try {
    succeeded = document.execCommand('copy')
  } catch (err) {
    console.error('Unable to copy', err)
  }

  document.body.removeChild(textArea)
  return succeeded
}

export function copyTextToClipboard(text: string, successMessage = 'Copied to clipboard') {
  if (!navigator.clipboard) {
    const succeeded = fallbackCopyTextToClipboard(text)
    if (succeeded) {
      addToast({ type: ToastType.Success, message: successMessage })
    } else {
      addToast({ type: ToastType.Error, message: "Couldn't copy to clipboard" })
    }
    return
  }

  navigator.clipboard.writeText(text).then(
    () => {
      addToast({ type: ToastType.Success, message: successMessage })
    },
    (error) => {
      console.error(error)
      addToast({ type: ToastType.Error, message: "Couldn't copy to clipboard" })
    },
  )
}
