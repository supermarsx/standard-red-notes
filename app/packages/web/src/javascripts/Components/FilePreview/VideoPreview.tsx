import { FilesController } from '@/Controllers/FilesController'
import { NoPreviewIllustration } from '@standardnotes/icons'
import { FileItem } from '@standardnotes/snjs'
import { useState } from 'react'
import Button from '../Button/Button'
import { FileItemActionType } from '../AttachedFilesPopover/PopoverFileItemAction'
import { useTranslation } from 'react-i18next'

type Props = {
  file: FileItem
  filesController: FilesController
  objectUrl: string
  isEmbeddedInSuper: boolean
}

/**
 * Some formats require using the <source/> tag with the type attribute
 * because we use object URLs. However some formats seem to only work
 * when not using the <source/> tag.
 * We show an error message if neither works.
 */
const VideoPreview = ({ file, filesController, objectUrl, isEmbeddedInSuper }: Props) => {
  const { t } = useTranslation('files')
  const [showError, setShowError] = useState(false)
  const [shouldTryFallback, setShouldTryFallback] = useState(false)

  if (showError) {
    return (
      <div className="flex flex-grow flex-col items-center justify-center">
        <NoPreviewIllustration className="mb-4 h-30 w-30" />
        <div className="mb-2 text-base font-bold">{t('videoCannotBePreviewed')}</div>
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
      </div>
    )
  }

  if (shouldTryFallback) {
    return (
      <video
        className="h-full w-full"
        controls
        autoPlay
        src={objectUrl}
        onError={() => {
          setShowError(true)
          setShouldTryFallback(false)
        }}
      />
    )
  }

  return (
    <video
      className="h-full w-full"
      controls
      autoPlay={!isEmbeddedInSuper}
      onError={() => {
        setShouldTryFallback(true)
      }}
    >
      <source src={objectUrl} type={file.mimeType} />
    </video>
  )
}

export default VideoPreview
