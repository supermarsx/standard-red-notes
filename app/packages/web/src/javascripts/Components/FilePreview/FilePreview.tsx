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
/**
 * Wall-clock ceiling for one preview, spanning every restart. The per-attempt
 * idle timeout bounds a stalled socket; this bounds the other way a preview can
 * hang: an item that keeps being re-applied locally (a churning sync) re-keying
 * the download faster than it can finish. Without it the spinner is unbounded
 * even though every individual attempt is bounded.
 */
export const PREVIEW_TOTAL_DEADLINE_MS = 120_000

type Props = {
  application: WebApplication
  file: FileItem
  isEmbeddedInSuper?: boolean
  pdfTarget?: PdfDeepLinkTarget
} & OptionalSuperEmbeddedImageProps

type DownloadedPreview = {
  identity: string
  bytes: Uint8Array
}

/**
 * Identifies the bytes a download would fetch and the material needed to decrypt
 * them — deliberately NOT the FileItem's object identity.
 *
 * Items are immutable, so a rename, a description edit, a link, a protection
 * toggle, or a plain sync re-apply all publish a brand new FileItem for the same
 * stored payload. Keying the download effect on the object meant any of those
 * aborted the transfer, discarded every chunk already decrypted, and started
 * over at byte zero; while sync churned an item the preview could restart
 * forever and never render. Keying on this string instead means only a change
 * that genuinely invalidates the transfer restarts it.
 */
function downloadIdentityOf(file: FileItem | undefined): string | undefined {
  if (!file) {
    return undefined
  }

  return JSON.stringify([
    file.uuid,
    file.remoteIdentifier,
    file.key,
    file.encryptionHeader,
    file.encryptedChunkSizes ?? null,
    file.shared_vault_uuid ?? null,
  ])
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
  const downloadIdentity = useMemo(() => downloadIdentityOf(authoritativeFile), [authoritativeFile])
  const currentFileIdentityRef = useRef(downloadIdentity)
  currentFileIdentityRef.current = downloadIdentity
  // The download runs against the live item rather than the object captured when
  // the effect started, so a rename or protection change mid-transfer is honored
  // without the transfer itself being restarted.
  const fileForDownloadRef = useRef(authoritativeFile)
  fileForDownloadRef.current = authoritativeFile

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
    downloadIdentity !== undefined && downloadedPreview?.identity === downloadIdentity
      ? downloadedPreview.bytes
      : undefined
  // Anchored to the mount, not to a single attempt, so restarts cannot extend it.
  // Cleared only by a completed preview or an explicit retry.
  const deadlineAtRef = useRef(0)

  useEffect(() => {
    return () => {
      downloadedPreview?.bytes.fill(0)
    }
  }, [downloadedPreview])

  useLayoutEffect(() => {
    setDownloadError(undefined)
    setDownloadedPreview((preview) => {
      if (preview && (!isAuthorized || downloadIdentity === undefined || preview.identity !== downloadIdentity)) {
        preview.bytes.fill(0)
        return undefined
      }
      return preview
    })

    if (!isAuthorized) {
      setIsDownloading(false)
      setDownloadProgress(undefined)
    }
  }, [downloadIdentity, isAuthorized])

  useEffect(() => {
    if (downloadIdentity === undefined || !canPreviewFile || !isAuthorized) {
      setIsDownloading(false)
      setDownloadProgress(undefined)
      return
    }

    // A restart that arrives after the ceiling means the item is being re-applied
    // faster than the file can be fetched. Say that, rather than spinning on.
    if (deadlineAtRef.current !== 0 && Date.now() >= deadlineAtRef.current) {
      setIsDownloading(false)
      setDownloadProgress(undefined)
      setDownloadError(t('filePreviewKeptRestarting'))
      return
    }
    if (deadlineAtRef.current === 0) {
      deadlineAtRef.current = Date.now() + PREVIEW_TOTAL_DEADLINE_MS
    }

    let cancelled = false
    let activeAttempt = -1
    let activeAbortController: AbortController | undefined
    let activeClearIdleTimeout: (() => void) | undefined
    let activeChunks: Uint8Array[] = []
    const identity = downloadIdentity
    const wipeChunks = (chunks: Uint8Array[]) => {
      for (const chunk of chunks) {
        chunk.fill(0)
      }
      chunks.length = 0
    }
    const isCurrentDownload = () => {
      return !cancelled && authorizationRef.current && currentFileIdentityRef.current === identity
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

          const fileForDownload = fileForDownloadRef.current
          if (!fileForDownload) {
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
              // A rendered preview retires the ceiling; a later re-key starts fresh.
              deadlineAtRef.current = 0
              return { identity, bytes: finalDecryptedBytes }
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

    // An unexpected throw (rather than a rejected download) must still land on a
    // terminal state. Leaving it to an unhandled rejection kept `isDownloading`
    // true and produced a permanent spinner with nothing explaining it.
    downloadFileForPreview().catch((error: unknown) => {
      if (!isCurrentDownload()) {
        return
      }
      console.error(error)
      setIsDownloading(false)
      setDownloadProgress(undefined)
      setDownloadError(sanitizeFileErrorDetail(error) ?? t('errorLoadingFile'))
    })

    return () => {
      cancelled = true
      activeClearIdleTimeout?.()
      activeAbortController?.abort()
      wipeChunks(activeChunks)
    }
  }, [
    application,
    downloadIdentity,
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
      deadlineAtRef.current = 0
      setRetryGeneration((generation) => generation + 1)
    }
  }, [application, file.uuid])

  const retryPreview = useCallback(() => {
    deadlineAtRef.current = 0
    setRetryGeneration((generation) => generation + 1)
  }, [])

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
      tryAgainCallback={retryPreview}
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
