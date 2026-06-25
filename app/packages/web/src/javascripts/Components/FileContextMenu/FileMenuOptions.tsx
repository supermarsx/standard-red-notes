import { FunctionComponent, useCallback, useMemo, useState } from 'react'
import { FileItemActionType } from '../AttachedFilesPopover/PopoverFileItemAction'
import Icon from '@/Components/Icon/Icon'
import { observer } from 'mobx-react-lite'
import { formatSizeToReadableString } from '@standardnotes/filepicker'
import { useResponsiveAppPane } from '../Panes/ResponsivePaneProvider'
import { AppPaneId } from '../Panes/AppPaneMetadata'
import MenuItem from '../Menu/MenuItem'
import { FileContextMenuBackupOption } from './FileContextMenuBackupOption'
import MenuSwitchButtonItem from '../Menu/MenuSwitchButtonItem'
import { FileItem } from '@standardnotes/snjs'
import { KeyboardKey } from '@standardnotes/ui-services'
import AddTagOption from '../NotesOptions/AddTagOption'
import MoveFileToFolderOption from './MoveFileToFolderOption'
import { MenuItemIconSize } from '@/Constants/TailwindClassNames'
import AddToVaultMenuOption from '../Vaults/AddToVaultMenuOption'
import { iconClass } from '../NotesOptions/ClassNames'
import { useApplication } from '../ApplicationProvider'
import MenuSection from '../Menu/MenuSection'
import { ToastType, addToast } from '@standardnotes/toast'
import { useTranslation } from 'react-i18next'

type Props = {
  closeMenu: () => void
  isFileAttachedToNote?: boolean
  renameToggleCallback?: (isRenamingFile: boolean) => void
  shouldShowRenameOption: boolean
  shouldShowAttachOption: boolean
  selectedFiles: FileItem[]
}

