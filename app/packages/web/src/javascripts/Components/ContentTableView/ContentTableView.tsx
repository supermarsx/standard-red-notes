import type { WebApplication } from '@/Application/WebApplication'
import { formatDateForContextMenu } from '@/Utils/DateUtils'
import { getIconForFileType } from '@/Utils/Items/Icons/getIconForFileType'
import { formatSizeToReadableString } from '@standardnotes/filepicker'
import {
  FileItem,
  SortableItem,
  CollectionSort,
  FileBackupRecord,
  DecryptedItemInterface,
  SNNote,
  TagMutator,
  isSystemView,
  isSmartView,
  isNote,
} from '@standardnotes/snjs'
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { FileItemActionType } from '../AttachedFilesPopover/PopoverFileItemAction'
import { getFileIconComponent } from '../FilePreview/getFileIconComponent'
import Popover from '../Popover/Popover'
import Table from '../Table/Table'
import { TableColumn } from '../Table/CommonTypes'
import { useTable } from '../Table/useTable'
import Icon from '../Icon/Icon'
import LinkedItemBubble from '../LinkedItems/LinkedItemBubble'
import LinkedItemsPanel from '../LinkedItems/LinkedItemsPanel'
import { MutuallyExclusiveMediaQueryBreakpoints, useMediaQuery } from '@/Hooks/useMediaQuery'
import { useApplication } from '../ApplicationProvider'
import { getIconAndTintForNoteType } from '@/Utils/Items/Icons/getIconAndTintForNoteType'
import { useItemLinks } from '@/Hooks/useItemLinks'
import { ItemLink } from '@/Utils/Items/Search/ItemLink'
import ListItemVaultInfo from '../ContentListView/ListItemVaultInfo'
import ItemOptionsMenu, { type ReadonlyFileActions } from './ItemOptionsMenu'

export const ContextMenuCell = ({
  items,
  isFileAttachedToNote,
  readonlyFileActions,
}: {
  items: DecryptedItemInterface[]
  isFileAttachedToNote?: boolean
  readonlyFileActions?: ReadonlyFileActions
}) => {
  const [contextMenuVisible, setContextMenuVisible] = useState(false)
  const anchorElementRef = useRef<HTMLButtonElement>(null)

  const allItemsAreNotes = useMemo(() => {
    return items.every((item) => item instanceof SNNote)
  }, [items])

  const allItemsAreFiles = useMemo(() => {
    return items.every((item) => item instanceof FileItem)
  }, [items])

  if (!allItemsAreNotes && !allItemsAreFiles) {
    return null
  }

  const closeMenu = () => {
    setContextMenuVisible(false)
    anchorElementRef.current?.focus()
  }

  return (
    <>
      <button
        className="border-border bg-default rounded-full border p-1"
        ref={anchorElementRef}
        aria-label={allItemsAreFiles ? 'File options' : 'Note options'}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setContextMenuVisible((visible) => !visible)
        }}
      >
        <Icon type="more" />
      </button>
      <ItemOptionsMenu
        items={items}
        open={contextMenuVisible}
        anchorElement={anchorElementRef}
        closeMenu={closeMenu}
        isFileAttachedToNote={isFileAttachedToNote}
        readonlyFileActions={readonlyFileActions}
      />
    </>
  )
}

export const ItemLinksCell = ({ item }: { item: DecryptedItemInterface }) => {
  const [contextMenuVisible, setContextMenuVisible] = useState(false)
  const anchorElementRef = useRef<HTMLButtonElement>(null)

  return (
    <>
      <button
        className="border-border bg-default rounded-full border p-1"
        ref={anchorElementRef}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setContextMenuVisible((visible) => !visible)
        }}
      >
        <Icon type="link" />
      </button>
      <Popover
        title="Linked items"
        open={contextMenuVisible}
        anchorElement={anchorElementRef}
        togglePopover={() => {
          setContextMenuVisible(false)
        }}
        side="bottom"
        align="start"
        className="py-2"
      >
        <LinkedItemsPanel item={item} />
      </Popover>
    </>
  )
}

