import { BlockWithAlignableContents } from '@lexical/react/LexicalBlockWithAlignableContents'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  $getNodeByKey,
  CLICK_COMMAND,
  COMMAND_PRIORITY_LOW,
  ElementFormatType,
  NodeKey,
  SKIP_DOM_SELECTION_TAG,
} from 'lexical'
import { useApplication } from '@/Components/ApplicationProvider'
import FilePreview from '@/Components/FilePreview/FilePreview'
import { FileItem } from '@standardnotes/snjs'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { useLexicalNodeSelection } from '@lexical/react/useLexicalNodeSelection'
import { observer } from 'mobx-react-lite'
import Spinner from '@/Components/Spinner/Spinner'
import { FilesControllerEvent } from '@/Controllers/FilesController'
import { ImageFloat } from '../../ImageTools/ImageToolsTypes'
import Icon from '@/Components/Icon/Icon'
import { getIconForFileType } from '@/Utils/Items/Icons/getIconForFileType'
import { formatSizeToReadableString } from '@standardnotes/filepicker'

export type FileComponentProps = Readonly<{
  className: Readonly<{
    base: string
    focus: string
  }>
  format: ElementFormatType | null
  setFormat: (format: ElementFormatType) => void
  nodeKey: NodeKey
  fileUuid: string
  zoomLevel: number
  setZoomLevel: (zoomLevel: number) => void
  width: number | undefined
  setWidth: (width: number | undefined) => void
  caption: string | undefined
  setCaption: (caption: string | undefined) => void
  float: ImageFloat
  setFloat: (float: ImageFloat) => void
  collapsed: boolean | undefined
  setCollapsed: (collapsed: boolean | undefined) => void
}>

/**
 * Per-type default fold state for embedded files that have no explicit stored
 * `collapsed` value (existing notes / freshly inserted files). PDFs collapse by
 * default so notes stay short; images (which have zoom/resize tools) and other
 * types default to expanded. An explicit stored value always wins.
 */
function defaultCollapsedForMimeType(mimeType: string): boolean {
  return mimeType === 'application/pdf'
}

