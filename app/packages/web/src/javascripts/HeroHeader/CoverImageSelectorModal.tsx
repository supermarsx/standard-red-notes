import { FunctionComponent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { FileItem, SNNote } from '@standardnotes/snjs'
import { formatSizeToReadableString } from '@standardnotes/filepicker'
import Modal from '@/Components/Modal/Modal'
import ModalOverlay from '@/Components/Modal/ModalOverlay'
import Icon from '@/Components/Icon/Icon'
import { FilesController } from '@/Controllers/FilesController'
import { NotesController } from '@/Controllers/NotesController/NotesController'
import { ACCEPTED_HERO_IMAGE_TYPES, isAcceptedHeroImageType, validateHeroSourceFile } from './heroHeader'
import { processCoverImageFile } from './heroHeaderService'

/**
 * Standard Red Notes: "multimedia selector" for choosing a note's COVER image.
 *
 * Offers three input routes, ALL of which funnel into the same bounded-data-URL
 * pipeline (`processCoverImageFile` -> `notesController.setNoteHeroImage`):
 *  1. Drag-and-drop an image onto the drop zone.
 *  2. "Choose from your device" -> the OS `<input type=file>` (existing route).
 *  3. Click one of the user's EXISTING image files -> download its blob.
 *
 * Existing files are listed from `filesController.allFiles` (kept up to date by
 * the controller's `streamItems`) and filtered to accepted image types. Each
 * row lazily downloads its blob only when hovered/visible to render a thumbnail,
 * so opening the selector never blocks on decrypting every file.
 */

type Props = {
  note: SNNote
  filesController: FilesController
  notesController: NotesController
  isOpen: boolean
  close: () => void
  /** Surface a user-facing error message (same prop the banner uses). */
  onError?: (message: string) => void
}

const acceptAttribute = ACCEPTED_HERO_IMAGE_TYPES.join(',')

/**
 * A single existing-image row. Lazily downloads the file's blob the first time
 * the row scrolls into view to render a thumbnail (revoking the object URL on
 * unmount), then on click runs the shared cover pipeline.
 */
const ExistingImageRow: FunctionComponent<{
  file: FileItem
  filesController: FilesController
  busy: boolean
  onChoose: (file: FileItem) => void
}> = ({ file, filesController, busy, onChoose }) => {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)
  const ref = useRef<HTMLButtonElement | null>(null)

  // Only fetch the (decrypted) thumbnail once the row is on-screen.
  useEffect(() => {
    const element = ref.current
    if (!element || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '100px' },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) {
      return
    }
    let cancelled = false
    let createdUrl: string | null = null
    void filesController.getFileBlob(file).then((blob) => {
      if (cancelled || !blob) {
        return
      }
      createdUrl = URL.createObjectURL(blob)
      setThumbUrl(createdUrl)
    })
    return () => {
      cancelled = true
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl)
      }
    }
  }, [visible, file, filesController])

  return (
    <button
      ref={ref}
      type="button"
      disabled={busy}
      onClick={() => onChoose(file)}
      title={`Use "${file.name}" as cover`}
      className="group flex flex-col overflow-hidden rounded border border-border bg-default text-left transition-colors hover:border-info disabled:opacity-50"
    >
      <div className="flex h-24 w-full items-center justify-center overflow-hidden bg-passive-4">
        {thumbUrl ? (
          <img src={thumbUrl} alt={file.name} className="h-full w-full object-cover" draggable={false} />
        ) : (
          <Icon type="file-image" size="large" className="text-passive-1" />
        )}
      </div>
      <div className="flex items-center gap-1 px-2 py-1.5">
        <span className="min-w-0 flex-grow truncate text-xs text-text">{file.name}</span>
        <span className="flex-shrink-0 text-xs text-passive-1">{formatSizeToReadableString(file.decryptedSize)}</span>
      </div>
    </button>
  )
}

