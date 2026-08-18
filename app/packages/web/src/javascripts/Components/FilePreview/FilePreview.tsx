import type { WebApplication } from '@/Application/WebApplication'
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
export const PREVIEW_DOWNLOAD_IDLE_TIMEOUT_MS = 45_000
const MAX_PREVIEW_DOWNLOAD_ATTEMPTS = 2

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
function useAuthoritativeFile(application: WebApplication, file: FileItem): FileItem | undefined {
  const hasObservedManagedItem = useRef(false)
  const mayUseFreshUploadMetadata =
    file.dirty === true && file.remoteIdentifier.length > 0 && file.encryptedChunkSizes.length > 0
  const getSnapshot = useCallback(() => {
    const managedFile = application.items.findItem<FileItem>(file.uuid)
    if (managedFile) {
      hasObservedManagedItem.current = true
      return managedFile
    }

    // finishUpload returns a complete dirty FileItem. A toolbar click can beat
    // the subsequent list/store publication, so allow that exact provisional
    // object until ItemManager has observed it. Once observed, removal fails
    // closed and can never fall back to the stale prop.
    return !hasObservedManagedItem.current && mayUseFreshUploadMetadata ? file : undefined
  }, [application.items, file, mayUseFreshUploadMetadata])
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      application.items.streamItems<FileItem>(ContentType.TYPES.File, ({ changed, inserted, removed }) => {
        if (
          changed.some((candidate) => candidate.uuid === file.uuid) ||
          inserted.some((candidate) => candidate.uuid === file.uuid) ||
          removed.some((candidate) => candidate.uuid === file.uuid)
        ) {
          onStoreChange()
        }
      }),
    [application.items, file.uuid],
  )

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

function isAbortLikeError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === 'AbortError') ||
    sanitizeFileErrorDetail(error)?.toLowerCase().includes('ns_binding_aborted') === true
  )
}

function isRetriablePreviewDownloadFailure(error: unknown): boolean {
  if (isAbortLikeError(error)) {
    return true
  }
  const detail = sanitizeFileErrorDetail(error)?.toLowerCase()
  return (
    detail !== undefined &&
    [
      'network request failed',
      'failed to fetch',
      'load failed',
      'request timed out',
      'failed to download file chunk',
    ].some((message) => detail.includes(message))
  )
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
  const authoritativeFile = useAuthoritativeFile(application, file)
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
    let activeAttempt = -1
    let activeAbortController: AbortController | undefined
    let activeClearIdleTimeout: (() => void) | undefined
    let activeChunks: Uint8Array[] = []
    const fileForDownload = authoritativeFile
    const fileUuid = fileForDownload.uuid
    const remoteIdentifier = fileForDownload.remoteIdentifier
    const wipeChunks = (chunks: Uint8Array[]) => {
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
        for (let attempt = 0; attempt < MAX_PREVIEW_DOWNLOAD_ATTEMPTS; attempt++) {
          if (!isCurrentDownload()) {
            return
          }

          activeAttempt = attempt
          const abortController = new AbortController()
          activeAbortController = abortController
          const chunks: Uint8Array[] = []
          activeChunks = chunks
          let receivedBytes = 0
          let exceededPreviewLimit = false
          let idleTimeout: ReturnType<typeof setTimeout> | undefined
          let settleTimeout!: () => void
          const timeoutPromise = new Promise<{ kind: 'timeout' }>((resolve) => {
            settleTimeout = () => resolve({ kind: 'timeout' })
          })
          const clearIdleTimeout = () => {
            if (idleTimeout !== undefined) {
              clearTimeout(idleTimeout)
              idleTimeout = undefined
            }
          }
          activeClearIdleTimeout = clearIdleTimeout
          const armIdleTimeout = () => {
            clearIdleTimeout()
            idleTimeout = setTimeout(() => {
              abortController.abort()
              settleTimeout()
            }, PREVIEW_DOWNLOAD_IDLE_TIMEOUT_MS)
          }
          const isCurrentAttempt = () => isCurrentDownload() && activeAttempt === attempt

          armIdleTimeout()
          const downloadPromise = application.files
            .downloadFile(
              fileForDownload,
              async (decryptedChunk, progress) => {
                if (!isCurrentAttempt()) {
                  decryptedChunk.fill(0)
                  return
                }
                armIdleTimeout()
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
            .then(
              (error) => ({ kind: 'complete' as const, error }),
              (error: unknown) => ({ kind: 'thrown' as const, error }),
            )

          const outcome = await Promise.race([downloadPromise, timeoutPromise])
          clearIdleTimeout()
          activeClearIdleTimeout = undefined

          if (!isCurrentAttempt()) {
            wipeChunks(chunks)
            return
          }
          if (exceededPreviewLimit) {
            wipeChunks(chunks)
            setDownloadError(t('filePreviewTooLarge'))
            return
          }

          const failure =
            outcome.kind === 'complete' ? outcome.error : outcome.kind === 'thrown' ? outcome.error : undefined
          const endedWithoutBytes =
            !failure && outcome.kind !== 'timeout' && receivedBytes === 0 && fileForDownload.decryptedSize > 0
          const shouldRetry =
            attempt + 1 < MAX_PREVIEW_DOWNLOAD_ATTEMPTS &&
            (outcome.kind === 'timeout' || endedWithoutBytes || isRetriablePreviewDownloadFailure(failure))

          if (failure || outcome.kind === 'timeout' || endedWithoutBytes) {
            wipeChunks(chunks)
            setDownloadProgress(undefined)
            if (shouldRetry) {
              continue
            }
            if (outcome.kind === 'thrown' && !isAbortLikeError(failure)) {
              console.error(failure)
            }
            setDownloadError(sanitizeFileErrorDetail(failure) ?? t('errorLoadingFile'))
            return
          }

          if (application.isAuthorizedToRenderItem(fileForDownload)) {
            const finalDecryptedBytes = concatenateUint8Arrays(chunks)
            setDownloadedPreview((currentPreview) => {
              if (!isCurrentAttempt() || !application.isAuthorizedToRenderItem(fileForDownload)) {
                finalDecryptedBytes.fill(0)
                return currentPreview
              }
              currentPreview?.bytes.fill(0)
              return { fileUuid, remoteIdentifier, bytes: finalDecryptedBytes }
            })
            wipeChunks(chunks)
            return
          }
        }
      } finally {
        activeAbortController = undefined
        activeClearIdleTimeout?.()
        activeClearIdleTimeout = undefined
        wipeChunks(activeChunks)
        if (isCurrentDownload()) {
          setIsDownloading(false)
        }
      }
    }

    void downloadFileForPreview()

    return () => {
      cancelled = true
      activeClearIdleTimeout?.()
      activeAbortController?.abort()
      wipeChunks(activeChunks)
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
