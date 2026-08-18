import { FileItem, DecryptedItemInterface, SNNote } from '@standardnotes/snjs'
import { RefObject, useMemo } from 'react'
import FileMenuOptions from '../FileContextMenu/FileMenuOptions'
import Menu from '../Menu/Menu'
import NotesOptions from '../NotesOptions/NotesOptions'
import Popover from '../Popover/Popover'
import MenuItem from '../Menu/MenuItem'
import MenuSection from '../Menu/MenuSection'

export type ReadonlyFileActions = {
  previewFile: (file: FileItem) => void
  downloadFile: (file: FileItem) => void
}

export type ItemOptionsMenuProps = {
  items: DecryptedItemInterface[]
  open: boolean
  closeMenu: () => void
  anchorElement?: RefObject<HTMLElement | null>
  anchorPoint?: { x: number; y: number }
  isFileAttachedToNote?: boolean
  readonlyFileActions?: ReadonlyFileActions
}

/**
 * The one action model used by visible ellipsis buttons and row context menus.
 * Full file/note menus keep their existing permission and item-state guards.
 * Readonly attachment callers must opt into the separate view/download-only
 * model, so mutation callbacks are never constructed for that surface.
 */
const ItemOptionsMenu = ({
  items,
  open,
  closeMenu,
  anchorElement,
  anchorPoint,
  isFileAttachedToNote,
  readonlyFileActions,
}: ItemOptionsMenuProps) => {
  const allItemsAreNotes = useMemo(() => items.length > 0 && items.every((item) => item instanceof SNNote), [items])
  const allItemsAreFiles = useMemo(() => items.length > 0 && items.every((item) => item instanceof FileItem), [items])

  if (!allItemsAreNotes && !allItemsAreFiles) {
    return null
  }

  const menu = (
    <Menu a11yLabel={allItemsAreFiles ? 'File context menu' : 'Note context menu'} closeMenu={closeMenu}>
      {allItemsAreFiles &&
        (readonlyFileActions ? (
          <MenuSection>
            {items.length === 1 && (
              <MenuItem
                onClick={() => {
                  readonlyFileActions.previewFile(items[0] as FileItem)
                  closeMenu()
                }}
              >
                Preview
              </MenuItem>
            )}
            <MenuItem
              onClick={() => {
                for (const file of items as FileItem[]) {
                  readonlyFileActions.downloadFile(file)
                }
                closeMenu()
              }}
            >
              Download
            </MenuItem>
          </MenuSection>
        ) : (
          <FileMenuOptions
            closeMenu={closeMenu}
            isFileAttachedToNote={isFileAttachedToNote}
            shouldShowRenameOption={true}
            shouldShowAttachOption={false}
            selectedFiles={items as FileItem[]}
          />
        ))}
      {allItemsAreNotes && <NotesOptions notes={items as SNNote[]} closeMenu={closeMenu} />}
    </Menu>
  )

  const commonProps = {
    title: allItemsAreFiles ? 'File options' : 'Note options',
    open,
    togglePopover: closeMenu,
    side: 'bottom' as const,
    align: 'start' as const,
    className: 'py-2',
  }

  return anchorPoint ? (
    <Popover {...commonProps} anchorPoint={anchorPoint}>
      {menu}
    </Popover>
  ) : (
    <Popover {...commonProps} anchorElement={anchorElement ?? null}>
      {menu}
    </Popover>
  )
}

export default ItemOptionsMenu
