import { BlockWithAlignableContents } from '@lexical/react/LexicalBlockWithAlignableContents'
import { Platform, classNames } from '@standardnotes/snjs'
import { $getNodeByKey, CLICK_COMMAND, COMMAND_PRIORITY_LOW, ElementFormatType, NodeKey } from 'lexical'
import { InlineFileNode } from './InlineFileNode'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { useLexicalNodeSelection } from '@lexical/react/useLexicalNodeSelection'
import { useApplication } from '@/Components/ApplicationProvider'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { $createFileNode } from '../EncryptedFilePlugin/Nodes/FileUtils'
import { isIOS } from '@standardnotes/ui-services'
import Icon from '@/Components/Icon/Icon'
import Spinner from '@/Components/Spinner/Spinner'
import SuperEmbeddedImage from '../ImageTools/SuperEmbeddedImage'
import { ImageFloat } from '../ImageTools/ImageToolsTypes'
import { useNearViewport } from '@/Components/FilePreview/useNearViewport'
import {
  hasCompatibleInlineImageSource,
  hasSupportedImageSignature,
  resolvePreviewKind,
} from '@/Components/FilePreview/isFilePreviewable'
import { MAX_TEXT_PREVIEW_BYTES } from '@/Components/FilePreview/textPreviewContent'
import { lazyWithRetry } from '@/Utils/lazyWithRetry'
import { BoundedSourceFetchError, fetchBoundedSourceBytes } from '@/Components/FilePreview/fetchBoundedSourceBytes'
import { MAX_LOCAL_FILE_SIZE } from '@/Constants/Constants'

const PdfPreview = lazyWithRetry(() => import('@/Components/FilePreview/PdfPreview'))
const TextPreview = lazyWithRetry(() => import('@/Components/FilePreview/TextPreview'))

const MAX_INLINE_PDF_PREVIEW_BYTES = 100 * 1024 * 1024
const MAX_INLINE_IMAGE_PREVIEW_BYTES = 100 * 1024 * 1024
export const INLINE_PREVIEW_IDLE_TIMEOUT_MS = 45_000
export const INLINE_SAVE_IDLE_TIMEOUT_MS = 45_000

type Props = {
  fileName: string | undefined
  mimeType: string
  src: string
  className: Readonly<{
    base: string
    focus: string
  }>
  format: ElementFormatType | null
  setFormat: (format: ElementFormatType) => void
  node: InlineFileNode
  nodeKey: NodeKey
  width: number | undefined
  setWidth: (width: number | undefined) => void
  caption: string | undefined
  setCaption: (caption: string | undefined) => void
  float: ImageFloat
  setFloat: (float: ImageFloat) => void
}

