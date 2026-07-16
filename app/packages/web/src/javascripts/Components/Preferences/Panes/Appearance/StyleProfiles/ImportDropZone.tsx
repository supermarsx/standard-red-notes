/**
 * Standard Red Notes: Typography Profiles — transfer wizard, IMPORT drop zone.
 *
 * A small, LOCAL drag-and-drop file picker for the import wizard's Source step.
 * Deliberately NOT wired to the app-wide `FileDragNDropProvider` (that provider is
 * for note attachments — hijacking it here would be wrong); instead this reads
 * `dataTransfer.files` on a local `onDrop`, and offers a "Choose file…" button
 * that uses the same `ClassicFileReader.selectFiles()` picker the old import used.
 *
 * It only forwards a chosen `File` up to the wizard (which owns reading + parsing
 * via e1's `parseImportedBundle`, so typed parse errors are shown there). The only
 * gate here is a soft `.json` filename/type check with an inline hint.
 */
import { FunctionComponent, useCallback, useState, DragEvent } from 'react'
import { ClassicFileReader } from '@standardnotes/filepicker'
import { classNames } from '@standardnotes/snjs'
import Button from '@/Components/Button/Button'
import Icon from '@/Components/Icon/Icon'

type Props = {
  onFile: (file: File) => void
  /** A parse/read error from the wizard, shown under the drop zone. */
  error?: string | null
}

/** Soft filter: accept only files that look like `.json` (by type or extension). */
const looksLikeJson = (file: File): boolean => file.type === 'application/json' || /\.json$/i.test(file.name)

const ImportDropZone: FunctionComponent<Props> = ({ onFile, error }) => {
  const [dragging, setDragging] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  const handleFiles = useCallback(
    (files: FileList | File[] | null | undefined) => {
      const file = files && files.length > 0 ? files[0] : undefined
      if (!file) {
        return
      }
      if (!looksLikeJson(file)) {
        setLocalError('Please choose a .json typography profile file.')
        return
      }
      setLocalError(null)
      onFile(file)
    },
    [onFile],
  )

  const chooseFile = useCallback(async () => {
    const files = await ClassicFileReader.selectFiles()
    handleFiles(files)
  }, [handleFiles])

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    handleFiles(event.dataTransfer?.files)
  }

  const shownError = localError ?? error ?? null

  return (
    <div className="flex flex-col gap-2">
      <div
        aria-label="Drag a .json typography profile file here, or choose a file"
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragEnter={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={(event) => {
          event.preventDefault()
          setDragging(false)
        }}
        onDrop={onDrop}
        className={classNames(
          'flex flex-col items-center justify-center gap-2 rounded border-2 border-dashed px-4 py-8 text-center transition-colors duration-75',
          dragging ? 'border-info bg-info-backdrop' : 'border-border bg-default',
        )}
      >
        <Icon type="archive" size="large" className="text-passive-1" />
        <div className="text-text text-sm font-medium">Drag &amp; drop a .json profile file here</div>
        <div className="text-passive-1 text-xs">or</div>
        <Button small label="Choose file…" onClick={() => void chooseFile()} />
        <div className="text-passive-1 text-xs">
          Accepts a single exported profile or a multi-profile bundle. Imported styles are always sanitised before use.
        </div>
      </div>
      {shownError && (
        <div className="text-danger flex items-start gap-1.5 text-sm" role="alert">
          <Icon type="warning" size="small" className="mt-0.5 flex-shrink-0" />
          <span>{shownError}</span>
        </div>
      )}
    </div>
  )
}

export default ImportDropZone
