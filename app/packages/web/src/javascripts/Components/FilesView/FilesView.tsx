import { FunctionComponent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { ContentType, FileItem } from '@standardnotes/snjs'
import { classNames } from '@standardnotes/utils'
import { formatSizeToReadableString } from '@standardnotes/filepicker'
import { FileItemActionType } from '@/Components/AttachedFilesPopover/PopoverFileItemAction'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import { getFileIconComponent } from '@/Components/FilePreview/getFileIconComponent'
import { getIconForFileType } from '@/Utils/Items/Icons/getIconForFileType'
import { FeatureName } from '@/Controllers/FeatureName'
import { ItemLinksCell } from '@/Components/ContentTableView/ContentTableView'
import Menu from '@/Components/Menu/Menu'
import FileMenuOptions from '@/Components/FileContextMenu/FileMenuOptions'
import Popover from '@/Components/Popover/Popover'
import { useFileDragNDrop } from '@/Components/FileDragNDropProvider'
import { FilesSortBy, sortFiles } from '@/Utils/Items/sortFiles'

type Props = {
  application: WebApplication
  className?: string
  id?: string
}

/** A single file card with selection, preview-on-click, links + a context menu. */
const FileCard: FunctionComponent<{
  file: FileItem
  isSelected: boolean
  selectionActive: boolean
  onToggleSelect: (file: FileItem, additive: boolean) => void
  onPreview: (file: FileItem) => void
}> = ({ file, isSelected, selectionActive, onToggleSelect, onPreview }) => {
  const [menuVisible, setMenuVisible] = useState(false)
  const menuAnchorRef = useRef<HTMLButtonElement>(null)

  return (
    <div
      className={classNames(
        'group relative flex flex-col items-center gap-2 rounded-lg border border-solid p-3 text-center transition-colors',
        isSelected ? 'border-info bg-info-backdrop' : 'border-border bg-contrast hover:border-info hover:bg-default',
      )}
    >
      <button
        type="button"
        title={file.name}
        className="flex w-full flex-col items-center gap-2"
        onClick={(event) => {
          if (selectionActive || event.metaKey || event.ctrlKey) {
            onToggleSelect(file, event.metaKey || event.ctrlKey)
          } else {
            onPreview(file)
          }
        }}
      >
        {getFileIconComponent(getIconForFileType(file.mimeType), 'w-8 h-8 flex-shrink-0')}
        <span className="line-clamp-2 w-full break-words text-xs font-semibold text-text">{file.name}</span>
        <span className="text-[0.625rem] text-passive-1">{formatSizeToReadableString(file.decryptedSize)}</span>
      </button>

      <div className="flex items-center gap-1">
        <ItemLinksCell item={file} />
        <button
          ref={menuAnchorRef}
          className="rounded-full border border-border bg-default p-1"
          title="File options"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setMenuVisible((visible) => !visible)
          }}
        >
          <Icon type="more" />
        </button>
        <Popover
          title="File options"
          open={menuVisible}
          anchorElement={menuAnchorRef}
          togglePopover={() => setMenuVisible(false)}
          side="bottom"
          align="center"
          className="py-2"
        >
          <Menu a11yLabel="File context menu">
            <FileMenuOptions
              closeMenu={() => setMenuVisible(false)}
              shouldShowRenameOption={true}
              shouldShowAttachOption={false}
              selectedFiles={[file]}
            />
          </Menu>
        </Popover>
      </div>

      {selectionActive && (
        <button
          type="button"
          className="absolute left-2 top-2 rounded border border-border bg-default p-0.5"
          title={isSelected ? 'Deselect' : 'Select'}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onToggleSelect(file, true)
          }}
        >
          <Icon
            type={isSelected ? 'check-circle-filled' : 'check-circle'}
            className={isSelected ? 'text-info' : 'text-passive-1'}
          />
        </button>
      )}
    </div>
  )
}

/**
 * Standard Red Notes: a full-column "Files" gallery surfaced as an editor tab. It
 * lists ALL displayable files (independent of the sidebar selection), so it is
 * enhanced in place rather than reusing the navigation-scoped ContentTableView.
 * Cards are fully actionable: sortable (name / size / date), multi-selectable with
 * bulk actions, per-file context menu (reusing FileMenuOptions), linked-items
 * (reusing ItemLinksCell) and upload via button or drag-and-drop (filesController).
 */
