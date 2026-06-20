import { WebApplication } from '@/Application/WebApplication'
import { usePremiumModal } from '@/Hooks/usePremiumModal'
import { classNames } from '@standardnotes/utils'
import { isHandlingFileDrag } from '@/Utils/DragTypeCheck'
import { StreamingFileReader } from '@standardnotes/filepicker'
import { FileItem, SNNote } from '@standardnotes/snjs'
import { useMemo, useState, createContext, ReactNode, useRef, useCallback, useEffect, useContext, memo } from 'react'
import Portal from './Portal/Portal'
import { ElementIds } from '@/Constants/ElementIDs'
import { DirectoryEntryLike, flattenDirectoryEntries } from '@/Utils/DirectoryUpload'
import { uploadFilesWithFolderStructure } from '@/Utils/FolderUpload'

type FileDragTargetCommonData = {
  tooltipText: string
  note?: SNNote
}

type FileDragTargetCallbacks =
  | {
      callback: (files: FileItem) => void
      handleFileUpload?: never
    }
  | {
      handleFileUpload: (fileOrHandle: File | FileSystemFileHandle) => void
      callback?: never
    }
type FileDragTargetData = FileDragTargetCommonData & FileDragTargetCallbacks

type FileDnDContextData = {
  isDraggingFiles: boolean
  addDragTarget: (target: HTMLElement, data: FileDragTargetData) => void
  removeDragTarget: (target: HTMLElement) => void
}

export const FileDnDContext = createContext<FileDnDContextData | null>(null)

export const useFileDragNDrop = () => {
  const value = useContext(FileDnDContext)

  if (!value) {
    throw new Error('Current component must be a child of <FileDragNDropProvider />')
  }

  return value
}

type Props = {
  application: WebApplication
  children: ReactNode
}

const FileDragOverlayClassName =
  'overlay pointer-events-none absolute top-0 left-0 z-footer-bar h-full w-full border-2 border-info before:block before:h-full before:w-full before:bg-info before:opacity-20'

const MemoizedChildren = memo(({ children }: { children: ReactNode }) => {
  return <>{children}</>
})