const ItemNameCell = ({ item, hideIcon }: { item: DecryptedItemInterface; hideIcon: boolean }) => {
  const application = useApplication()
  const [backupInfo, setBackupInfo] = useState<FileBackupRecord | undefined>(undefined)
  const isItemFile = item instanceof FileItem

  const editor = isNote(item) ? application.componentManager.editorForNote(item) : undefined
  const noteType = isNote(item) ? item.noteType : editor ? editor.noteType : undefined

  const [noteIcon, noteIconTint] = getIconAndTintForNoteType(noteType)

  useEffect(() => {
    if (isItemFile) {
      void application.fileBackups?.getFileBackupInfo(item).then(setBackupInfo)
    }
  }, [application, isItemFile, item])

  return (
    <div className="flex items-center gap-3 whitespace-normal">
      <span className="relative">
        {!hideIcon ? (
          isItemFile ? (
            getFileIconComponent(getIconForFileType(item.mimeType), 'w-6 h-6 flex-shrink-0')
          ) : (
            <Icon type={noteIcon} className={`text-accessory-tint-${noteIconTint}`} />
          )
        ) : null}
        {backupInfo && (
          <div
            className="bg-default text-success absolute right-1 bottom-1 translate-x-1/2 translate-y-1/2 rounded-full"
            title="File is backed up locally"
          >
            <Icon size="small" type="check-circle-filled" />
          </div>
        )}
      </span>
      <span className="overflow-hidden text-sm font-medium text-ellipsis whitespace-nowrap">{item.title}</span>
      <ListItemVaultInfo item={item} />
      {item.protected && (
        <span className="flex items-center" title="File is protected">
          <Icon ariaLabel="File is protected" type="lock-filled" className="text-passive-1 h-3.5 w-3.5" size="custom" />
        </span>
      )}
    </div>
  )
}

const AttachedToCell = ({ item }: { item: DecryptedItemInterface }) => {
  const { notesLinkedToItem, notesLinkingToItem, filesLinkedToItem, filesLinkingToItem, tagsLinkedToItem } =
    useItemLinks(item)
  const application = useApplication()

  const allLinks: ItemLink[] = (notesLinkedToItem as ItemLink[]).concat(
    notesLinkingToItem,
    filesLinkedToItem,
    filesLinkingToItem,
    tagsLinkedToItem,
  )

  if (!allLinks.length) {
    return null
  }

  return (
    <div className="flex items-center gap-2 overflow-hidden">
      <LinkedItemBubble
        className="hover:border-border focus:border-info overflow-hidden border border-transparent focus:shadow-none"
        link={allLinks[0]}
        key={allLinks[0].id}
        unlinkItem={async (itemToUnlink) => {
          void application.mutator.unlinkItems(item, itemToUnlink)
        }}
        isBidirectional={false}
      />
      {allLinks.length - 1 >= 1 && <span>and {allLinks.length - 1} more...</span>}
    </div>
  )
}

type Props = {
  application: WebApplication
  items: DecryptedItemInterface[]
}

