import { WebApplication } from '@/Application/WebApplication'
import { getBase64FromBlob } from '@/Utils'
import { FileItem } from '@standardnotes/snjs'
import { FunctionComponent, lazy, Suspense, useCallback, useEffect, useMemo, useRef } from 'react'
import Spinner from '@/Components/Spinner/Spinner'
import Button from '../Button/Button'
import { createObjectURLWithRef } from './CreateObjectURLWithRef'
import ImagePreview from './ImagePreview'
import { OptionalSuperEmbeddedImageProps } from './OptionalSuperEmbeddedImageProps'
import { PreviewableTextFileTypes, RequiresNativeFilePreview } from './isFilePreviewable'
import TextPreview from './TextPreview'
import { parseFileName, sanitizeFileName } from '@standardnotes/utils'
import VideoPreview from './VideoPreview'
import AudioPreview from './AudioPreview'
import { PdfDeepLinkTarget } from './PdfDeepLink'
import { useTranslation } from 'react-i18next'

// PDF.js is large; lazy-load the viewer so it's code-split out of the main bundle.
const PdfPreview = lazy(() => import('./PdfPreview'))

type Props = {
  application: WebApplication
  file: FileItem
  bytes: Uint8Array
  isEmbeddedInSuper: boolean
  pdfTarget?: PdfDeepLinkTarget
} & OptionalSuperEmbeddedImageProps

const PreviewComponent: FunctionComponent<Props> = ({
  application,
  file,
  bytes,
  isEmbeddedInSuper,
  imageZoomLevel,
  setImageZoomLevel,
  alignment,
  changeAlignment,
  imageWidth,
  setImageWidth,
  caption,
  setCaption,
  float,
  setFloat,
  isImageSelected,
  pdfTarget,
}) => {
  const { t } = useTranslation('files')
  const objectUrlRef = useRef<string | undefined>(undefined)

  const objectUrl = useMemo(() => {
    return createObjectURLWithRef(file.mimeType, bytes, objectUrlRef)
  }, [bytes, file.mimeType])

  useEffect(() => {
    const objectUrl = objectUrlRef.current

    return () => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
        objectUrlRef.current = ''
      }
    }
  }, [])

  const isNativeMobileWeb = application.isNativeMobileWeb()
  const requiresNativePreview = RequiresNativeFilePreview.includes(file.mimeType)

  const openNativeFilePreview = useCallback(async () => {
    if (!isNativeMobileWeb) {
      throw new Error('Native file preview cannot be used on non-native platform')
    }

    const fileBase64 = await getBase64FromBlob(
      new Blob([bytes as BlobPart], {
        type: file.mimeType,
      }),
    )

    const { name, ext } = parseFileName(file.name)
    const sanitizedName = sanitizeFileName(name)
    const filename = `${sanitizedName}.${ext}`

    void application.mobileDevice.previewFile(fileBase64, filename)
  }, [application, bytes, file.mimeType, file.name, isNativeMobileWeb])

  if (isNativeMobileWeb && requiresNativePreview) {
    return (
      <div className="flex flex-grow flex-col items-center justify-center">
        <div className="max-w-[30ch] text-center text-base font-bold">{t('externalAppOnly')}</div>
        <Button className="mt-3" primary onClick={openNativeFilePreview}>
          {t('openFilePreview')}
        </Button>
      </div>
    )
  }

  if (file.mimeType.startsWith('image/')) {
    return (
      <ImagePreview
        objectUrl={objectUrl}
        isEmbeddedInSuper={isEmbeddedInSuper}
        imageZoomLevel={imageZoomLevel}
        setImageZoomLevel={setImageZoomLevel}
        alignment={alignment}
        changeAlignment={changeAlignment}
        imageWidth={imageWidth}
        setImageWidth={setImageWidth}
        caption={caption}
        setCaption={setCaption}
        float={float}
        setFloat={setFloat}
        isImageSelected={isImageSelected}
      />
    )
  }

  if (file.mimeType.startsWith('video/')) {
    return (
      <VideoPreview
        file={file}
        filesController={application.filesController}
        objectUrl={objectUrl}
        isEmbeddedInSuper={isEmbeddedInSuper}
      />
    )
  }

  if (file.mimeType.startsWith('audio/')) {
    return <AudioPreview file={file} filesController={application.filesController} objectUrl={objectUrl} />
  }

  if (PreviewableTextFileTypes.includes(file.mimeType)) {
    return <TextPreview bytes={bytes} />
  }

  const isPDF = file.mimeType === 'application/pdf'

  if (isPDF) {
    return (
      <Suspense
        fallback={
          <div className="flex flex-grow flex-col items-center justify-center">
            <Spinner className="h-6 w-6" />
            <span className="mt-3 text-sm text-passive-0">{t('loadingPdfViewer')}</span>
          </div>
        }
      >
        <PdfPreview
          application={application}
          bytes={bytes}
          fileUuid={file.uuid}
          fileRemoteIdentifier={file.remoteIdentifier}
          target={pdfTarget}
        />
      </Suspense>
    )
  }

  return <object className="h-full w-full" data={objectUrl} />
}

export default PreviewComponent
