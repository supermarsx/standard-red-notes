import { FilesIllustration } from '@standardnotes/icons'
import { useTranslation } from 'react-i18next'
import Button from '../Button/Button'

type Props = {
  addNewItem: () => void
}

const EmptyFilesView = ({ addNewItem }: Props) => {
  const { t } = useTranslation('notes')
  return (
    <div className="flex h-full w-full flex-col items-center justify-center">
      <FilesIllustration className="h-32 w-32" />
      <div className="mt-4 mb-2 text-lg font-bold">{t('noFilesYet')}</div>
      <div className="text-passive-0 mb-4 max-w-[35ch] text-center text-sm">{t('filesAttachedAppearHere')}</div>
      <Button primary onClick={addNewItem}>
        {t('uploadFiles')}
      </Button>
    </div>
  )
}

export default EmptyFilesView