const FileMenuOptions: FunctionComponent<Props> = ({
  closeMenu,
  isFileAttachedToNote,
  renameToggleCallback,
  shouldShowRenameOption,
  shouldShowAttachOption,
  selectedFiles,
}) => {
  const { t } = useTranslation('files')
  const application = useApplication()

  const { shouldUseStreamingAPI, handleFileAction } = application.filesController
  const { toggleAppPane } = useResponsiveAppPane()

  const [isRenaming, setIsRenaming] = useState(false)

  const fileToRename = selectedFiles.length === 1 ? selectedFiles[0] : undefined

  const submitRename = useCallback(
    async (newName: string) => {
      const trimmed = newName.trim()
      if (fileToRename && trimmed.length > 0 && trimmed !== fileToRename.name) {
        await application.mutator.renameFile(fileToRename, trimmed)
        void application.sync.sync()
      }
      setIsRenaming(false)
      renameToggleCallback?.(false)
    },
    [application, fileToRename, renameToggleCallback],
  )

  const beginRename = useCallback(() => {
    renameToggleCallback?.(true)
    setIsRenaming(true)
  }, [renameToggleCallback])

  const hasProtectedFiles = useMemo(() => selectedFiles.some((file) => file.protected), [selectedFiles])
  const hasSelectedMultipleFiles = useMemo(() => selectedFiles.length > 1, [selectedFiles.length])
  const canShowZipDownloadOption = shouldUseStreamingAPI && hasSelectedMultipleFiles

  const totalFileSize = useMemo(
    () => selectedFiles.map((file) => file.decryptedSize).reduce((prev, next) => prev + next, 0),
    [selectedFiles],
  )

  const onDetach = useCallback(() => {
    const file = selectedFiles[0]
    void handleFileAction({
      type: FileItemActionType.DetachFileToNote,
      payload: { file },
    })
    closeMenu()
  }, [closeMenu, handleFileAction, selectedFiles])

  const onAttach = useCallback(() => {
    const file = selectedFiles[0]
    void handleFileAction({
      type: FileItemActionType.AttachFileToNote,
      payload: { file },
    })
    closeMenu()
  }, [closeMenu, handleFileAction, selectedFiles])

  const closeMenuAndToggleFilesList = useCallback(() => {
    toggleAppPane(AppPaneId.Items)
    closeMenu()
  }, [closeMenu, toggleAppPane])

  const areSomeFilesInReadonlySharedVault = selectedFiles.some((file) => {
    const vault = application.vaults.getItemVault(file)
    return vault?.isSharedVaultListing() && application.vaultUsers.isCurrentUserReadonlyVaultMember(vault)
  })
  const hasAdminPermissionForAllSharedFiles = selectedFiles.every((file) => {
    const vault = application.vaults.getItemVault(file)
    if (!vault?.isSharedVaultListing()) {
      return true
    }
    return application.vaultUsers.isCurrentUserSharedVaultAdmin(vault)
  })

  if (selectedFiles.length === 0) {
    return <div className="text-center">{t('noFilesSelected')}</div>
  }

  if (isRenaming && fileToRename) {
    return (
      <div className="flex items-center gap-2 px-3 py-2">
        <Icon type="pencil" className={`text-neutral ${MenuItemIconSize}`} />
        <input
          className="min-w-0 flex-grow rounded border border-border bg-default px-2 py-1 text-sm"
          defaultValue={fileToRename.name}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            if (event.key === KeyboardKey.Enter) {
              event.preventDefault()
              void submitRename(event.currentTarget.value)
            } else if (event.key === KeyboardKey.Escape) {
              setIsRenaming(false)
              renameToggleCallback?.(false)
            }
          }}
          onBlur={(event) => {
            void submitRename(event.currentTarget.value)
          }}
        />
      </div>
    )
  }

  return (
    <>
      {selectedFiles.length === 1 && (isFileAttachedToNote || shouldShowAttachOption) && (
        <MenuSection>
          {isFileAttachedToNote ? (
            <MenuItem onClick={onDetach}>
              <Icon type="link-off" className="mr-2 text-neutral" />
              {t('detachFromNote')}
            </MenuItem>
          ) : shouldShowAttachOption ? (
            <MenuItem onClick={onAttach}>
              <Icon type="link" className="mr-2 text-neutral" />
              {t('attachToNote')}
            </MenuItem>
          ) : null}
        </MenuSection>
      )}
      <MenuSection>
        {application.featuresController.isVaultsEnabled() && (
          <AddToVaultMenuOption
            iconClassName={iconClass}
            items={selectedFiles}
            disabled={!hasAdminPermissionForAllSharedFiles}
          />
        )}
        <AddTagOption
          navigationController={application.navigationController}
          linkingController={application.linkingController}
          selectedItems={selectedFiles}
          iconClassName={`text-neutral mr-2 ${MenuItemIconSize}`}
          disabled={areSomeFilesInReadonlySharedVault}
        />
        {fileToRename && (
          <MoveFileToFolderOption
            navigationController={application.navigationController}
            file={fileToRename}
            iconClassName={`text-neutral mr-2 ${MenuItemIconSize}`}
            disabled={areSomeFilesInReadonlySharedVault}
          />
        )}
        <MenuSwitchButtonItem
          checked={hasProtectedFiles}
          onChange={(hasProtectedFiles) => {
            void application.filesController.setProtectionForFiles(hasProtectedFiles, selectedFiles)
          }}
          disabled={areSomeFilesInReadonlySharedVault}
        >
          <Icon type="lock" className={`mr-2 text-neutral ${MenuItemIconSize}`} />
          {t('passwordProtect')}
        </MenuSwitchButtonItem>
      </MenuSection>
      <MenuSection>
        <MenuItem
          onClick={() => {
            void application.filesController.downloadFiles(selectedFiles)
            closeMenu()
          }}
        >
          <Icon type="download" className={`mr-2 text-neutral ${MenuItemIconSize}`} />
          {canShowZipDownloadOption ? t('downloadSeparately') : t('common:download')}
        </MenuItem>
        {canShowZipDownloadOption && (
          <MenuItem
            onClick={() => {
              application.filesController.downloadFilesAsZip(selectedFiles).catch((error) => {
                if (error instanceof DOMException && error.name === 'AbortError') {
                  return
                }
                console.error(error)
                addToast({
                  type: ToastType.Error,
                  message: error.message || t('failedToDownloadArchive'),
                })
              })
              closeMenu()
            }}
          >
            <Icon type="download" className={`mr-2 text-neutral ${MenuItemIconSize}`} />
            {t('downloadAsArchive')}
          </MenuItem>
        )}
        {shouldShowRenameOption && fileToRename && (
          <MenuItem onClick={beginRename} disabled={areSomeFilesInReadonlySharedVault}>
            <Icon type="pencil" className={`mr-2 text-neutral ${MenuItemIconSize}`} />
            {t('common:rename')}
          </MenuItem>
        )}
        <MenuItem
          onClick={() => {
            closeMenuAndToggleFilesList()
            void application.filesController.deleteFilesPermanently(selectedFiles)
          }}
          disabled={areSomeFilesInReadonlySharedVault}
        >
          <Icon type="trash" className={`mr-2 text-danger ${MenuItemIconSize}`} />
          <span className="text-danger">{t('common:deletePermanently')}</span>
        </MenuItem>
      </MenuSection>

      <FileContextMenuBackupOption file={selectedFiles[0]} />

      <div className="px-3 pb-0.5 pt-1 text-xs font-medium text-neutral">
        {!hasSelectedMultipleFiles && (
          <div className="mb-1">
            <span className="font-semibold">{t('fileId')}</span> {selectedFiles[0].uuid}
          </div>
        )}
        <div>
          <span className="font-semibold">{hasSelectedMultipleFiles ? t('totalSize') : t('size')}</span>{' '}
          {formatSizeToReadableString(totalFileSize)}
        </div>
      </div>
    </>
  )
}

export default observer(FileMenuOptions)