const CoverImageSelectorContent = observer(
  ({ note, filesController, notesController, close, onError }: Omit<Props, 'isOpen'>) => {
    const fileInputRef = useRef<HTMLInputElement | null>(null)
    const [busy, setBusy] = useState(false)
    const [dragActive, setDragActive] = useState(false)

    const imageFiles = useMemo(
      () => filesController.allFiles.filter((file) => isAcceptedHeroImageType(file.mimeType)),
      [filesController.allFiles],
    )

    // Shared pipeline: any input route resolves to a Blob, which is validated,
    // downsized + compressed into a bounded data URL, then persisted on the note.
    const applyBlob = useCallback(
      async (blob: Blob) => {
        const validationError = validateHeroSourceFile({ type: blob.type, size: blob.size })
        if (validationError) {
          onError?.(validationError)
          return
        }
        setBusy(true)
        try {
          const dataUrl = await processCoverImageFile(blob)
          await notesController.setNoteHeroImage(note, dataUrl)
          close()
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Could not set the cover image.'
          onError?.(message)
        } finally {
          setBusy(false)
        }
      },
      [note, notesController, onError, close],
    )

    const onFileChosen = useCallback(
      (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (file) {
          void applyBlob(file)
        }
      },
      [applyBlob],
    )

    const onChooseExisting = useCallback(
      async (file: FileItem) => {
        setBusy(true)
        try {
          const blob = await filesController.getFileBlob(file)
          if (!blob) {
            onError?.('Could not download that file.')
            return
          }
          // Carry the file's mime type so validation/decoding work on the blob.
          await applyBlob(blob.type ? blob : new Blob([blob], { type: file.mimeType }))
        } finally {
          setBusy(false)
        }
      },
      [filesController, applyBlob, onError],
    )

    const onDrop = useCallback(
      (event: React.DragEvent) => {
        event.preventDefault()
        setDragActive(false)
        const file = event.dataTransfer.files?.[0]
        if (file) {
          void applyBlob(file)
        }
      },
      [applyBlob],
    )

    return (
      <Modal
        title="Choose a cover image"
        className="p-4"
        close={close}
        actions={[{ label: 'Cancel', type: 'cancel', onClick: close, mobileSlot: 'left' }]}
      >
        <div className="flex flex-col gap-5">
          <input
            ref={fileInputRef}
            type="file"
            accept={acceptAttribute}
            className="hidden"
            onChange={onFileChosen}
          />

          {/* Route 1 + 2: drop zone / device picker. */}
          <div
            role="button"
            tabIndex={0}
            onClick={() => !busy && fileInputRef.current?.click()}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                if (!busy) {
                  fileInputRef.current?.click()
                }
              }
            }}
            onDragOver={(event) => {
              event.preventDefault()
              setDragActive(true)
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={onDrop}
            className={
              'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-4 py-8 text-center transition-colors ' +
              (dragActive ? 'border-info bg-info-backdrop' : 'border-border hover:border-info')
            }
          >
            <Icon type="file-image" size="large" className="text-passive-1" />
            <div className="text-sm font-semibold text-text">
              {busy ? 'Working…' : 'Drag an image here'}
            </div>
            <div className="text-xs text-passive-0">PNG, JPEG, WebP, or GIF — up to 15 MB</div>
            <span className="mt-1 rounded border border-border px-3 py-1.5 text-sm text-info">
              Choose from your device
            </span>
          </div>

          {/* Route 3: existing image files. */}
          <div className="flex flex-col gap-2">
            <div className="text-sm font-semibold text-text">Your images</div>
            {imageFiles.length === 0 ? (
              <p className="rounded border border-border px-3 py-6 text-center text-xs text-passive-0">
                You don&rsquo;t have any image files yet. Upload or drop one above to use it as a cover.
              </p>
            ) : (
              <div className="grid max-h-72 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
                {imageFiles.map((file) => (
                  <ExistingImageRow
                    key={file.uuid}
                    file={file}
                    filesController={filesController}
                    busy={busy}
                    onChoose={(f) => void onChooseExisting(f)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </Modal>
    )
  },
)

const CoverImageSelectorModal = ({ isOpen, close, ...rest }: Props) => {
  return (
    <ModalOverlay isOpen={isOpen} close={close} className="md:max-w-[40rem]">
      <CoverImageSelectorContent close={close} {...rest} />
    </ModalOverlay>
  )
}

export default observer(CoverImageSelectorModal)
