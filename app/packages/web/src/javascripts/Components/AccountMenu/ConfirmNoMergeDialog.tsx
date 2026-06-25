import AlertDialog from '@/Components/AlertDialog/AlertDialog'
import Button from '@/Components/Button/Button'
import Icon from '@/Components/Icon/Icon'
import { FunctionComponent } from 'react'
import { useTranslation } from 'react-i18next'

type Props = {
  onClose: () => void
  onConfirm: () => void
}

const ConfirmNoMergeDialog: FunctionComponent<Props> = ({ onClose, onConfirm }) => {
  const { t } = useTranslation('auth')

  return (
    <AlertDialog closeDialog={onClose}>
      <div className="flex items-center justify-between text-lg font-bold">
        {t('deleteLocalDataTitle')}
        <button className="rounded p-1 font-bold hover:bg-contrast" onClick={onClose}>
          <Icon type="close" />
        </button>
      </div>
      <div className="sk-panel-row">
        <div>
          <p className="text-base text-foreground lg:text-sm">{t('noMergeWarning')}</p>
          <p className="mt-2 text-base font-semibold text-danger lg:text-sm">{t('noMergeConfirmQuestion')}</p>
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>{t('common:cancel')}</Button>
        <Button primary colorStyle="danger" onClick={onConfirm}>
          {t('deleteLocalDataAndContinue')}
        </Button>
      </div>
    </AlertDialog>
  )
}

export default ConfirmNoMergeDialog
