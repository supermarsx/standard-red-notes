import { observer } from 'mobx-react-lite'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import Icon from '@/Components/Icon/Icon'
import Menu from '@/Components/Menu/Menu'
import MenuItem from '@/Components/Menu/MenuItem'
import { SNTag, VectorIconNameOrEmoji, DefaultTagIconName } from '@standardnotes/snjs'
import { NavigationController } from '@/Controllers/Navigation/NavigationController'
import HorizontalSeparator from '../Shared/HorizontalSeparator'
import { formatDateForContextMenu } from '@/Utils/DateUtils'
import Popover from '../Popover/Popover'
import IconPicker from '../Icon/IconPicker'
import AddToVaultMenuOption from '../Vaults/AddToVaultMenuOption'
import { useApplication } from '../ApplicationProvider'
import MenuSection from '../Menu/MenuSection'
import DecoratedInput from '../Input/DecoratedInput'
import { KeyboardKey } from '@standardnotes/ui-services'
import TagColorPicker from './TagColorPicker'

type ContextMenuProps = {
  navigationController: NavigationController
  selectedTag: SNTag
}

const TagContextMenu = ({ navigationController, selectedTag }: ContextMenuProps) => {
  const application = useApplication()

  const { contextMenuOpen, contextMenuClickLocation } = navigationController

  const onClickDelete = useCallback(() => {
    navigationController.remove(selectedTag, true).catch(console.error)
  }, [navigationController, selectedTag])

  const onClickAddSubtag = useCallback(() => {
    navigationController.setContextMenuOpen(false)
    navigationController.setAddingSubtagTo(selectedTag)
  }, [navigationController, selectedTag])

  const tagLastModified = useMemo(
    () => formatDateForContextMenu(selectedTag.userModifiedDate),
    [selectedTag.userModifiedDate],
  )

  const handleIconChange = (value?: VectorIconNameOrEmoji) => {
    navigationController.setIcon(selectedTag, value || DefaultTagIconName)
  }

  const handleColorChange = (color: string | undefined) => {
    navigationController.setColor(selectedTag, color)
  }

  const onClickStar = useCallback(() => {
    navigationController.setFavorite(selectedTag, !selectedTag.starred).catch(console.error)
    navigationController.setContextMenuOpen(false)
  }, [navigationController, selectedTag])

  const tagHasLocalOnlyNotes = navigationController.tagOrFolderHasAnyLocalOnlyNotes(selectedTag)
  const canEnableLocalOnly = navigationController.canEnableLocalOnlyForTagOrFolder(selectedTag)
  const onClickToggleLocalOnly = useCallback(() => {
    navigationController.setTagOrFolderNotesLocalOnly(selectedTag, !tagHasLocalOnlyNotes).catch(console.error)
    navigationController.setContextMenuOpen(false)
  }, [navigationController, selectedTag, tagHasLocalOnlyNotes])

  const tagCreatedAt = useMemo(() => formatDateForContextMenu(selectedTag.created_at), [selectedTag.created_at])

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
        .save(selectedTag, value)
        .catch(console.error)
        .finally(() => {
          if (closeMenu) {
            navigationController.setContextMenuOpen(false)
          }
        })
    },
    [navigationController, selectedTag],
  )

  return (
    <Popover
      title="Topic options"
      open={contextMenuOpen}
      anchorPoint={contextMenuClickLocation}
      togglePopover={() => navigationController.setContextMenuOpen(!contextMenuOpen)}
      className="py-2"
    >
      <div className="text-mobile-menu-item md:text-tablet-menu-item lg:text-menu-item flex flex-col gap-1 px-4 py-0.5 md:px-3">
        <div className="font-semibold">Name</div>
        <div className="flex gap-2.5">
          <DecoratedInput
            ref={titleInputRef}
            className={{
              container: 'flex-grow',
              input: 'text-mobile-menu-item md:text-tablet-menu-item lg:text-menu-item',
            }}
            defaultValue={selectedTag.title}
            key={selectedTag.uuid}
            onBlur={() => saveTitle()}
            onKeyDown={(event) => {
              if (event.key === KeyboardKey.Enter) {
                saveTitle(true)
              }
            }}
          />
          <button
            aria-label="Save topic name"
            className="border-border active:bg-default translucent-ui:border-[--popover-border-color] rounded border bg-transparent px-1.5 md:hidden"
            onClick={() => saveTitle(true)}
          >
            <Icon type="check" />
          </button>
        </div>
      </div>
      <HorizontalSeparator classes="my-2" />
      <Menu a11yLabel="Topic context menu">
        <IconPicker
          key={selectedTag.uuid}
          onIconChange={handleIconChange}
          selectedValue={selectedTag.iconString}
          platform={application.platform}
          className={'py-1.5 md:px-3'}
          useIconGrid={true}
          iconGridClassName="max-h-30"
          autoFocus={false}
        />
        <div className="text-mobile-menu-item md:text-tablet-menu-item lg:text-menu-item px-4 py-1.5 md:px-3">
          <TagColorPicker selectedColor={selectedTag.color} onChange={handleColorChange} />
        </div>
        <MenuSection>
          {application.featuresController.isVaultsEnabled() && (
            <AddToVaultMenuOption iconClassName="mr-2 text-neutral" items={[selectedTag]} />
          )}
          <MenuItem className={'justify-between py-1.5'} onClick={onClickStar}>
            <div className="flex items-center">
              <Icon type="star" className="text-neutral mr-2" />
              {selectedTag.starred ? 'Unfavorite' : 'Favorite'}
            </div>
          </MenuItem>
          <MenuItem className={'justify-between py-1.5'} onClick={onClickAddSubtag}>
            <div className="flex items-center">
              <Icon type="add" className="text-neutral mr-2" />
              Add subtopic
            </div>
          </MenuItem>
          <MenuItem
            className={'py-1.5'}
            onClick={onClickToggleLocalOnly}
            disabled={!tagHasLocalOnlyNotes && !canEnableLocalOnly}
          >
            <Icon type="cloud-off" className="text-neutral mr-2" />
            <div className="flex flex-col">
              <div>
                {tagHasLocalOnlyNotes ? "Re-enable sync for this topic's notes" : "Keep this topic's notes local only"}
              </div>
              <div className="text-passive-0 mt-0.5 text-xs">
                {tagHasLocalOnlyNotes
                  ? 'Notes will sync to the server again.'
                  : canEnableLocalOnly
                    ? "Available before first sync. Notes won't be backed up or appear on other devices."
                    : 'Unavailable: at least one note has already synced and has a server copy.'}
              </div>
            </div>
          </MenuItem>
          <MenuItem className={'py-1.5'} onClick={onClickDelete}>
            <Icon type="trash" className="text-danger mr-2" />
            <span className="text-danger">Delete</span>
          </MenuItem>
        </MenuSection>
      </Menu>
      <HorizontalSeparator classes="my-2" />
      <div className="text-neutral px-4 pt-1 pb-1.5 text-sm font-medium md:px-3 lg:text-xs">
        <div className="mb-1">
          <span className="font-semibold">Last modified:</span> {tagLastModified}
        </div>
        <div className="mb-1">
          <span className="font-semibold">Created:</span> {tagCreatedAt}
        </div>
        <div>
          <span className="font-semibold">Topic ID:</span> {selectedTag.uuid}
        </div>
      </div>
    </Popover>
  )
}

export default observer(TagContextMenu)