function FileComponent({
  className,
  format,
  setFormat,
  nodeKey,
  fileUuid,
  zoomLevel,
  setZoomLevel,
  width,
  setWidth,
  caption,
  setCaption,
  float,
  setFloat,
  collapsed,
  setCollapsed,
}: FileComponentProps) {
  const application = useApplication()
  const [editor] = useLexicalComposerContext()
  const [file, setFile] = useState(() => application.items.findItem<FileItem>(fileUuid))
  const uploadProgress = application.filesController.uploadProgressMap.get(fileUuid)

  const [canLoad, setCanLoad] = useState(false)

  const blockWrapperRef = useRef<HTMLDivElement>(null)
  const blockObserver = useMemo(
    () =>
      new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              setCanLoad(true)
            }
          })
        },
        {
          threshold: 0.25,
        },
      ),
    [],
  )

  useEffect(() => {
    const wrapper = blockWrapperRef.current

    if (!wrapper) {
      return
    }

    blockObserver.observe(wrapper)

    return () => {
      blockObserver.unobserve(wrapper)
    }
  }, [blockObserver])

  const setImageZoomLevel = useCallback(
    (zoomLevel: number) => {
      editor.update(() => {
        setZoomLevel(zoomLevel)
      })
    },
    [editor, setZoomLevel],
  )

  const changeAlignment = useCallback(
    (alignment: ElementFormatType) =>
      editor.update(
        () => {
          setFormat(alignment)
        },
        {
          tag: SKIP_DOM_SELECTION_TAG,
        },
      ),
    [editor, setFormat],
  )

  const [isSelected, setSelected] = useLexicalNodeSelection(nodeKey)

  const changeWidth = useCallback(
    (newWidth: number | undefined) =>
      editor.update(
        () => {
          setWidth(newWidth)
        },
        { tag: SKIP_DOM_SELECTION_TAG },
      ),
    [editor, setWidth],
  )

  const changeCaption = useCallback(
    (newCaption: string | undefined) =>
      editor.update(
        () => {
          setCaption(newCaption)
        },
        { tag: SKIP_DOM_SELECTION_TAG },
      ),
    [editor, setCaption],
  )

  const changeFloat = useCallback(
    (newFloat: ImageFloat) =>
      editor.update(
        () => {
          setFloat(newFloat)
        },
        { tag: SKIP_DOM_SELECTION_TAG },
      ),
    [editor, setFloat],
  )

  const changeCollapsed = useCallback(
    (newCollapsed: boolean) =>
      editor.update(
        () => {
          setCollapsed(newCollapsed)
        },
        { tag: SKIP_DOM_SELECTION_TAG },
      ),
    [editor, setCollapsed],
  )

  const openInLightbox = useCallback(() => {
    if (file && file.mimeType.startsWith('image/')) {
      application.filePreviewModalController.activate(file)
    }
  }, [application, file])

  useEffect(() => {
    return editor.registerCommand<MouseEvent>(
      CLICK_COMMAND,
      (event) => {
        if (blockWrapperRef.current?.contains(event.target as Node)) {
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

  useEffect(() => {
    return application.filesController.addEventObserver((event, data) => {
      if (event === FilesControllerEvent.FileUploadFinished && data[FilesControllerEvent.FileUploadFinished]) {
        const { uploadedFile } = data[FilesControllerEvent.FileUploadFinished]
        if (uploadedFile.uuid === fileUuid) {
          setFile(uploadedFile)
        }
      }
    })
  }, [application.filesController, fileUuid])

  if (uploadProgress && (uploadProgress.progress < 100 || !file)) {
    const progress = uploadProgress.progress
    return (
      <BlockWithAlignableContents className={className} format={format} nodeKey={nodeKey}>
        <div className="flex flex-col items-center justify-center gap-2 p-4 text-center" ref={blockWrapperRef}>
          <div className="flex items-center gap-2">
            <Spinner className="h-4 w-4" />
            Uploading file "{uploadProgress.file.name}"... ({progress}%)
          </div>
          <div className="w-full max-w-[50%] overflow-hidden rounded bg-contrast">
            <div
              className="h-2 rounded rounded-tl-none bg-info transition-[width] duration-100"
              role="progressbar"
              style={{
                width: `${progress}%`,
              }}
              aria-valuenow={progress}
            />
          </div>
        </div>
      </BlockWithAlignableContents>
    )
  }

  if (!file) {
    return (
      <BlockWithAlignableContents className={className} format={format} nodeKey={nodeKey}>
        <div>Unable to find file {fileUuid}</div>
      </BlockWithAlignableContents>
    )
  }

  const isImage = file.mimeType.startsWith('image/')
  // Explicit stored value wins; otherwise fall back to the per-type default.
  const isCollapsed = collapsed ?? defaultCollapsedForMimeType(file.mimeType)
  const fileIcon = getIconForFileType(file.mimeType)
  const readableSize = file.decryptedSize ? formatSizeToReadableString(file.decryptedSize) : undefined

  if (isCollapsed) {
    return (
      <BlockWithAlignableContents className={className} format={format} nodeKey={nodeKey}>
        <div ref={blockWrapperRef}>
          <div className="flex items-center gap-2 rounded border border-border bg-default px-3 py-2">
            <button
              className="flex flex-shrink-0 items-center justify-center rounded p-1 text-neutral hover:bg-contrast"
              aria-label="Expand file preview"
              title="Expand file preview"
              onClick={() => changeCollapsed(false)}
            >
              <Icon type="chevron-right" size="medium" />
            </button>
            <button
              className="flex min-w-0 flex-grow items-center gap-2 text-left"
              title={`Expand "${file.name}"`}
              onClick={() => changeCollapsed(false)}
            >
              <Icon type={fileIcon} className="flex-shrink-0 text-neutral" size="medium" />
              <span className="min-w-0 truncate font-medium">{file.name}</span>
              {readableSize && <span className="flex-shrink-0 text-sm text-passive-1">{readableSize}</span>}
            </button>
          </div>
        </div>
      </BlockWithAlignableContents>
    )
  }

  return (
    <BlockWithAlignableContents className={className} format={format} nodeKey={nodeKey}>
      <div
        ref={blockWrapperRef}
        onDoubleClick={isImage ? openInLightbox : undefined}
        title={isImage ? 'Double-click to open zoomable preview' : undefined}
      >
        <div className="mb-1 flex items-center gap-2">
          <button
            className="flex items-center justify-center rounded p-1 text-neutral hover:bg-contrast"
            aria-label="Collapse file"
            title="Collapse file"
            onClick={() => changeCollapsed(true)}
          >
            <Icon type="chevron-down" size="medium" />
          </button>
          <Icon type={fileIcon} className="flex-shrink-0 text-neutral" size="medium" />
          <span className="min-w-0 truncate text-sm text-passive-0">{file.name}</span>
        </div>
        {canLoad && (
          <FilePreview
            isEmbeddedInSuper={true}
            file={file}
            application={application}
            imageZoomLevel={zoomLevel}
            setImageZoomLevel={setImageZoomLevel}
            alignment={format}
            changeAlignment={changeAlignment}
            imageWidth={width}
            setImageWidth={changeWidth}
            caption={caption}
            setCaption={changeCaption}
            float={float}
            setFloat={changeFloat}
            isImageSelected={isSelected}
          />
        )}
      </div>
    </BlockWithAlignableContents>
  )
}

export default observer(FileComponent)