const ContentTableView = ({ application, items }: Props) => {
  const listHasFiles = items.some((item) => item instanceof FileItem)

  const { sortBy: rawSortBy, sortDirection } = application.itemListController.displayOptions
  // The table layout has no manual-order column; fall back to title for display
  // purposes when the (list-only) Custom sort is active.
  const sortBy: keyof SortableItem = rawSortBy === CollectionSort.Custom ? 'title' : (rawSortBy as keyof SortableItem)
  const sortReversed = sortDirection === 'asc'
  const { hideDate, hideEditorIcon: hideIcon, hideTags } = application.itemListController.webDisplayOptions

  const onSortChange = useCallback(
    async (sortBy: keyof SortableItem, sortReversed: boolean) => {
      const selectedTag = application.navigationController.selected

      if (!selectedTag) {
        return
      }

      // The Files system view is no longer selectable here — its sort preference is
      // owned by the Files tab (see FilesView/filesViewSortPreference).
      if (isSmartView(selectedTag) && isSystemView(selectedTag)) {
        return
      }

      await application.changeAndSaveItem.execute<TagMutator>(selectedTag, (mutator) => {
        mutator.preferences = {
          ...mutator.preferences,
          sortBy,
          sortReverse: sortReversed,
        }
      })
    },
    [application],
  )

  const [contextMenuItem, setContextMenuItem] = useState<DecryptedItemInterface | undefined>(undefined)
  const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number; y: number } | undefined>(undefined)
  const [contextMenuTrigger, setContextMenuTrigger] = useState<HTMLElement | undefined>(undefined)

  const isSmallBreakpoint = useMediaQuery(MutuallyExclusiveMediaQueryBreakpoints.sm)
  const isMediumBreakpoint = useMediaQuery(MutuallyExclusiveMediaQueryBreakpoints.md)
  const isLargeBreakpoint = useMediaQuery(MutuallyExclusiveMediaQueryBreakpoints.lg)

  const columnDefs: TableColumn<DecryptedItemInterface>[] = useMemo(
    () => [
      {
        name: 'Name',
        sortBy: 'title',
        cell: (item) => <ItemNameCell item={item} hideIcon={hideIcon} />,
      },
      {
        name: 'Upload date',
        sortBy: 'created_at',
        cell: (item) => {
          return formatDateForContextMenu(item.created_at)
        },
        hidden: isSmallBreakpoint || hideDate,
      },
      {
        name: 'Size',
        sortBy: 'decryptedSize',
        cell: (item) => {
          return item instanceof FileItem ? formatSizeToReadableString(item.decryptedSize) : null
        },
        hidden: isSmallBreakpoint || !listHasFiles,
      },
      {
        name: 'Attached to',
        hidden: isSmallBreakpoint || isMediumBreakpoint || isLargeBreakpoint || hideTags,
        cell: (item) => <AttachedToCell item={item} />,
      },
    ],
    [hideDate, hideIcon, hideTags, isLargeBreakpoint, isMediumBreakpoint, isSmallBreakpoint, listHasFiles],
  )

  const getRowId = useCallback((item: DecryptedItemInterface) => item.uuid, [])

  const table = useTable({
    data: items,
    sortBy,
    sortReversed,
    onSortChange,
    getRowId,
    columns: columnDefs,
    enableRowSelection: true,
    enableMultipleRowSelection: true,
    onRowActivate(item) {
      if (item instanceof FileItem) {
        void application.filesController.handleFileAction({
          type: FileItemActionType.PreviewFile,
          payload: {
            file: item,
            otherFiles: items.filter((i) => i instanceof FileItem) as FileItem[],
          },
        })
      }
    },
    onRowContextMenu(x, y, file, trigger) {
      setContextMenuPosition({ x, y })
      setContextMenuItem(file)
      setContextMenuTrigger(trigger)
    },
    rowActions: (item) => {
      const vault = application.vaults.getItemVault(item)
      const isReadonly = vault?.isSharedVaultListing() && application.vaultUsers.isCurrentUserReadonlyVaultMember(vault)

      return (
        <div className="flex items-center gap-2">
          {!isReadonly && <ItemLinksCell item={item} />}
          <ContextMenuCell items={[item]} />
        </div>
      )
    },
    selectionActions: (itemIds) => <ContextMenuCell items={items.filter((item) => itemIds.includes(item.uuid))} />,
    showSelectionActions: true,
  })

  const closeContextMenu = () => {
    setContextMenuPosition(undefined)
    setContextMenuItem(undefined)
    contextMenuTrigger?.focus()
    setContextMenuTrigger(undefined)
  }

  return (
    <>
      <Table table={table} />
      {contextMenuPosition && contextMenuItem && (
        <ItemOptionsMenu
          items={[contextMenuItem]}
          open={true}
          anchorPoint={contextMenuPosition}
          closeMenu={closeContextMenu}
        />
      )}
    </>
  )
}
export default ContentTableView
