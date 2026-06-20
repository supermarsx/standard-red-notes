import { observer } from 'mobx-react-lite'
import { FunctionComponent, useCallback, useMemo, useRef, useState } from 'react'
import Icon from '@/Components/Icon/Icon'
import { NavigationController } from '@/Controllers/Navigation/NavigationController'
import { KeyboardKey } from '@standardnotes/ui-services'
import Popover from '../Popover/Popover'
import { classNames, SNFolder, SNNote } from '@standardnotes/snjs'
import { useApplication } from '../ApplicationProvider'
import MenuItem from '../Menu/MenuItem'
import Menu from '../Menu/Menu'

type Props = {
  navigationController: NavigationController
  note: SNNote
  iconClassName: string
  disabled?: boolean
}

type FolderListEntry = {
  folder: SNFolder
  depth: number
}

const MoveToFolderOption: FunctionComponent<Props> = ({ navigationController, note, iconClassName, disabled }) => {
  const application = useApplication()
  const menuContainerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const [isOpen, setIsOpen] = useState(false)

  const toggleMenu = useCallback(() => {
    setIsOpen((isOpen) => !isOpen)
  }, [])

  // Build a flat, depth-indented list of all folders by recursing the folder tree.
  const folderEntries = useMemo<FolderListEntry[]>(() => {
    const entries: FolderListEntry[] = []
    const visit = (folder: SNFolder, depth: number) => {
      entries.push({ folder, depth })
      for (const child of navigationController.getFolderChildren(folder)) {
        visit(child, depth + 1)
      }
    }
    for (const root of navigationController.allLocalRootFolders) {
      visit(root, 0)
    }
    return entries
  }, [navigationController])

  const currentFolder = navigationController.getNoteFolder(note)

  const moveToFolder = useCallback(
    (folder: SNFolder | undefined) => {
      navigationController.moveNoteToFolder(note, folder).catch(console.error)
      setIsOpen(false)
    },
    [navigationController, note],
  )

  if (folderEntries.length === 0) {
    return (
      <MenuItem disabled>
        <Icon type="folder" className={iconClassName} />
        No folders yet
      </MenuItem>
    )
  }

  return (
    <div ref={menuContainerRef}>
      <MenuItem
        className="justify-between"
        onClick={toggleMenu}
        onKeyDown={(event) => {
          if (event.key === KeyboardKey.Escape) {
            setIsOpen(false)
          }
        }}
        ref={buttonRef}
        disabled={disabled}
      >
        <div className="flex items-center overflow-hidden">
          <Icon type="folder" className={iconClassName} />
          <span className="overflow-hidden overflow-ellipsis whitespace-nowrap">
            Move to folder
            {currentFolder && <span className="ml-1 text-neutral">({currentFolder.title})</span>}
          </span>
        </div>
        <Icon type="chevron-right" className="text-neutral" />
      </MenuItem>
      <Popover
        title="Move to folder"
        togglePopover={toggleMenu}
        anchorElement={buttonRef}
        open={isOpen}
        side="right"
        align="start"
        className="py-2"
        overrideZIndex="z-modal"
      >
        <Menu a11yLabel="Folder selection menu" className="!px-0">
          <MenuItem onClick={() => moveToFolder(undefined)}>
            <Icon type="close" className={iconClassName} />
            <span className={classNames('overflow-hidden overflow-ellipsis whitespace-nowrap', !currentFolder && 'font-bold')}>
              No folder
            </span>
          </MenuItem>
          {folderEntries.map(({ folder, depth }) => {
            const isCurrent = currentFolder?.uuid === folder.uuid
            return (
              <MenuItem key={folder.uuid} onClick={() => moveToFolder(folder)}>
                <span style={{ width: `${depth * 1}rem` }} className="flex-shrink-0" aria-hidden />
                <Icon type="folder" className={iconClassName} />
                <span
                  className={classNames(
                    'overflow-hidden overflow-ellipsis whitespace-nowrap',
                    isCurrent ? 'font-bold' : '',
                  )}
                >
                  {folder.title}
                </span>
                {isCurrent && <Icon type="check" className="ml-auto text-info" />}
              </MenuItem>
            )
          })}
        </Menu>
      </Popover>
    </div>
  )
}

export default observer(MoveToFolderOption)
