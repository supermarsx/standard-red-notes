import { WebApplication } from '@/Application/WebApplication'
import { concatenateUint8Arrays } from '@/Utils'
import { ContentType, FileDownloadProgress, FileItem, fileProgressToHumanReadableString } from '@standardnotes/snjs'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import Spinner from '@/Components/Spinner/Spinner'
import FilePreviewError from './FilePreviewError'
import { isFilePreviewable, resolvePreviewKind } from './isFilePreviewable'
import PreviewComponent from './PreviewComponent'
import Button from '../Button/Button'
import { ProtectedIllustration } from '@standardnotes/icons'
import { OptionalSuperEmbeddedImageProps } from './OptionalSuperEmbeddedImageProps'
import { PdfDeepLinkTarget } from './PdfDeepLink'
import { useTranslation } from 'react-i18next'
import { useItemAuthorization } from '@/Hooks/useItemAuthorization'
import { MAX_TEXT_PREVIEW_BYTES } from './textPreviewContent'
import { sanitizeFileErrorDetail } from '@/Utils/FileErrorMessage'

const MAX_MEDIA_PREVIEW_BYTES = 100 * 1024 * 1024

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

/**
 * File links and modal navigation can retain an older immutable FileItem after
 * sync replaces it. Authorization already resolves through ItemManager, so use
 * that same authoritative object for prompting and transport as well. An item
 * absent from ItemManager intentionally stays undefined (and therefore denied).
 */