const FilesView: FunctionComponent<Props> = observer(({ application, className, id }) => {
  const { itemListController } = application
  const [files, setFiles] = useState<FileItem[]>(() => application.items.getDisplayableFiles())
  const [bulkMenuVisible, setBulkMenuVisible] = useState(false)
  const bulkMenuAnchorRef = useRef<HTMLButtonElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const { addDragTarget, removeDragTarget } = useFileDragNDrop()

  // Sort + selection live on the controller so they survive pane/tab remounts.
  const sortBy = itemListController.filesViewSortBy
  const sortDirection = itemListController.filesViewSortDirection
  const selectedUuids = itemListController.filesViewSelectedUuids

  useEffect(() => {
    return application.items.streamItems<FileItem>(ContentType.TYPES.File, () => {
      setFiles(application.items.getDisplayableFiles())
    })
  }, [application])

  // Drop any selection entries whose file no longer exists.
  useEffect(() => {
    itemListController.pruneFilesViewSelection(new Set(files.map((file) => file.uuid)))
  }, [files, itemListController])

  const sorted = useMemo(() => sortFiles(files, sortBy, sortDirection), [files, sortBy, sortDirection])

  const selectedFiles = useMemo(() => sorted.filter((file) => selectedUuids.has(file.uuid)), [sorted, selectedUuids])
  const selectionActive = selectedUuids.size > 0

  const openFile = useCallback(
    (file: FileItem) => {
      void application.filesController.handleFileAction({
        type: FileItemActionType.PreviewFile,
        payload: { file, otherFiles: sorted },
      })
    },
    [application, sorted],
  )

  const toggleSelect = useCallback(
    (file: FileItem, additive: boolean) => {
      itemListController.toggleFilesViewSelection(file.uuid, additive)
    },
    [itemListController],
  )

  const selectAll = useCallback(() => {
    itemListController.selectAllFilesViewFiles(sorted.map((file) => file.uuid))
  }, [itemListController, sorted])

  const clearSelection = useCallback(() => itemListController.clearFilesViewSelection(), [itemListController])

  const uploadNewFiles = useCallback(() => {
    if (!application.entitledToFiles) {
      application.showPremiumModal(FeatureName.Files)
      return
    }
    void application.filesController.selectAndUploadNewFiles()
  }, [application])

  // Drag-and-drop upload (no note → standalone upload, like the upload button).
  useEffect(() => {
    const target = containerRef.current
    if (!target) {
      return
    }
    addDragTarget(target, {
      tooltipText: 'Upload files',
      // No note + no special upload handler → the drop provider performs a plain
      // standalone upload (loose files / recreated folder structure), exactly like
      // the upload button. The stream subscription above refreshes the list.
      callback: () => undefined,
    })
    return () => {
      removeDragTarget(target)
    }
  }, [addDragTarget, removeDragTarget])

  const toggleSortDirection = () => itemListController.toggleFilesViewSortDirection()

  return (
    <div
      ref={containerRef}
      id={id}
      className={classNames('flex flex-col overflow-hidden bg-default', className)}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <Icon type="attachment-file" className="text-info" />
        <span className="text-base font-bold text-text">Files</span>
        {sorted.length > 0 && <span className="text-sm text-passive-1">{sorted.length}</span>}

        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-passive-1">
            Sort
            <select
              className="rounded border border-border bg-default px-2 py-1 text-xs text-text"
              value={sortBy}
              onChange={(event) => itemListController.setFilesViewSortBy(event.target.value as FilesSortBy)}
            >
              <option value="name">Name</option>
              <option value="size">Size</option>
              <option value="date">Date</option>
            </select>
          </label>
          <button
            className="rounded border border-border p-1 hover:bg-contrast"
            title={sortDirection === 'asc' ? 'Ascending' : 'Descending'}
            onClick={toggleSortDirection}
          >
            <Icon type={sortDirection === 'asc' ? 'arrows-sort-up' : 'arrows-sort-down'} size="medium" />
          </button>
          <button
            className="flex items-center gap-1 rounded border border-border px-2 py-1 text-sm hover:bg-contrast"
            onClick={uploadNewFiles}
            title="Upload files"
          >
            <Icon type="upload" size="medium" />
            Upload
          </button>
        </div>
      </div>

      {selectionActive && (
        <div className="flex items-center gap-3 border-b border-border px-4 py-2">
          <span className="text-sm font-semibold">{selectedUuids.size} selected</span>
          <button className="rounded border border-border px-2 py-1 text-sm hover:bg-contrast" onClick={selectAll}>
            Select all
          </button>
          <button className="rounded border border-border px-2 py-1 text-sm hover:bg-contrast" onClick={clearSelection}>
            Clear
          </button>
          <button
            ref={bulkMenuAnchorRef}
            className="ml-auto flex items-center gap-1 rounded border border-border px-2 py-1 text-sm hover:bg-contrast"
            onClick={() => setBulkMenuVisible((visible) => !visible)}
          >
            <Icon type="more" size="medium" />
            Actions
          </button>
          <Popover
            title="File options"
            open={bulkMenuVisible}
            anchorElement={bulkMenuAnchorRef}
            togglePopover={() => setBulkMenuVisible(false)}
            side="bottom"
            align="end"
            className="py-2"
          >
            <Menu a11yLabel="Bulk file context menu">
              <FileMenuOptions
                closeMenu={() => setBulkMenuVisible(false)}
                shouldShowRenameOption={true}
                shouldShowAttachOption={false}
                selectedFiles={selectedFiles}
              />
            </Menu>
          </Popover>
        </div>
      )}

      <div className="min-h-0 flex-grow overflow-y-auto p-4">
        {sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center text-passive-1">
            <Icon type="attachment-file" size="large" className="text-passive-2" />
            <div className="mt-2 text-sm">No files yet — upload a file or attach one to a note.</div>
            <button
              className="mt-4 flex items-center gap-1 rounded border border-border px-3 py-1.5 text-sm hover:bg-contrast"
              onClick={uploadNewFiles}
            >
              <Icon type="upload" size="medium" />
              Upload files
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {sorted.map((file) => (
              <FileCard
                key={file.uuid}
                file={file}
                isSelected={selectedUuids.has(file.uuid)}
                selectionActive={selectionActive}
                onToggleSelect={toggleSelect}
                onPreview={openFile}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
})

export default FilesView