const FileDragNDropProvider = ({ application, children }: Props) => {
  const premiumModal = usePremiumModal()
  const [isDraggingFiles, setIsDraggingFiles] = useState(false)
  const [tooltipText, setTooltipText] = useState('')

  const fileDragOverlayRef = useRef<HTMLDivElement>(null)

  const addOverlayToElement = useCallback((target: Element) => {
    if (fileDragOverlayRef.current) {
      const targetBoundingRect = target.getBoundingClientRect()
      fileDragOverlayRef.current.style.width = `${targetBoundingRect.width}px`
      fileDragOverlayRef.current.style.height = `${targetBoundingRect.height}px`
      fileDragOverlayRef.current.style.transform = `translate(${targetBoundingRect.x}px, ${targetBoundingRect.y}px)`
    }
  }, [])

  const removeOverlayFromElement = useCallback(() => {
    if (fileDragOverlayRef.current) {
      fileDragOverlayRef.current.style.width = ''
      fileDragOverlayRef.current.style.height = ''
      fileDragOverlayRef.current.style.transform = ''
    }
  }, [])

  const dragTargets = useRef<Map<Element, FileDragTargetData>>(new Map())

  const addDragTarget = useCallback((target: HTMLElement, data: FileDragTargetData) => {
    target.setAttribute('data-file-drag-target', '')
    dragTargets.current.set(target, data)
  }, [])

  const removeDragTarget = useCallback((target: HTMLElement) => {
    target.removeAttribute('data-file-drag-target')
    dragTargets.current.delete(target)
  }, [])

  const dragCounter = useRef(0)

  const resetState = useCallback(() => {
    setIsDraggingFiles(false)
    setTooltipText('')
    removeOverlayFromElement()
  }, [removeOverlayFromElement])

  const handleDrag = useCallback(
    (event: DragEvent) => {
      if (isHandlingFileDrag(event, application)) {
        event.preventDefault()
        event.stopPropagation()
      }
    },
    [application],
  )

  const handleDragStart = useCallback(
    (event: DragEvent) => {
      if (isHandlingFileDrag(event, application)) {
        event.preventDefault()
        event.stopPropagation()

        if (event.dataTransfer) {
          event.dataTransfer.clearData()
        }
      }
    },
    [application],
  )

  const handleDragIn = useCallback(
    (event: DragEvent) => {
      if (!isHandlingFileDrag(event, application)) {
        return
      }

      event.preventDefault()
      event.stopPropagation()

      removeOverlayFromElement()

      let closestDragTarget: Element | null = null

      if (event.target instanceof HTMLElement) {
        closestDragTarget = event.target.closest('[data-file-drag-target]')
      }

      dragCounter.current = dragCounter.current + 1

      if (event.dataTransfer?.items.length) {
        setIsDraggingFiles(true)
        if (closestDragTarget) {
          addOverlayToElement(closestDragTarget)
          const tooltipText = dragTargets.current.get(closestDragTarget)?.tooltipText
          if (tooltipText) {
            setTooltipText(tooltipText)
          }
        } else {
          setTooltipText('')
          removeOverlayFromElement()
        }
      }
    },
    [addOverlayToElement, application, removeOverlayFromElement],
  )

  const handleDragOut = useCallback(
    (event: DragEvent) => {
      if (!isHandlingFileDrag(event, application)) {
        return
      }

      event.preventDefault()
      event.stopPropagation()

      dragCounter.current = dragCounter.current - 1

      if (dragCounter.current > 0) {
        return
      }

      resetState()
    },
    [application, resetState],
  )

  const handleDrop = useCallback(
    (event: DragEvent) => {
      if (!isHandlingFileDrag(event, application)) {
        resetState()
        return
      }

      event.preventDefault()
      event.stopPropagation()

      let closestDragTarget: Element | null = null

      if (event.target instanceof HTMLElement) {
        closestDragTarget = event.target.closest('[data-file-drag-target]')
      }

      resetState()

      if (!application.featuresController.entitledToFiles) {
        premiumModal.activate('Files')
        return
      }

      if (event.dataTransfer?.items.length) {
        const dragTarget = closestDragTarget ? dragTargets.current.get(closestDragTarget) : undefined

        // The DataTransfer/DataTransferItemList becomes inert once this event
        // handler returns, so synchronously capture everything we need *before*
        // awaiting anything: each item's File / FileSystemFileHandle and, for
        // whole-folder drops, the directory entry from webkitGetAsEntry().
        const fileItems = Array.from(event.dataTransfer.items).filter((item) => item.kind === 'file')

        // Detect dropped directories. A target that embeds (e.g. Super note)
        // doesn't support folders, so we only do directory recreation for the
        // generic Files upload (no handleFileUpload).
        const directoryEntries: DirectoryEntryLike[] = []
        if (!dragTarget?.handleFileUpload && typeof DataTransferItem.prototype.webkitGetAsEntry === 'function') {
          for (const item of fileItems) {
            const entry = item.webkitGetAsEntry?.() as DirectoryEntryLike | null
            if (entry?.isDirectory) {
              directoryEntries.push(entry)
            }
          }
        }

        const useStreaming = StreamingFileReader.available()
        const pendingFilesOrHandles = fileItems.map((item) => {
          const entry = item.webkitGetAsEntry?.() as DirectoryEntryLike | null
          // Directories are handled via their entry below; skip them here.
          if (entry?.isDirectory) {
            return Promise.resolve(null)
          }
          return useStreaming
            ? (item.getAsFileSystemHandle!() as Promise<FileSystemFileHandle | null>)
            : Promise.resolve(item.getAsFile())
        })

        // Whole-folder drop(s): walk the directory tree(s).
        if (directoryEntries.length > 0) {
          void (async () => {
            const filesWithPaths = await flattenDirectoryEntries(directoryEntries)
            if (filesWithPaths.length === 0) {
              return
            }
            if (dragTarget?.note) {
              // Attaching to a note + filing into folders is ambiguous, so the
              // folder's files are uploaded flat and attached to the note.
              await application.filesController.uploadFiles(filesWithPaths, {
                note: dragTarget.note,
                onFileUploaded: dragTarget.callback ? (file) => dragTarget.callback(file) : undefined,
              })
            } else {
              // Recreate the dropped folder structure in the Files view.
              await uploadFilesWithFolderStructure(filesWithPaths, {
                filesController: application.filesController,
                navigationController: application.navigationController,
              })
            }
          })()
        }

        // Loose files (and any files for a note/embed target) upload individually.
        Promise.all(pendingFilesOrHandles)
          .then((resolved) => {
            const loose = resolved.filter((value): value is File | FileSystemFileHandle => value != null)
            if (loose.length === 0) {
              return
            }

            // A drag target that knows how to embed (e.g. a Super note) owns the
            // single upload + node insertion, so route each file to it directly.
            if (dragTarget?.handleFileUpload) {
              loose.forEach((fileOrHandle) => dragTarget.handleFileUpload(fileOrHandle))
              return
            }

            void application.filesController.uploadFiles(
              loose.map((fileOrHandle) => ({ file: fileOrHandle })),
              {
                note: dragTarget?.note,
                onFileUploaded: dragTarget?.callback ? (file) => dragTarget.callback(file) : undefined,
              },
            )
          })
          .catch(console.error)

        dragCounter.current = 0
      }
    },
    [application, premiumModal, resetState],
  )

  useEffect(() => {
    const appGroupRoot = document.getElementById(ElementIds.RootId)

    if (!appGroupRoot) {
      return
    }

    appGroupRoot.addEventListener('dragstart', handleDragStart)
    appGroupRoot.addEventListener('dragenter', handleDragIn)
    appGroupRoot.addEventListener('dragleave', handleDragOut)
    appGroupRoot.addEventListener('dragover', handleDrag)
    appGroupRoot.addEventListener('drop', handleDrop)

    return () => {
      appGroupRoot.removeEventListener('dragstart', handleDragStart)
      appGroupRoot.removeEventListener('dragenter', handleDragIn)
      appGroupRoot.removeEventListener('dragleave', handleDragOut)
      appGroupRoot.removeEventListener('dragover', handleDrag)
      appGroupRoot.removeEventListener('drop', handleDrop)
    }
  }, [handleDragIn, handleDrop, handleDrag, handleDragOut, handleDragStart])

  const contextValue = useMemo(() => {
    return {
      isDraggingFiles,
      addDragTarget,
      removeDragTarget,
    }
  }, [addDragTarget, isDraggingFiles, removeDragTarget])

  return (
    <FileDnDContext.Provider value={contextValue}>
      <MemoizedChildren children={children} />
      {isDraggingFiles ? (
        <>
          <div className="pointer-events-none absolute bottom-8 left-1/2 z-dropdown-menu -translate-x-1/2 rounded border-2 border-info bg-default px-5 py-3 shadow-main">
            {tooltipText.length ? tooltipText : 'Drop your files to upload them'}
          </div>
        </>
      ) : null}
      <Portal>
        <div
          className={classNames(FileDragOverlayClassName, isDraggingFiles ? 'visible' : 'invisible')}
          ref={fileDragOverlayRef}
        />
      </Portal>
    </FileDnDContext.Provider>
  )
}

export default FileDragNDropProvider
