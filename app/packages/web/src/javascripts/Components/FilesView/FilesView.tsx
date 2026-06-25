import { FunctionComponent, useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { ContentType, FileItem } from '@standardnotes/snjs'
import { classNames } from '@standardnotes/utils'
import { formatSizeToReadableString } from '@standardnotes/filepicker'
import { FileItemActionType } from '@/Components/AttachedFilesPopover/PopoverFileItemAction'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import { getFileIconComponent } from '@/Components/FilePreview/getFileIconComponent'
import { getIconForFileType } from '@/Utils/Items/Icons/getIconForFileType'

type Props = {
  application: WebApplication
  className?: string
  id?: string
}

/**
 * Standard Red Notes: a full-column "Files" gallery surfaced as an editor tab —
 * every attached file as a clickable card (type icon, name, size), newest first.
 * Clicking a card opens the file preview. Stays in sync with file add/remove.
 */
const FilesView: FunctionComponent<Props> = ({ application, className, id }) => {
  const [files, setFiles] = useState<FileItem[]>(() => application.items.getDisplayableFiles())

  useEffect(() => {
    return application.items.streamItems<FileItem>(ContentType.TYPES.File, () => {
      setFiles(application.items.getDisplayableFiles())
    })
  }, [application])

  const sorted = [...files].sort((a, b) => b.created_at.getTime() - a.created_at.getTime())

  const openFile = (file: FileItem) => {
    void application.filesController.handleFileAction({
      type: FileItemActionType.PreviewFile,
      payload: { file },
    })
  }

  return (
    <div id={id} className={classNames('flex flex-col overflow-hidden bg-default', className)}>
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Icon type="attachment-file" className="text-info" />
        <span className="text-base font-bold text-text">Files</span>
        {sorted.length > 0 && <span className="text-sm text-passive-1">{sorted.length}</span>}
      </div>

      <div className="min-h-0 flex-grow overflow-y-auto p-4">
        {sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center text-passive-1">
            <Icon type="attachment-file" size="large" className="text-passive-2" />
            <div className="mt-2 text-sm">No files yet — attach files to a note and they'll show up here.</div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {sorted.map((file) => (
              <button
                key={file.uuid}
                type="button"
                onClick={() => openFile(file)}
                title={file.name}
                className="flex flex-col items-center gap-2 rounded-lg border border-solid border-border bg-contrast p-3 text-center transition-colors hover:border-info hover:bg-default"
              >
                {getFileIconComponent(getIconForFileType(file.mimeType), 'w-8 h-8 flex-shrink-0')}
                <span className="line-clamp-2 w-full break-words text-xs font-semibold text-text">{file.name}</span>
                <span className="text-[0.625rem] text-passive-1">{formatSizeToReadableString(file.decryptedSize)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default observer(FilesView)