const InlineFileComponent = ({
  className,
  src,
  mimeType,
  fileName,
  format,
  setFormat,
  node,
  nodeKey,
  width,
  setWidth,
  caption,
  setCaption,
  float,
  setFloat,
}: Props) => {
  const application = useApplication()
  const [editor] = useLexicalComposerContext()
  const previewWrapperRef = useRef<HTMLDivElement>(null)
  const { isNearViewport, loadNow, setViewportTarget } = useNearViewport()
  const setPreviewWrapper = useCallback(
    (element: HTMLDivElement | null) => {
      previewWrapperRef.current = element
      setViewportTarget(element)
    },
    [setViewportTarget],
  )
  const [isSelected, setSelected] = useLexicalNodeSelection(nodeKey)

  useEffect(() => {
    return editor.registerCommand<MouseEvent>(
      CLICK_COMMAND,
      (event) => {
        if (previewWrapperRef.current?.contains(event.target as Node)) {
          event.preventDefault()
          $getNodeByKey(nodeKey)?.selectEnd()
          setTimeout(() => {
            setSelected(!isSelected)
          })
          return true
        }
        return false
      },
      COMMAND_PRIORITY_LOW,
    )
  }, [editor, isSelected, nodeKey, setSelected])

  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string>()
  const saveGenerationRef = useRef(0)
  const saveAbortRef = useRef<AbortController | undefined>(undefined)

  const cancelPendingSave = useCallback(() => {
    saveGenerationRef.current++
    saveAbortRef.current?.abort()
    saveAbortRef.current = undefined
  }, [])

  useEffect(() => {
    cancelPendingSave()
    setIsSaving(false)
    setSaveError(undefined)

    return cancelPendingSave
  }, [cancelPendingSave, src])

  const saveToFilesAndReplaceNode = useCallback(async () => {
    if (isSaving) {
      return
    }

    const generation = ++saveGenerationRef.current
    const controller = new AbortController()
    saveAbortRef.current?.abort()
    saveAbortRef.current = controller
    setIsSaving(true)
    setSaveError(undefined)
    let sourceBytes: Uint8Array | undefined
    try {
      sourceBytes = await fetchBoundedSourceBytes(src, {
        maximumBytes: MAX_LOCAL_FILE_SIZE,
        idleTimeoutMs: INLINE_SAVE_IDLE_TIMEOUT_MS,
        signal: controller.signal,
      })
      if (controller.signal.aborted || saveGenerationRef.current !== generation) {
        return
      }

      const file = new File([sourceBytes as BlobPart], fileName || application.generateUUID(), { type: mimeType })
      sourceBytes.fill(0)
      sourceBytes = undefined

      const { filesController } = application
      const uploadedFile = await filesController.uploadNewFile(file, { showToast: false })
      if (controller.signal.aborted || saveGenerationRef.current !== generation) {
        return
      }
      if (!uploadedFile) {
        setSaveError('This file could not be saved. Please retry.')
        return
      }

      editor.update(() => {
        const fileNode = $createFileNode(uploadedFile.uuid)
        node.replace(fileNode)
      })
    } catch (error) {
      if (!controller.signal.aborted && saveGenerationRef.current === generation) {
        const message =
          error instanceof BoundedSourceFetchError && error.code === 'size-limit'
            ? 'This file exceeds the maximum supported attachment size.'
            : error instanceof BoundedSourceFetchError && error.code === 'timeout'
              ? 'The file source stopped responding. Please retry.'
              : 'This file could not be saved. Please retry.'
        setSaveError(message)
      }
    } finally {
      sourceBytes?.fill(0)
      if (saveGenerationRef.current === generation) {
        saveAbortRef.current = undefined
        setIsSaving(false)
      }
    }
  }, [application, editor, fileName, isSaving, mimeType, node, src])

  const previewKind = useMemo(() => {
    const metadata = { name: fileName, mimeType }
    const resolved = resolvePreviewKind(metadata)
    return resolved === 'image' && !hasCompatibleInlineImageSource(metadata, src) ? 'unsupported' : resolved
  }, [fileName, mimeType, src])
  const usesValidatedDataImage = previewKind === 'image' && src.trimStart().toLowerCase().startsWith('data:')
  const requiresFetchedBytes =
    previewKind === 'pdf' || previewKind === 'text' || (previewKind === 'image' && !usesValidatedDataImage)
  const maximumPreviewBytes =
    previewKind === 'text'
      ? MAX_TEXT_PREVIEW_BYTES
      : previewKind === 'image'
        ? MAX_INLINE_IMAGE_PREVIEW_BYTES
        : MAX_INLINE_PDF_PREVIEW_BYTES
  const previewInput = useMemo(() => ({ src, previewKind, fileName, mimeType }), [fileName, mimeType, previewKind, src])
  const loadGenerationRef = useRef(0)
  const [retryGeneration, setRetryGeneration] = useState(0)
  const [previewLoad, setPreviewLoad] = useState<{
    input: object
    status: 'loading' | 'ready' | 'error'
    bytes?: Uint8Array
    objectUrl?: string
  }>()
  const currentPreviewLoad = previewLoad?.input === previewInput ? previewLoad : undefined

  useEffect(() => {
    if (!isNearViewport || !requiresFetchedBytes) {
      return
    }

    const generation = ++loadGenerationRef.current
    const controller = new AbortController()
    let loadedBytes: Uint8Array | undefined
    let loadedObjectUrl: string | undefined
    const isCurrent = () => !controller.signal.aborted && loadGenerationRef.current === generation

    setPreviewLoad((previous) => {
      previous?.bytes?.fill(0)
      return { input: previewInput, status: 'loading' }
    })

    void fetchBoundedSourceBytes(src, {
      maximumBytes: maximumPreviewBytes,
      idleTimeoutMs: INLINE_PREVIEW_IDLE_TIMEOUT_MS,
      signal: controller.signal,
    })
      .then((bytes) => {
        loadedBytes = bytes
        if (!isCurrent()) {
          bytes.fill(0)
          loadedBytes = undefined
          return
        }

        if (previewKind === 'image') {
          if (!hasSupportedImageSignature({ mimeType, name: fileName }, bytes)) {
            bytes.fill(0)
            loadedBytes = undefined
            throw new Error('The inline image signature does not match its declared type')
          }
          loadedObjectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }))
          bytes.fill(0)
          loadedBytes = undefined
          setPreviewLoad({ input: previewInput, status: 'ready', objectUrl: loadedObjectUrl })
          return
        }

        setPreviewLoad({ input: previewInput, status: 'ready', bytes })
      })
      .catch(() => {
        loadedBytes?.fill(0)
        loadedBytes = undefined
        if (isCurrent()) {
          setPreviewLoad({ input: previewInput, status: 'error' })
        }
      })

    return () => {
      controller.abort()
      loadedBytes?.fill(0)
      if (loadedObjectUrl) {
        URL.revokeObjectURL(loadedObjectUrl)
      }
    }
  }, [
    fileName,
    isNearViewport,
    maximumPreviewBytes,
    mimeType,
    previewInput,
    previewKind,
    requiresFetchedBytes,
    retryGeneration,
    src,
  ])

  const imageSource =
    previewKind === 'image'
      ? usesValidatedDataImage
        ? src
        : currentPreviewLoad?.status === 'ready'
          ? currentPreviewLoad.objectUrl
          : undefined
      : undefined

  const changeAlignment = useCallback(
    (format: ElementFormatType) => {
      editor.update(() => {
        setFormat(format)
      })
    },
    [editor, setFormat],
  )
  const changeWidth = useCallback(
    (newWidth: number | undefined) => editor.update(() => setWidth(newWidth)),
    [editor, setWidth],
  )
  const changeCaption = useCallback(
    (newCaption: string | undefined) => editor.update(() => setCaption(newCaption)),
    [editor, setCaption],
  )
  const changeFloat = useCallback((newFloat: ImageFloat) => editor.update(() => setFloat(newFloat)), [editor, setFloat])

  return (
    <BlockWithAlignableContents className={className} format={format} nodeKey={nodeKey}>
      <div ref={setPreviewWrapper}>
        {!isNearViewport ? (
          <div
            className="border-border text-passive-1 flex min-h-24 flex-col items-center justify-center gap-2 rounded border p-4 text-center text-sm"
            data-inline-preview-deferred="true"
            role="status"
          >
            <span>Preview loads when this attachment is near the viewport.</span>
            <button
              className="border-border bg-default text-text hover:bg-contrast rounded border px-2.5 py-1.5 text-sm"
              onClick={loadNow}
              type="button"
            >
              Load preview
            </button>
          </div>
        ) : previewKind === 'image' && imageSource ? (
          <div
            className="group relative flex min-h-[2rem] flex-col gap-2.5"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
            }}
          >
            <SuperEmbeddedImage
              src={imageSource}
              alt={fileName}
              alignment={format ?? ''}
              onAlignmentChange={changeAlignment}
              width={width}
              onWidthChange={changeWidth}
              caption={caption}
              onCaptionChange={changeCaption}
              float={float}
              onFloatChange={changeFloat}
              isSelected={isSelected}
            />
          </div>
        ) : previewKind === 'video' ? (
          <video className="h-full w-full" controls preload="metadata" data-super-widget-layout="media">
            <source src={src} type={mimeType} />
          </video>
        ) : previewKind === 'audio' ? (
          <div className="flex h-full w-full items-center justify-center" data-super-widget-layout="compact">
            <audio controls preload="metadata">
              <source src={src} type={mimeType} />
            </audio>
          </div>
        ) : currentPreviewLoad?.status === 'ready' && currentPreviewLoad.bytes ? (
          <Suspense
            fallback={
              <div className="text-passive-1 flex min-h-[12rem] items-center justify-center gap-2" role="status">
                <Spinner className="h-5 w-5" />
                Loading preview viewer...
              </div>
            }
          >
            {previewKind === 'pdf' ? (
              <div
                className="h-[clamp(20rem,65vh,48rem)] w-full overflow-hidden"
                data-inline-pdf-viewport="true"
                data-super-widget-layout="media"
              >
                <PdfPreview application={application} bytes={currentPreviewLoad.bytes} />
              </div>
            ) : (
              <div className="h-[clamp(16rem,55vh,40rem)] w-full overflow-hidden" data-super-widget-layout="media">
                <TextPreview
                  bytes={currentPreviewLoad.bytes}
                  fileName={fileName ?? 'Untitled file'}
                  mimeType={mimeType}
                />
              </div>
            )}
          </Suspense>
        ) : currentPreviewLoad?.status === 'error' ? (
          <div className="border-border text-danger flex min-h-[12rem] flex-col items-center justify-center gap-3 rounded border p-4 text-center">
            This file could not be previewed safely. You can retry or save it to Files below.
            <button
              className="border-border bg-default text-text hover:bg-contrast rounded border px-2.5 py-1.5 text-sm"
              onClick={() => setRetryGeneration((generation) => generation + 1)}
              type="button"
            >
              Retry preview
            </button>
          </div>
        ) : requiresFetchedBytes ? (
          <div
            className="text-passive-1 flex min-h-[12rem] items-center justify-center gap-2"
            role="status"
            aria-label="Loading file preview"
          >
            <Spinner className="h-5 w-5" />
            Loading file preview...
          </div>
        ) : (
          <div className="border-border text-passive-1 rounded border p-4 text-center">
            Preview is not available for this file type. You can save it to Files below.
          </div>
        )}
      </div>
      {saveError && (
        <div className="text-danger mx-auto mt-2 text-center text-sm" role="alert">
          {saveError}
        </div>
      )}
      <button
        className={classNames(
          'border-border bg-default mx-auto mt-2 flex items-center gap-2.5 rounded border px-2.5 py-1.5',
          !isSaving && 'hover:bg-info hover:text-info-contrast',
        )}
        onClick={() => {
          const isIOSPlatform = application.platform === Platform.Ios || isIOS()
          if (isIOSPlatform && document.activeElement) {
            ;(document.activeElement as HTMLElement).blur()
          }
          void saveToFilesAndReplaceNode()
        }}
        disabled={isSaving}
      >
        {isSaving ? (
          <>
            <Spinner className="h-4 w-4" />
            Saving...
          </>
        ) : (
          <>
            <Icon type="download" />
            {saveError ? 'Retry save' : 'Save to Files'}
          </>
        )}
      </button>
    </BlockWithAlignableContents>
  )
}

export default InlineFileComponent
