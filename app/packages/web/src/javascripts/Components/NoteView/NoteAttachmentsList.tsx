import { useCallback, useId, useMemo, useRef, useState } from 'react'
import { FileItem, SNNote } from '@standardnotes/snjs'
import { formatSizeToReadableString } from '@standardnotes/filepicker'
import type { FilesController } from '@/Controllers/FilesController'
import { useItemLinks } from '@/Hooks/useItemLinks'
import { getIconForFileType } from '@/Utils/Items/Icons/getIconForFileType'
import { getFileIconComponent } from '../FilePreview/getFileIconComponent'
import { FileItemActionType } from '../AttachedFilesPopover/PopoverFileItemAction'
import RoundIconButton from '../Button/RoundIconButton'
import Icon from '../Icon/Icon'
import Popover from '../Popover/Popover'
import { ContextMenuCell } from '../ContentTableView/ContentTableView'
import ItemOptionsMenu, { type ReadonlyFileActions } from '../ContentTableView/ItemOptionsMenu'
import { useContextMenuEvent } from '@/Hooks/useContextMenuEvent'

type Props = {
  note: SNNote
  filesController: FilesController
  readonly?: boolean
}

type AttachmentRowProps = {
  file: FileItem
  previewFile: (file: FileItem) => void
  downloadFile: (file: FileItem) => void
  openContextMenu: (file: FileItem, x: number, y: number, trigger: HTMLElement) => void
  readonlyFileActions?: ReadonlyFileActions
}

const AttachmentRow = ({
  file,
  previewFile,
  downloadFile,
  openContextMenu,
  readonlyFileActions,
}: AttachmentRowProps) => {
  const rowRef = useRef<HTMLTableRowElement>(null)
  const openRowContextMenu = useCallback(
    (x: number, y: number, trigger: HTMLElement | undefined = rowRef.current ?? undefined) => {
      if (trigger) {
        openContextMenu(file, x, y, trigger)
      }
    },
    [file, openContextMenu],
  )

  useContextMenuEvent(rowRef, openRowContextMenu)

  return (
    <tr
      ref={rowRef}
      tabIndex={0}
      aria-label={file.title}
      className="border-border hover:bg-contrast focus:border-info border-t first:border-t-0 focus:outline-none"
      onKeyDown={(event) => {
        if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) {
          return
        }
        event.preventDefault()
        event.stopPropagation()
        const trigger = event.target instanceof HTMLElement ? event.target : event.currentTarget
        const bounds = event.currentTarget.getBoundingClientRect()
        openContextMenu(file, bounds.left, bounds.bottom, trigger)
      }}
    >
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
        <div className="flex items-center justify-end gap-1">
          <button
            type="button"
            className="text-passive-1 hover:bg-default hover:text-info rounded p-1.5"
            onClick={() => downloadFile(file)}
            title={`Download ${file.title}`}
            aria-label={`Download ${file.title}`}
          >
            <Icon type="arrow-down" size="medium" />
          </button>
          <ContextMenuCell
            items={[file]}
            isFileAttachedToNote={readonlyFileActions ? undefined : true}
            readonlyFileActions={readonlyFileActions}
          />
        </div>
      </td>
    </tr>
  )
}

/**
 * A compact attachment table opened on demand from the note toolbar. The popover
 * is not mounted while closed, so attachments never reserve editor width or
 * destabilize note layout. No file bytes are fetched until the user explicitly
 * previews or downloads a row.
 */
const NoteAttachmentsList = ({ note, filesController, readonly = false }: Props) => {
  const { filesLinkedToItem, filesLinkingToItem } = useItemLinks(note)
  const [isOpen, setIsOpen] = useState(false)
  const [rowMenu, setRowMenu] = useState<{
    file: FileItem
    position: { x: number; y: number }
    trigger: HTMLElement
  }>()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const attachmentViewId = useId()

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

  const closeAttachments = useCallback(() => {
    setIsOpen(false)
    setRowMenu(undefined)
    buttonRef.current?.focus()
  }, [])

  const toggleAttachments = useCallback(() => {
    if (isOpen) {
      closeAttachments()
    } else {
      setIsOpen(true)
    }
  }, [closeAttachments, isOpen])

  const openContextMenu = useCallback((file: FileItem, x: number, y: number, trigger: HTMLElement) => {
    setRowMenu({ file, position: { x, y }, trigger })
  }, [])

  const closeRowMenu = useCallback(() => {
    rowMenu?.trigger.focus()
    setRowMenu(undefined)
  }, [rowMenu])

  const previewFile = useCallback(
    (file: FileItem) =>
      void filesController.handleFileAction({
        type: FileItemActionType.PreviewFile,
        payload: { file, otherFiles: files },
      }),
    [files, filesController],
  )

  const downloadFile = useCallback(
    (file: FileItem) =>
      void filesController.handleFileAction({
        type: FileItemActionType.DownloadFile,
        payload: { file },
      }),
    [filesController],
  )

  const readonlyFileActions = useMemo<ReadonlyFileActions | undefined>(
    () => (readonly ? { previewFile, downloadFile } : undefined),
    [downloadFile, previewFile, readonly],
  )

  if (files.length === 0) {
    return null
  }

  return (
    <div className="relative flex">
      <RoundIconButton
        ref={buttonRef}
        label={isOpen ? `Close attachments (${files.length})` : `Attachments (${files.length})`}
        onClick={toggleAttachments}
        icon="attachment-file"
        iconClassName={isOpen ? 'text-info' : undefined}
        aria-controls={attachmentViewId}
        aria-pressed={isOpen}
      />
      <span
        aria-hidden="true"
        className="bg-info text-info-contrast pointer-events-none absolute -top-1 -right-1 flex min-h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.625rem] leading-none font-bold"
      >
        {files.length > 99 ? '99+' : files.length}
      </span>

      <Popover
        title={`Attachments (${files.length})`}
        open={isOpen}
        togglePopover={toggleAttachments}
        anchorElement={buttonRef}
        side="bottom"
        align="end"
        className="min-w-80 overflow-hidden"
        containerClassName="md:!max-w-2xl"
      >
        <section id={attachmentViewId} aria-label="Attachments" className="min-w-0">
          <div className="border-border hidden items-center gap-2 border-b px-3 py-2 md:flex">
            <Icon type="attachment-file" className="text-neutral" size="medium" />
            <h2 className="text-text text-sm font-semibold">Attachments</h2>
            <span className="bg-passive-3 text-foreground rounded-full px-1.5 text-xs font-semibold">
              {files.length}
            </span>
            <button
              type="button"
              className="text-passive-1 hover:bg-contrast hover:text-text ml-auto rounded p-1.5"
              onClick={closeAttachments}
              aria-label="Close attachments"
            >
              <Icon type="close" size="medium" />
            </button>
          </div>
          <div className="max-h-80 overflow-auto md:max-h-[28rem]">
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
                  <AttachmentRow
                    key={file.uuid}
                    file={file}
                    previewFile={previewFile}
                    downloadFile={downloadFile}
                    openContextMenu={openContextMenu}
                    readonlyFileActions={readonlyFileActions}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </section>
        {rowMenu && (
          <ItemOptionsMenu
            items={[rowMenu.file]}
            open={true}
            anchorPoint={rowMenu.position}
            closeMenu={closeRowMenu}
            isFileAttachedToNote={readonlyFileActions ? undefined : true}
            readonlyFileActions={readonlyFileActions}
          />
        )}
      </Popover>
    </div>
  )
}

export default NoteAttachmentsList
