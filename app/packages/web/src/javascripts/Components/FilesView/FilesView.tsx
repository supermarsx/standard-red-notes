import { FunctionComponent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { ContentType, FileItem, SortableItem } from '@standardnotes/snjs'
import { classNames } from '@standardnotes/utils'
import { formatSizeToReadableString } from '@standardnotes/filepicker'
import { FileItemActionType } from '@/Components/AttachedFilesPopover/PopoverFileItemAction'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import { getFileIconComponent } from '@/Components/FilePreview/getFileIconComponent'
import { getIconForFileType } from '@/Utils/Items/Icons/getIconForFileType'
import { FeatureName } from '@/Controllers/FeatureName'
import { ContextMenuCell, ItemLinksCell } from '@/Components/ContentTableView/ContentTableView'
import Menu from '@/Components/Menu/Menu'
import FileMenuOptions from '@/Components/FileContextMenu/FileMenuOptions'
import Popover from '@/Components/Popover/Popover'
import { useFileDragNDrop } from '@/Components/FileDragNDropProvider'
import { FilesSortBy, sortFiles } from '@/Utils/Items/sortFiles'
import Table from '@/Components/Table/Table'
import { TableColumn } from '@/Components/Table/CommonTypes'
import { useTable } from '@/Components/Table/useTable'
import { formatDateForContextMenu } from '@/Utils/DateUtils'
import { MutuallyExclusiveMediaQueryBreakpoints, useMediaQuery } from '@/Hooks/useMediaQuery'
import { filesSortByForTableSortBy, getFileTypeLabel, tableSortByForFilesSortBy } from './FilesViewTableUtils'

type Props = {
  application: WebApplication
  className?: string
  id?: string
}

const FileNameCell: FunctionComponent<{
  file: FileItem
  onPreview: (file: FileItem) => void
}> = ({ file, onPreview }) => {
  return (
    <div className="flex min-w-0 items-center gap-3 whitespace-normal">
      {getFileIconComponent(getIconForFileType(file.mimeType), 'w-6 h-6 flex-shrink-0')}
      <button
        type="button"
        title={`Preview ${file.name}`}
        aria-label={`Preview ${file.name}`}
        className="focus:border-info min-w-0 overflow-hidden rounded text-left focus:border focus:outline-none"
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onPreview(file)
        }}
      >
        <span className="text-text block overflow-hidden text-sm font-semibold text-ellipsis whitespace-nowrap">
          {file.name}
        </span>
      </button>
    </div>
  )
}

