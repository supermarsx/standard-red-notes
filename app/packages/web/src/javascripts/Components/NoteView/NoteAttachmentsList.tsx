import { useMemo, useState } from 'react'
import { FileItem, SNNote } from '@standardnotes/snjs'
import { formatSizeToReadableString } from '@standardnotes/filepicker'
import { FilesController } from '@/Controllers/FilesController'
import { useItemLinks } from '@/Hooks/useItemLinks'
import { getIconForFileType } from '@/Utils/Items/Icons/getIconForFileType'
import { getFileIconComponent } from '../FilePreview/getFileIconComponent'
import { FileItemActionType } from '../AttachedFilesPopover/PopoverFileItemAction'
import Icon from '../Icon/Icon'

type Props = {
  note: SNNote
  filesController: FilesController
}

/**
 * A list of the file attachments linked to a note, rendered at the end of the
 * note content. Clicking a row previews the file; the download button saves it.
 * Renders nothing when the note has no attachments.
 */
const NoteAttachmentsList = ({ note, filesController }: Props) => {
  const { filesLinkedToItem, filesLinkingToItem } = useItemLinks(note)
  const [isCollapsed, setIsCollapsed] = useState(false)

  // Union both link directions and de-duplicate by uuid so a file that is both
  // referenced-by and referencing the note only appears once.
  const files = useMemo(() => {
    const byUuid = new Map<string, FileItem>()
    for (const link of [...filesLinkedToItem, ...filesLinkingToItem]) {
      if (link.item instanceof FileItem) {
        byUuid.set(link.item.uuid, link.item)
      }
    }
    return Array.from(byUuid.values())
  }, [filesLinkedToItem, filesLinkingToItem])

  if (files.length === 0) {
    return null
  }

  const previewFile = (file: FileItem) =>
    void filesController.handleFileAction({
      type: FileItemActionType.PreviewFile,
      payload: { file, otherFiles: files },
    })

  const downloadFile = (file: FileItem) =>
    void filesController.handleFileAction({
      type: FileItemActionType.DownloadFile,
      payload: { file },
    })

  return (
    <section className="mt-4 border-t border-border pt-3" aria-label="Attachments">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-sm text-passive-1 hover:bg-contrast"
        onClick={() => setIsCollapsed((value) => !value)}
        aria-expanded={!isCollapsed}
      >
        <Icon type="attachment-file" className="text-neutral" size="medium" />
        <span className="font-semibold text-text">Attachments</span>
        <span className="rounded-full bg-passive-3 px-1.5 text-xs font-semibold text-foreground">{files.length}</span>
        <Icon type={isCollapsed ? 'chevron-right' : 'chevron-down'} className="ml-auto text-passive-1" size="medium" />
      </button>

      {!isCollapsed && (
        <ul className="mt-1 flex flex-col">
          {files.map((file) => (
            <li key={file.uuid} className="group flex items-center rounded hover:bg-contrast">
              <button
                type="button"
                className="flex min-w-0 flex-grow items-center gap-2.5 px-2 py-2 text-left"
                onClick={() => previewFile(file)}
                title={`Preview ${file.title}`}
              >
                {getFileIconComponent(getIconForFileType(file.mimeType), 'w-5 h-5 flex-shrink-0 text-info')}
                <span className="min-w-0 flex-grow truncate text-sm text-text">{file.title}</span>
                <span className="flex-shrink-0 text-xs text-passive-1">
                  {formatSizeToReadableString(file.decryptedSize)}
                </span>
              </button>
              <button
                type="button"
                className="flex-shrink-0 rounded p-2 text-passive-1 hover:text-info"
                onClick={() => downloadFile(file)}
                title={`Download ${file.title}`}
                aria-label={`Download ${file.title}`}
              >
                <Icon type="arrow-down" size="medium" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default NoteAttachmentsList
