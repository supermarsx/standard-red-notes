import { FilesController } from '@/Controllers/FilesController'
import { NoPreviewIllustration } from '@standardnotes/icons'
import { FileItem } from '@standardnotes/snjs'
import { FileItemActionType } from '../AttachedFilesPopover/PopoverFileItemAction'
import Button from '../Button/Button'
import { useTranslation } from 'react-i18next'

type Props = {
  file: FileItem
  filesController: FilesController
  isFilePreviewable: boolean
  tryAgainCallback: () => void
}

const FilePreviewError = ({ file, filesController, isFilePreviewable, tryAgainCallback }: Props) => {
  const { t } = useTranslation('files')
  return (
    <div className="flex flex-grow flex-col items-center justify-center">
      <NoPreviewIllustration className="mb-4 h-30 w-30" />
      <div className="mb-2 text-base font-bold">{t('fileCannotBePreviewed')}</div>
      {isFilePreviewable ? (
        <>
          <div className="mb-4 max-w-[35ch] text-center text-sm text-passive-0">{t('errorLoadingFile')}</div>
          <div className="flex items-center">
            <Button
              primary
              className="mr-3"
              onClick={() => {
                tryAgainCallback()
              }}
            >
              {t('tryAgain')}
            </Button>
            <Button
              onClick={() => {
                filesController
                  .handleFileAction({
                    type: FileItemActionType.DownloadFile,
                    payload: {
                      file,
                    },
                  })
                  .catch(console.error)
              }}
            >
              {t('common:download')}
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="mb-4 max-w-[35ch] text-center text-sm text-passive-0">{t('downloadToView')}</div>
          <Button
            primary
            onClick={() => {
              filesController
                .handleFileAction({
                  type: FileItemActionType.DownloadFile,
                  payload: { file },
                })
                .catch(console.error)
            }}
          >
            {t('common:download')}
          </Button>
        </>
      )}
    </div>
  )
}

export default FilePreviewError
