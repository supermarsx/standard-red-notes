import { FilesController } from '@/Controllers/FilesController'
import { FileItem } from '@standardnotes/snjs'
import { useState } from 'react'
import { FileItemActionType } from '../AttachedFilesPopover/PopoverFileItemAction'
import { FileContextMenuBackupOption } from '../FileContextMenu/FileContextMenuBackupOption'
import Icon from '../Icon/Icon'
import MenuItem from '../Menu/MenuItem'
import MenuSwitchButtonItem from '../Menu/MenuSwitchButtonItem'
import HorizontalSeparator from '../Shared/HorizontalSeparator'

type Props = {
  file: FileItem
  closeMenu: () => void
  handleFileAction: FilesController['handleFileAction']
  setIsRenamingFile: (set: boolean) => void
}

const LinkedFileMenuOptions = ({ file, closeMenu, handleFileAction, setIsRenamingFile }: Props) => {
  const [isFileProtected, setIsFileProtected] = useState(file.protected)

  return (
    <>
      <MenuItem
        onClick={() => {
          void handleFileAction({
            type: FileItemActionType.PreviewFile,
            payload: {
              file,
              otherFiles: [],
            },
          })
          closeMenu()
        }}
      >
        <Icon type="file" className="text-neutral mr-2" />
        Preview file
      </MenuItem>
      <HorizontalSeparator classes="my-1" />
      <MenuSwitchButtonItem
        className="justify-between"
        checked={isFileProtected}
        onChange={() => {
          handleFileAction({
            type: FileItemActionType.ToggleFileProtection,
            payload: { file },
            callback: (isProtected: boolean) => {
              setIsFileProtected(isProtected)
            },
          }).catch(console.error)
        }}
      >
        <Icon type="lock" className="text-neutral mr-2" />
        Password protect
      </MenuSwitchButtonItem>
      <HorizontalSeparator classes="my-1" />
      <MenuItem
        onClick={() => {
          handleFileAction({
            type: FileItemActionType.DownloadFile,
            payload: { file },
          }).catch(console.error)
          closeMenu()
        }}
      >
        <Icon type="download" className="text-neutral mr-2" />
        Download
      </MenuItem>
      <MenuItem
        onClick={() => {
          setIsRenamingFile(true)
          closeMenu()
        }}
      >
        <Icon type="pencil" className="text-neutral mr-2" />
        Rename
      </MenuItem>
      <MenuItem
        onClick={() => {
          handleFileAction({
            type: FileItemActionType.DeleteFile,
            payload: { file },
          }).catch(console.error)
          closeMenu()
        }}
      >
        <Icon type="trash" className="text-danger mr-2" />
        <span className="text-danger">Delete permanently</span>
      </MenuItem>

      <FileContextMenuBackupOption file={file} />
    </>
  )
}

export default LinkedFileMenuOptions
