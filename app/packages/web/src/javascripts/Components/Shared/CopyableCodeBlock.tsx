import { classNames } from '@standardnotes/utils'
import { addToast, ToastType } from '@standardnotes/toast'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Icon from '../Icon/Icon'

type Props = {
  code: string
}

const CopyableCodeBlock = ({ code }: Props) => {
  const { t } = useTranslation('sharing')
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [didCopy, setDidCopy] = useState(false)
  const [isCopyButtonVisible, setIsCopyButtonVisible] = useState(false)

  return (
    <div
      className="group relative"
      onMouseEnter={() => setIsCopyButtonVisible(true)}
      onMouseLeave={() => setIsCopyButtonVisible(false)}
    >
      <pre className="overflow-auto rounded-md bg-default px-2.5 py-1.5">{code}</pre>
      <div className="absolute right-1.5 top-1.5">
        <button
          ref={buttonRef}
          className={classNames(
            'peer rounded border border-border bg-default p-2 text-text hover:bg-contrast',
            !isCopyButtonVisible && 'hidden',
          )}
          onClick={() => {
            navigator.clipboard.writeText(code).then(
              () => {
                setDidCopy(true)
                addToast({
                  type: ToastType.Success,
                  message: t('copiedToClipboard'),
                })
                setTimeout(() => {
                  setDidCopy(false)
                  buttonRef.current?.blur()
                }, 1000)
              },
              () => {
                addToast({
                  type: ToastType.Error,
                  message: t('failedToCopyToClipboard'),
                })
                setDidCopy(false)
              },
            )
          }}
        >
          <Icon type="copy" size="small" />
        </button>
        <div
          className={classNames(
            didCopy && isCopyButtonVisible ? '' : 'hidden',
            'absolute right-0 top-full min-w-max translate-x-2 translate-y-1 select-none rounded border border-border bg-default px-3 py-1.5 text-left md:peer-hover:block',
          )}
        >
          {didCopy ? t('copiedExclaim') : t('copyExampleToClipboard')}
        </div>
      </div>
    </div>
  )
}

export default CopyableCodeBlock
