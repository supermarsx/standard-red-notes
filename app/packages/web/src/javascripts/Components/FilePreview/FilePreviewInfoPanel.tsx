import { formatSizeToReadableString } from '@standardnotes/filepicker'
import { FileItem } from '@standardnotes/snjs'
import { FunctionComponent } from 'react'
import Icon from '@/Components/Icon/Icon'
import { useTranslation } from 'react-i18next'

type Props = {
  file: FileItem
}

const FilePreviewInfoPanel: FunctionComponent<Props> = ({ file }) => {
  const { t } = useTranslation('files')
  return (
    <div className="flex min-w-70 flex-col p-4">
      <div className="mb-4 flex items-center">
        <Icon type="info" className="mr-2" />
        <div className="font-semibold">{t('fileInformation')}</div>
      </div>
      <div className="mb-3">
        <span className="font-semibold">{t('type')}</span> {file.mimeType}
      </div>
      <div className="mb-3">
        <span className="font-semibold">{t('decryptedSize')}</span> {formatSizeToReadableString(file.decryptedSize)}
      </div>
      <div className="mb-3">
        <span className="font-semibold">{t('encryptedSize')}</span> {formatSizeToReadableString(file.encryptedSize)}
      </div>
      <div className="mb-3">
        <span className="font-semibold">{t('created')}</span> {file.created_at.toLocaleString()}
      </div>
      <div className="mb-3">
        <span className="font-semibold">{t('lastModified')}</span> {file.userModifiedDate.toLocaleString()}
      </div>
      <div>
        <span className="font-semibold">{t('fileId')}</span> {file.uuid}
      </div>
    </div>
  )
}

export default FilePreviewInfoPanel