function useAuthoritativeFile(application: WebApplication, fileUuid: string): FileItem | undefined {
  const getSnapshot = useCallback(() => application.items.findItem<FileItem>(fileUuid), [application.items, fileUuid])
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      application.items.streamItems<FileItem>(ContentType.TYPES.File, ({ changed, inserted, removed }) => {
        if (
          changed.some((candidate) => candidate.uuid === fileUuid) ||
          inserted.some((candidate) => candidate.uuid === fileUuid) ||
          removed.some((candidate) => candidate.uuid === fileUuid)
        ) {
          onStoreChange()
        }
      }),
    [application.items, fileUuid],
  )

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
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
  const authoritativeFile = useAuthoritativeFile(application, file.uuid)
  const isAuthorized = useItemAuthorization(application, authoritativeFile)
  const authorizationRef = useRef(isAuthorized)
  authorizationRef.current = isAuthorized
  const currentFileIdentityRef = useRef({
    uuid: authoritativeFile?.uuid,
    remoteIdentifier: authoritativeFile?.remoteIdentifier,
  })
  currentFileIdentityRef.current = {
    uuid: authoritativeFile?.uuid,
    remoteIdentifier: authoritativeFile?.remoteIdentifier,
  }

  const previewByteLimit = useMemo(() => {
    return authoritativeFile && resolvePreviewKind(authoritativeFile) === 'text'
      ? MAX_TEXT_PREVIEW_BYTES
      : MAX_MEDIA_PREVIEW_BYTES
  }, [authoritativeFile])
  const canPreviewFile = useMemo(() => {
    return (
      authoritativeFile !== undefined &&
      isFilePreviewable(authoritativeFile) &&
      Number.isSafeInteger(authoritativeFile.decryptedSize) &&
      authoritativeFile.decryptedSize >= 0 &&
      authoritativeFile.decryptedSize <= previewByteLimit
    )
  }, [authoritativeFile, previewByteLimit])

  const [isDownloading, setIsDownloading] = useState(true)
  const [downloadProgress, setDownloadProgress] = useState<FileDownloadProgress | undefined>()
  const [downloadedPreview, setDownloadedPreview] = useState<DownloadedPreview>()
  const [retryGeneration, setRetryGeneration] = useState(0)
  const [downloadError, setDownloadError] = useState<string>()
  const downloadedBytes =
    authoritativeFile &&
    downloadedPreview?.fileUuid === authoritativeFile.uuid &&
    downloadedPreview.remoteIdentifier === authoritativeFile.remoteIdentifier
      ? downloadedPreview.bytes
      : undefined

  useEffect(() => {
    return () => {
      downloadedPreview?.bytes.fill(0)
    }
  }, [downloadedPreview])

  useLayoutEffect(() => {
    setDownloadError(undefined)
    setDownloadedPreview((preview) => {
      if (
        preview &&
        (!isAuthorized ||
          !authoritativeFile ||
          preview.fileUuid !== authoritativeFile.uuid ||
          preview.remoteIdentifier !== authoritativeFile.remoteIdentifier)
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
  }, [authoritativeFile, isAuthorized])

  useEffect(() => {
    if (!authoritativeFile || !canPreviewFile || !isAuthorized) {
      setIsDownloading(false)
      setDownloadProgress(undefined)
      return
    }

    let cancelled = false
    const fileForDownload = authoritativeFile
    const fileUuid = fileForDownload.uuid
    const remoteIdentifier = fileForDownload.remoteIdentifier
    const abortController = new AbortController()
    const chunks: Uint8Array[] = []
    let receivedBytes = 0
    let exceededPreviewLimit = false
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
      setDownloadError(undefined)

      try {
        setDownloadProgress(undefined)
        const error = await application.files.downloadFile(
          fileForDownload,
          async (decryptedChunk, progress) => {
            if (!isCurrentDownload()) {
              decryptedChunk.fill(0)
              return
            }
            receivedBytes += decryptedChunk.byteLength
            if (!Number.isSafeInteger(receivedBytes) || receivedBytes > previewByteLimit) {
              exceededPreviewLimit = true
              decryptedChunk.fill(0)
              abortController.abort()
              return
            }
            chunks.push(decryptedChunk)
            if (progress) {
              setDownloadProgress(progress)
            }
          },
          { signal: abortController.signal },
        )

        if (exceededPreviewLimit && isCurrentDownload()) {
          setDownloadError(t('filePreviewTooLarge'))
        } else if (error && isCurrentDownload()) {
          setDownloadError(sanitizeFileErrorDetail(error) ?? t('errorLoadingFile'))
        } else if (!error && isCurrentDownload() && application.isAuthorizedToRenderItem(fileForDownload)) {
          const finalDecryptedBytes = concatenateUint8Arrays(chunks)
          setDownloadedPreview((currentPreview) => {
            if (!isCurrentDownload() || !application.isAuthorizedToRenderItem(fileForDownload)) {
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
          setDownloadError(sanitizeFileErrorDetail(error) ?? t('errorLoadingFile'))
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
  }, [
    application,
    authoritativeFile,
    canPreviewFile,
    downloadedBytes,
    isAuthorized,
    previewByteLimit,
    retryGeneration,
    t,
  ])

  const authorizeCurrentFile = useCallback(async () => {
    const currentFile = application.items.findItem<FileItem>(file.uuid)
    if (!currentFile) {
      return
    }

    const granted = await application.protections.authorizeItemAccess(currentFile)
    if (granted && application.isAuthorizedToRenderItem(currentFile)) {
      setRetryGeneration((generation) => generation + 1)
    }
  }, [application, file.uuid])

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
          <Button primary onClick={authorizeCurrentFile}>
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
          {fileProgressToHumanReadableString(downloadProgress, authoritativeFile?.name ?? file.name, {
            showPercent: false,
          })}
        </span>
      ) : (
        <span className="mt-3">{t('loading')}</span>
      )}
    </div>
  ) : downloadedBytes && authoritativeFile ? (
    <PreviewComponent
      application={application}
      file={authoritativeFile}
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
      file={authoritativeFile!}
      filesController={application.filesController}
      tryAgainCallback={() => {
        setRetryGeneration((generation) => generation + 1)
      }}
      isFilePreviewable={canPreviewFile}
      errorMessage={
        downloadError ??
        (authoritativeFile && isFilePreviewable(authoritativeFile) && !canPreviewFile
          ? t('filePreviewTooLarge')
          : undefined)
      }
    />
  )
}

export default FilePreview
