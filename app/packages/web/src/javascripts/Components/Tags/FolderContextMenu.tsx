import { observer } from 'mobx-react-lite'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import Icon from '@/Components/Icon/Icon'
import Menu from '@/Components/Menu/Menu'
import MenuItem from '@/Components/Menu/MenuItem'
import { usePremiumModal } from '@/Hooks/usePremiumModal'
import { SNFolder, VectorIconNameOrEmoji, DefaultFolderIconName } from '@standardnotes/snjs'
import { NavigationController } from '@/Controllers/Navigation/NavigationController'
import HorizontalSeparator from '../Shared/HorizontalSeparator'
import { formatDateForContextMenu } from '@/Utils/DateUtils'
import { PremiumFeatureIconClass, PremiumFeatureIconName } from '../Icon/PremiumFeatureIcon'
import Popover from '../Popover/Popover'
import IconPicker from '../Icon/IconPicker'
import { useApplication } from '../ApplicationProvider'
import MenuSection from '../Menu/MenuSection'
import DecoratedInput from '../Input/DecoratedInput'
import { KeyboardKey } from '@standardnotes/ui-services'
import TagColorPicker from './TagColorPicker'

type ContextMenuProps = {
  navigationController: NavigationController
  isEntitledToFolders: boolean
  selectedFolder: SNFolder
}

const FolderContextMenu = ({ navigationController, isEntitledToFolders, selectedFolder }: ContextMenuProps) => {
  const application = useApplication()

  const premiumModal = usePremiumModal()

  const { contextMenuOpen, contextMenuClickLocation } = navigationController

  const onClickAddSubfolder = useCallback(() => {
    if (!isEntitledToFolders) {
      premiumModal.activate('Folders')
      return
    }

    navigationController.setContextMenuOpen(false)
    navigationController.setAddingSubfolderTo(selectedFolder)
  }, [isEntitledToFolders, navigationController, selectedFolder, premiumModal])

  const onClickDelete = useCallback(() => {
    navigationController.removeFolder(selectedFolder, true).catch(console.error)
  }, [navigationController, selectedFolder])

  const folderHasLocalOnlyNotes = navigationController.tagOrFolderHasAnyLocalOnlyNotes(selectedFolder)
  const onClickToggleLocalOnly = useCallback(() => {
    navigationController.setTagOrFolderNotesLocalOnly(selectedFolder, !folderHasLocalOnlyNotes).catch(console.error)
    navigationController.setContextMenuOpen(false)
  }, [navigationController, selectedFolder, folderHasLocalOnlyNotes])

  const folderLastModified = useMemo(
    () => formatDateForContextMenu(selectedFolder.userModifiedDate),
    [selectedFolder.userModifiedDate],
  )

  const handleIconChange = (value?: VectorIconNameOrEmoji) => {
    navigationController.setFolderIcon(selectedFolder, value || DefaultFolderIconName)
  }

  const handleColorChange = (color: string | undefined) => {
    navigationController.setFolderColor(selectedFolder, color)
  }

  const folderCreatedAt = useMemo(
    () => formatDateForContextMenu(selectedFolder.created_at),
    [selectedFolder.created_at],
  )

  const titleInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (contextMenuOpen) {
      setTimeout(() => {
        titleInputRef.current?.focus()
      })
    }
  }, [contextMenuOpen])

  const saveTitle = useCallback(
    (closeMenu = false) => {
      if (!titleInputRef.current) {
        return
      }
      const value = titleInputRef.current.value.trim()
      navigationController
        .renameFolder(selectedFolder, value)
        .catch(console.error)
        .finally(() => {
          if (closeMenu) {
            navigationController.setContextMenuOpen(false)
          }
        })
    },
    [navigationController, selectedFolder],
  )

  return (
    <Popover
      title="Folder options"
      open={contextMenuOpen}
      anchorPoint={contextMenuClickLocation}
      togglePopover={() => navigationController.setContextMenuOpen(!contextMenuOpen)}
      className="py-2"
    >
      <div className="flex flex-col gap-1 px-4 py-0.5 text-mobile-menu-item md:px-3 md:text-tablet-menu-item lg:text-menu-item">
        <div className="font-semibold">Name</div>
        <div className="flex gap-2.5">
          <DecoratedInput
            ref={titleInputRef}
            className={{
              container: 'flex-grow',
              input: 'text-mobile-menu-item md:text-tablet-menu-item lg:text-menu-item',
            }}
            defaultValue={selectedFolder.title}
            key={selectedFolder.uuid}
            onBlur={() => saveTitle()}
            onKeyDown={(event) => {
              if (event.key === KeyboardKey.Enter) {
                saveTitle(true)
              }
            }}
          />
          <button
            aria-label="Save folder name"
            className="rounded border border-border bg-transparent px-1.5 active:bg-default translucent-ui:border-[--popover-border-color] md:hidden"
            onClick={() => saveTitle(true)}
          >
            <Icon type="check" />
          </button>
        </div>
      </div>
      <HorizontalSeparator classes="my-2" />
      <Menu a11yLabel="Folder context menu">
        <IconPicker
          key={selectedFolder.uuid}
          onIconChange={handleIconChange}
          selectedValue={selectedFolder.iconString}
          platform={application.platform}
          className={'py-1.5 md:px-3'}
          useIconGrid={true}
          iconGridClassName="max-h-30"
          autoFocus={false}
        />
        <div className="px-4 py-1.5 text-mobile-menu-item md:px-3 md:text-tablet-menu-item lg:text-menu-item">
          <TagColorPicker selectedColor={selectedFolder.color} onChange={handleColorChange} />
        </div>
        <MenuSection>
          <MenuItem className={'justify-between py-1.5'} onClick={onClickAddSubfolder}>
            <div className="flex items-center">
              <Icon type="add" className="mr-2 text-neutral" />
              Add subfolder
            </div>
            {!isEntitledToFolders && <Icon type={PremiumFeatureIconName} className={PremiumFeatureIconClass} />}
          </MenuItem>
          <MenuItem className={'py-1.5'} onClick={onClickToggleLocalOnly}>
            <Icon type="cloud-off" className="mr-2 text-neutral" />
            <div className="flex flex-col">
              <div>
                {folderHasLocalOnlyNotes
                  ? "Re-enable sync for this folder's notes"
                  : "Keep this folder's notes local only"}
              </div>
              <div className="mt-0.5 text-xs text-passive-0">
                {folderHasLocalOnlyNotes
                  ? 'Notes will sync to the server again.'
                  : "Notes stay on this device. Won't be backed up or appear on other devices."}
              </div>
            </div>
          </MenuItem>
          <MenuItem className={'py-1.5'} onClick={onClickDelete}>
            <Icon type="trash" className="mr-2 text-danger" />
            <span className="text-danger">Delete</span>
          </MenuItem>
        </MenuSection>
      </Menu>
      <HorizontalSeparator classes="my-2" />
      <div className="px-4 pb-1.5 pt-1 text-sm font-medium text-neutral md:px-3 lg:text-xs">
        <div className="mb-1">
          <span className="font-semibold">Last modified:</span> {folderLastModified}
        </div>
        <div className="mb-1">
          <span className="font-semibold">Created:</span> {folderCreatedAt}
        </div>
        <div>
          <span className="font-semibold">Folder ID:</span> {selectedFolder.uuid}
        </div>
      </div>
    </Popover>
  )
}

export default observer(FolderContextMenu)
