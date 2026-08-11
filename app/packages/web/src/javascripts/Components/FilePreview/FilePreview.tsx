import { WebApplication } from '@/Application/WebApplication'
import { concatenateUint8Arrays } from '@/Utils'
import { FileDownloadProgress, FileItem, fileProgressToHumanReadableString } from '@standardnotes/snjs'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Spinner from '@/Components/Spinner/Spinner'
import FilePreviewError from './FilePreviewError'
import { isFileTypePreviewable } from './isFilePreviewable'
import PreviewComponent from './PreviewComponent'
import Button from '../Button/Button'
import { ProtectedIllustration } from '@standardnotes/icons'
import { OptionalSuperEmbeddedImageProps } from './OptionalSuperEmbeddedImageProps'
import { PdfDeepLinkTarget } from './PdfDeepLink'
import { useTranslation } from 'react-i18next'
import { useItemAuthorization } from '@/Hooks/useItemAuthorization'

type Props = {
  application: WebApplication
  file: FileItem
  isEmbeddedInSuper?: boolean
  pdfTarget?: PdfDeepLinkTarget
} & OptionalSuperEmbeddedImageProps

type DownloadedPreview = {
  fileUuid: string
  remoteIdentifier: string
  bytes: Uint8Array
}

const FilePreview = ({
  file,
  application,
  isEmbeddedInSuper = false,
  pdfTarget,
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
}: Props) => {
  const { t } = useTranslation('files')
  const isAuthorized = useItemAuthorization(application, file)
  const authorizationRef = useRef(isAuthorized)
  authorizationRef.current = isAuthorized
  const currentFileIdentityRef = useRef({ uuid: file.uuid, remoteIdentifier: file.remoteIdentifier })
  currentFileIdentityRef.current = { uuid: file.uuid, remoteIdentifier: file.remoteIdentifier }

  const isFilePreviewable = useMemo(() => {
    return isFileTypePreviewable(file.mimeType)
  }, [file.mimeType])

  const [isDownloading, setIsDownloading] = useState(true)
  const [downloadProgress, setDownloadProgress] = useState<FileDownloadProgress | undefined>()
  const [downloadedPreview, setDownloadedPreview] = useState<DownloadedPreview>()
  const downloadedBytes =
    downloadedPreview?.fileUuid === file.uuid && downloadedPreview.remoteIdentifier === file.remoteIdentifier
      ? downloadedPreview.bytes
      : undefined

  useEffect(() => {
    return () => {
      downloadedPreview?.bytes.fill(0)
    }
  }, [downloadedPreview])

  useLayoutEffect(() => {
    setDownloadedPreview((preview) => {
      if (
        preview &&
        (!isAuthorized || preview.fileUuid !== file.uuid || preview.remoteIdentifier !== file.remoteIdentifier)
      ) {
        preview.bytes.fill(0)
        return undefined
      }
      return preview
    })

    if (!isAuthorized) {
      setIsDownloading(false)
      setDownloadProgress(undefined)
    }
  }, [file.remoteIdentifier, file.uuid, isAuthorized])

  useEffect(() => {
    if (!isFilePreviewable || !isAuthorized) {
      setIsDownloading(false)
      setDownloadProgress(undefined)
      return
    }

    let cancelled = false
    const fileUuid = file.uuid
    const remoteIdentifier = file.remoteIdentifier
    const abortController = new AbortController()
    const chunks: Uint8Array[] = []
    const wipeChunks = () => {
      for (const chunk of chunks) {
        chunk.fill(0)
      }
      chunks.length = 0
    }
    const isCurrentDownload = () => {
      const currentIdentity = currentFileIdentityRef.current
      return (
        !cancelled &&
        authorizationRef.current &&
        currentIdentity.uuid === fileUuid &&
        currentIdentity.remoteIdentifier === remoteIdentifier
      )
    }

    const downloadFileForPreview = async () => {
      if (downloadedBytes) {
        return
      }

      setIsDownloading(true)

      try {
        setDownloadProgress(undefined)
        const error = await application.files.downloadFile(
          file,
          async (decryptedChunk, progress) => {
            if (!isCurrentDownload()) {
              decryptedChunk.fill(0)
              return
            }
            chunks.push(decryptedChunk)
            if (progress) {
              setDownloadProgress(progress)
            }
          },
          { signal: abortController.signal },
        )

        if (!error && isCurrentDownload() && application.isAuthorizedToRenderItem(file)) {
          const finalDecryptedBytes = concatenateUint8Arrays(chunks)
          setDownloadedPreview((currentPreview) => {
            if (!isCurrentDownload() || !application.isAuthorizedToRenderItem(file)) {
              finalDecryptedBytes.fill(0)
              return currentPreview
            }
            currentPreview?.bytes.fill(0)
            return { fileUuid, remoteIdentifier, bytes: finalDecryptedBytes }
          })
        }
      } catch (error) {
        if (isCurrentDownload()) {
          console.error(error)
        }
      } finally {
        wipeChunks()
        if (isCurrentDownload()) {
          setIsDownloading(false)
        }
      }
    }

    void downloadFileForPreview()

    return () => {
      cancelled = true
      abortController.abort()
      wipeChunks()
    }
  }, [application, downloadedBytes, file, isFilePreviewable, isAuthorized])

  if (!isAuthorized) {
    const hasProtectionSources = application.hasProtectionSources()

    return (
      <div className="flex flex-grow flex-col items-center justify-center">
        <ProtectedIllustration className="mb-4 h-30 w-30" />
        <div className="mb-2 text-base font-bold">{t('fileProtected')}</div>
        <p className="text-passive-0 max-w-[35ch] text-center text-sm">
          {hasProtectionSources ? t('authenticateToView') : t('addPasscodeToView')}
        </p>
        <div className="mt-3 flex gap-3">
          {!hasProtectionSources && (
            <Button primary small onClick={() => application.showAccountMenu()}>
              {t('openAccountMenu')}
            </Button>
          )}
          <Button primary onClick={() => application.protections.authorizeItemAccess(file)}>
            {hasProtectionSources ? t('authenticate') : t('viewFile')}
          </Button>
        </div>
      </div>
    )
  }

  return isDownloading ? (
    <div className="flex flex-grow flex-col items-center justify-center">
      <div className="flex items-center">
        <Spinner className="mr-3 h-5 w-5" />
        {downloadProgress && (
          <div className="text-base font-semibold">{Math.floor(downloadProgress.percentComplete)}%</div>
        )}
      </div>
      {downloadProgress ? (
        <span className="mt-3">
          {fileProgressToHumanReadableString(downloadProgress, file.name, { showPercent: false })}
        </span>
      ) : (
        <span className="mt-3">{t('loading')}</span>
      )}
    </div>
  ) : downloadedBytes ? (
    <PreviewComponent
      application={application}
      file={file}
      bytes={downloadedBytes}
      isEmbeddedInSuper={isEmbeddedInSuper}
      pdfTarget={pdfTarget}
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
  ) : (
    <FilePreviewError
      file={file}
      filesController={application.filesController}
      tryAgainCallback={() => {
        setDownloadedPreview(undefined)
      }}
      isFilePreviewable={isFilePreviewable}
    />
  )
}

export default FilePreview