/**
 * Standard Red Notes: a full-column Files table surfaced as an editor tab. It
 * lists ALL displayable files (independent of the sidebar selection), so it is
 * enhanced in place rather than reusing the navigation-scoped ContentTableView.
 * The shared table provides bounded incremental row rendering, keyboard navigation,
 * sortable headers and multi-selection while this view keeps its controller-backed
 * sort/selection state, file-specific actions, upload and drag-and-drop behavior.
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

  const isSmallBreakpoint = useMediaQuery(MutuallyExclusiveMediaQueryBreakpoints.sm)
  const isMediumBreakpoint = useMediaQuery(MutuallyExclusiveMediaQueryBreakpoints.md)
  const isLargeBreakpoint = useMediaQuery(MutuallyExclusiveMediaQueryBreakpoints.lg)

  const openFile = useCallback(
    (file: FileItem) => {
      void application.filesController.handleFileAction({
        type: FileItemActionType.PreviewFile,
        payload: { file, otherFiles: sorted },
      })
    },
    [application, sorted],
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

  const selectedRowIds = useMemo(() => Array.from(selectedUuids), [selectedUuids])
  const onRowSelectionChange = useCallback(
    (rowIds: string[]) => {
      const current = itemListController.filesViewSelectedUuids
      if (current.size === rowIds.length && rowIds.every((uuid) => current.has(uuid))) {
        return
      }
      itemListController.selectAllFilesViewFiles(rowIds)
    },
    [itemListController],
  )

  const onTableSortChange = useCallback(
    (tableSortBy: keyof SortableItem, reversed: boolean) => {
      const nextSortBy = filesSortByForTableSortBy(tableSortBy)
      if (!nextSortBy) {
        return
      }

      itemListController.setFilesViewSortBy(nextSortBy)
      const nextDirection = reversed ? 'dsc' : 'asc'
      if (sortDirection !== nextDirection) {
        itemListController.toggleFilesViewSortDirection()
      }
    },
    [itemListController, sortDirection],
  )

  const columnDefs: TableColumn<FileItem>[] = useMemo(
    () => [
      {
        name: 'Name',
        sortBy: 'title',
        cell: (file) => <FileNameCell file={file} onPreview={openFile} />,
      },
      {
        name: 'Description',
        cell: (file) => (
          <span
            className={classNames(
              'line-clamp-2 text-sm whitespace-normal',
              file.description ? 'text-text' : 'text-passive-2 italic',
            )}
            title={file.description || 'No description'}
          >
            {file.description || 'No description'}
          </span>
        ),
        hidden: isSmallBreakpoint || isMediumBreakpoint,
      },
      {
        name: 'Type',
        cell: (file) => {
          const typeLabel = getFileTypeLabel(file)
          return (
            <span className="text-passive-1 overflow-hidden text-xs text-ellipsis" title={typeLabel}>
              {typeLabel}
            </span>
          )
        },
        hidden: isSmallBreakpoint,
      },
      {
        name: 'Size',
        sortBy: 'decryptedSize',
        cell: (file) => <span className="text-sm tabular-nums">{formatSizeToReadableString(file.decryptedSize)}</span>,
      },
      {
        name: 'Uploaded',
        sortBy: 'created_at',
        cell: (file) => <span className="text-sm tabular-nums">{formatDateForContextMenu(file.created_at)}</span>,
        hidden: isSmallBreakpoint,
      },
      {
        name: 'Modified',
        cell: (file) => <span className="text-sm tabular-nums">{formatDateForContextMenu(file.userModifiedDate)}</span>,
        hidden: isSmallBreakpoint || isMediumBreakpoint || isLargeBreakpoint,
      },
    ],
    [isLargeBreakpoint, isMediumBreakpoint, isSmallBreakpoint, openFile],
  )

  const getRowId = useCallback((file: FileItem) => file.uuid, [])
  const renderRowActions = useCallback(
    (file: FileItem) => (
      <div className="flex items-center gap-2">
        <ItemLinksCell item={file} />
        <ContextMenuCell items={[file]} />
      </div>
    ),
    [],
  )

  const table = useTable({
    data: sorted,
    columns: columnDefs,
    sortBy: tableSortByForFilesSortBy(sortBy),
    sortReversed: sortDirection === 'dsc',
    onSortChange: onTableSortChange,
    getRowId,
    enableRowSelection: true,
    enableMultipleRowSelection: true,
    selectedRowIds,
    onRowSelectionChange,
    onRowActivate: openFile,
    rowActions: renderRowActions,
  })

  return (
    <div ref={containerRef} id={id} className={classNames('bg-default flex flex-col overflow-hidden', className)}>
      <div className="border-border flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <Icon type="attachment-file" className="text-info" />
        <span className="text-text text-base font-bold">Files</span>
        {sorted.length > 0 && <span className="text-passive-1 text-sm">{sorted.length}</span>}

        <div className="ml-auto flex items-center gap-2">
          <label className="text-passive-1 flex items-center gap-1 text-xs">
            Sort
            <select
              className="border-border bg-default text-text rounded border px-2 py-1 text-xs"
              value={sortBy}
              onChange={(event) => itemListController.setFilesViewSortBy(event.target.value as FilesSortBy)}
            >
              <option value="name">Name</option>
              <option value="size">Size</option>
              <option value="date">Date</option>
            </select>
          </label>
          <button
            className="border-border hover:bg-contrast rounded border p-1"
            title={sortDirection === 'asc' ? 'Ascending' : 'Descending'}
            onClick={toggleSortDirection}
          >
            <Icon type={sortDirection === 'asc' ? 'arrows-sort-up' : 'arrows-sort-down'} size="medium" />
          </button>
          <button
            className="border-border hover:bg-contrast flex items-center gap-1 rounded border px-2 py-1 text-sm"
            onClick={uploadNewFiles}
            title="Upload files"
          >
            <Icon type="upload" size="medium" />
            Upload
          </button>
        </div>
      </div>

      {selectionActive && (
        <div className="border-border flex items-center gap-3 border-b px-4 py-2">
          <span className="text-sm font-semibold">{selectedUuids.size} selected</span>
          <button className="border-border hover:bg-contrast rounded border px-2 py-1 text-sm" onClick={selectAll}>
            Select all
          </button>
          <button className="border-border hover:bg-contrast rounded border px-2 py-1 text-sm" onClick={clearSelection}>
            Clear
          </button>
          <button
            ref={bulkMenuAnchorRef}
            className="border-border hover:bg-contrast ml-auto flex items-center gap-1 rounded border px-2 py-1 text-sm"
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

      <div className="min-h-0 flex-grow overflow-hidden">
        {sorted.length === 0 ? (
          <div className="text-passive-1 flex h-full flex-col items-center justify-center p-4 text-center">
            <Icon type="attachment-file" size="large" className="text-passive-2" />
            <div className="mt-2 text-sm">No files yet — upload a file or attach one to a note.</div>
            <button
              className="border-border hover:bg-contrast mt-4 flex items-center gap-1 rounded border px-3 py-1.5 text-sm"
              onClick={uploadNewFiles}
            >
              <Icon type="upload" size="medium" />
              Upload files
            </button>
          </div>
        ) : (
          <div className="h-full min-h-0 [&>div]:h-full">
            <Table table={table} />
          </div>
        )}
      </div>
    </div>
  )
})

export default FilesView
