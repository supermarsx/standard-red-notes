import { WebApplication } from '@/Application/WebApplication'
import { getBase64FromBlob } from '@/Utils'
import { FileItem } from '@standardnotes/snjs'
import { FunctionComponent, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Spinner from '@/Components/Spinner/Spinner'
import { lazyWithRetry } from '@/Utils/lazyWithRetry'
import ComponentErrorBoundary from '@/Components/ComponentErrorBoundary/ComponentErrorBoundary'
import Button from '../Button/Button'
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
const PdfPreview = lazyWithRetry(() => import('./PdfPreview'))

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
  const mountedRef = useRef(true)
  const currentInputRef = useRef({ file, bytes })
  currentInputRef.current = { file, bytes }
  const isNativeMobileWeb = application.isNativeMobileWeb()
  const requiresNativePreview = RequiresNativeFilePreview.includes(file.mimeType)
  const usesNativePreview = isNativeMobileWeb && requiresNativePreview
  const isImage = file.mimeType.startsWith('image/')
  const isVideo = file.mimeType.startsWith('video/')
  const isAudio = file.mimeType.startsWith('audio/')
  const isText = PreviewableTextFileTypes.includes(file.mimeType)
  const isPDF = file.mimeType === 'application/pdf'
  const requiresObjectUrl = !usesNativePreview && (isImage || isVideo || isAudio || (!isText && !isPDF))
  const objectUrlInput = useMemo(
    () => ({ byteLength: bytes.byteLength, mimeType: file.mimeType }),
    [bytes, file.mimeType],
  )
  const [objectUrlState, setObjectUrlState] = useState<{
    input: object
    url: string
  }>()
  const objectUrl = requiresObjectUrl && objectUrlState?.input === objectUrlInput ? objectUrlState.url : undefined

  useEffect(() => {
    if (!requiresObjectUrl) {
      setObjectUrlState(undefined)
      return
    }

    const url = URL.createObjectURL(
      new Blob([bytes as BlobPart], {
        type: file.mimeType,
      }),
    )
    setObjectUrlState({ input: objectUrlInput, url })

    return () => {
      URL.revokeObjectURL(url)
    }
  }, [bytes, file.mimeType, objectUrlInput, requiresObjectUrl])

  useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false
    }
  }, [])

  const openNativeFilePreview = useCallback(async () => {
    if (!isNativeMobileWeb) {
      throw new Error('Native file preview cannot be used on non-native platform')
    }

    const fileBase64 = await getBase64FromBlob(
      new Blob([bytes as BlobPart], {
        type: file.mimeType,
      }),
    )

    const currentInput = currentInputRef.current
    if (
      !mountedRef.current ||
      currentInput.file !== file ||
      currentInput.bytes !== bytes ||
      !application.isAuthorizedToRenderItem(file)
    ) {
      return
    }

    const { name, ext } = parseFileName(file.name)
    const sanitizedName = sanitizeFileName(name)
    const filename = `${sanitizedName}.${ext}`

    void application.mobileDevice.previewFile(fileBase64, filename)
  }, [application, bytes, file, isNativeMobileWeb])

  if (usesNativePreview) {
    return (
      <div className="flex flex-grow flex-col items-center justify-center">
        <div className="max-w-[30ch] text-center text-base font-bold">{t('externalAppOnly')}</div>
        <Button className="mt-3" primary onClick={openNativeFilePreview}>
          {t('openFilePreview')}
        </Button>
      </div>
    )
  }

  if (requiresObjectUrl && !objectUrl) {
    return (
      <div className="flex flex-grow items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    )
  }

  if (isImage) {
    return (
      <ImagePreview
        objectUrl={objectUrl!}
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

  if (isVideo) {
    return (
      <VideoPreview
        file={file}
        filesController={application.filesController}
        objectUrl={objectUrl!}
        isEmbeddedInSuper={isEmbeddedInSuper}
      />
    )
  }

  if (isAudio) {
    return <AudioPreview file={file} filesController={application.filesController} objectUrl={objectUrl!} />
  }

  if (isText) {
    return <TextPreview bytes={bytes} />
  }

  if (isPDF) {
    const viewer = (
      <ComponentErrorBoundary label="The PDF viewer">
        <Suspense
          fallback={
            <div className="flex flex-grow flex-col items-center justify-center">
              <Spinner className="h-6 w-6" />
              <span className="text-passive-0 mt-3 text-sm">{t('loadingPdfViewer')}</span>
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
      </ComponentErrorBoundary>
    )

    return isEmbeddedInSuper ? (
      <div
        className="h-[clamp(20rem,65vh,48rem)] w-full overflow-hidden"
        data-embedded-pdf-viewport="true"
        data-super-widget-layout="media"
      >
        {viewer}
      </div>
    ) : (
      viewer
    )
  }

  return <object className="h-full w-full" data={objectUrl!} />
}

export default PreviewComponent
