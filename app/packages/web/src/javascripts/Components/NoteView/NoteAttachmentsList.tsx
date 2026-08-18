import { useId, useMemo, useState } from 'react'
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
 * A compact, fully collapsible attachment rail rendered after the note content.
 * It stays closed by default so notes with many files do not crowd or destabilize
 * the editor. Expanding it reveals a semantic table; no file bytes are fetched
 * until the user explicitly previews or downloads a row.
 */
const NoteAttachmentsList = ({ note, filesController }: Props) => {
  const { filesLinkedToItem, filesLinkingToItem } = useItemLinks(note)
  const [isCollapsed, setIsCollapsed] = useState(true)
  const tableId = useId()

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
    <aside
      className="border-border bg-default mt-4 overflow-hidden rounded-md border"
      aria-label="Attachments"
      data-collapsed={isCollapsed}
    >
      <button
        type="button"
        className="text-passive-1 hover:bg-contrast flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
        onClick={() => setIsCollapsed((value) => !value)}
        aria-expanded={!isCollapsed}
        aria-controls={tableId}
      >
        <Icon type="attachment-file" className="text-neutral" size="medium" />
        <span className="text-text font-semibold">Attachments</span>
        <span className="bg-passive-3 text-foreground rounded-full px-1.5 text-xs font-semibold">{files.length}</span>
        <span className="text-passive-1 ml-auto hidden text-xs sm:inline">
          {isCollapsed ? 'Show files' : 'Hide files'}
        </span>
        <Icon type={isCollapsed ? 'chevron-right' : 'chevron-down'} className="text-passive-1" size="medium" />
      </button>

      {!isCollapsed && (
        <div id={tableId} className="border-border max-h-64 overflow-auto border-t">
          <table className="w-full table-fixed border-collapse text-left text-xs">
            <thead className="bg-contrast text-passive-1 sticky top-0 z-[1]">
              <tr>
                <th scope="col" className="w-full px-3 py-1.5 font-medium">
                  File
                </th>
                <th scope="col" className="hidden w-28 px-2 py-1.5 font-medium sm:table-cell">
                  Type
                </th>
                <th scope="col" className="w-20 px-2 py-1.5 text-right font-medium">
                  Size
                </th>
                <th scope="col" className="w-10 px-1 py-1.5">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {files.map((file) => (
                <tr key={file.uuid} className="border-border hover:bg-contrast border-t first:border-t-0">
                  <td className="min-w-0 p-0">
                    <button
                      type="button"
                      className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left"
                      onClick={() => previewFile(file)}
                      title={`Preview ${file.title}`}
                    >
                      {getFileIconComponent(getIconForFileType(file.mimeType), 'w-4 h-4 flex-shrink-0 text-info')}
                      <span className="min-w-0 flex-grow">
                        <span className="text-text block truncate font-medium">{file.title}</span>
                        {file.description && (
                          <span className="text-passive-1 block truncate" title={file.description}>
                            {file.description}
                          </span>
                        )}
                      </span>
                    </button>
                  </td>
                  <td className="text-passive-1 hidden truncate px-2 py-2 sm:table-cell" title={file.mimeType}>
                    {file.mimeType || 'Unknown'}
                  </td>
                  <td className="text-passive-1 px-2 py-2 text-right whitespace-nowrap">
                    {formatSizeToReadableString(file.decryptedSize)}
                  </td>
                  <td className="px-1 py-1 text-right">
                    <button
                      type="button"
                      className="text-passive-1 hover:bg-default hover:text-info rounded p-1.5"
                      onClick={() => downloadFile(file)}
                      title={`Download ${file.title}`}
                      aria-label={`Download ${file.title}`}
                    >
                      <Icon type="arrow-down" size="medium" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </aside>
  )
}

export default NoteAttachmentsList
