import {
  ContentType,
  FileItem,
  ItemManagerInterface,
  VaultListingInterface,
  VaultLockServiceEvent,
  VaultLockServiceEventPayload,
  VaultLockServiceInterface,
  VaultServiceInterface,
} from '@standardnotes/snjs'
import { action, makeObservable, observable } from 'mobx'
import { PdfDeepLinkTarget } from '@/Components/FilePreview/PdfDeepLink'

export class FilePreviewModalController {
  isOpen = false
  currentFile: FileItem | undefined = undefined
  otherFiles: FileItem[] = []
  /** Optional deep-link location (page/quote) to open a PDF at. */
  pdfTarget: PdfDeepLinkTarget | undefined = undefined

  eventObservers: (() => void)[] = []

  constructor(items: ItemManagerInterface, vaultLocks: VaultLockServiceInterface, vaults: VaultServiceInterface) {
    makeObservable(this, {
      isOpen: observable,
      currentFile: observable,
      otherFiles: observable,
      pdfTarget: observable.ref,

      activate: action,
      dismiss: action,
      setCurrentFile: action,
    })

    this.eventObservers.push(
      items.streamItems(ContentType.TYPES.File, ({ changed, removed }) => {
        if (!this.currentFile) {
          return
        }
        const currentFile = this.currentFile
        const changedCurrentFile = changed.find((file) => file.uuid === currentFile.uuid) as FileItem | undefined
        if (changedCurrentFile) {
          this.setCurrentFile(changedCurrentFile)
        }

        const removedUuids = new Set(removed.map((file) => file.uuid))
        const currentFileWasRemoved = removedUuids.has(currentFile.uuid)
        const currentFileIndex = this.otherFiles.findIndex((file) => file.uuid === currentFile.uuid)
        const remainingFiles = this.otherFiles.filter((file) => !removedUuids.has(file.uuid))
        this.otherFiles = remainingFiles

        if (currentFileWasRemoved) {
          if (!remainingFiles.length) {
            this.dismiss()
            return
          }

          const nextFileIndex = Math.min(Math.max(currentFileIndex, 0), remainingFiles.length - 1)
          this.setCurrentFile(remainingFiles[nextFileIndex])
        }
      }),
    )

    this.eventObservers.push(
      vaultLocks.addEventObserver((event, data) => {
        if (event !== VaultLockServiceEvent.VaultLocked) {
          return
        }
        const { vault } = data as VaultLockServiceEventPayload[VaultLockServiceEvent.VaultLocked]
        if (this.currentFile?.key_system_identifier === vault.systemIdentifier) {
          this.dismiss()
          return
        }
        this.otherFiles = this.otherFiles.filter((file) => file.key_system_identifier !== vault.systemIdentifier)
      }),
    )

    this.eventObservers.push(
      items.streamItems<VaultListingInterface>(ContentType.TYPES.VaultListing, ({ removed }) => {
        if (removed.length === 0) {
          return
        }

        if (
          this.currentFile?.key_system_identifier !== undefined &&
          vaults.getItemVault(this.currentFile) === undefined
        ) {
          this.dismiss()
          return
        }

        this.otherFiles = this.otherFiles.filter((file) => {
          return file.key_system_identifier === undefined || vaults.getItemVault(file) !== undefined
        })
      }),
    )
  }

  deinit = () => {
    this.eventObservers.forEach((observer) => observer())
    this.eventObservers.length = 0
    this.dismiss()
  }

  setCurrentFile = (currentFile: FileItem) => {
    this.currentFile = currentFile
  }

  activate = (currentFile: FileItem, otherFiles?: FileItem[], pdfTarget?: PdfDeepLinkTarget) => {
    this.currentFile = currentFile
    this.otherFiles = otherFiles ?? []
    this.pdfTarget = pdfTarget
    this.isOpen = true
  }

  dismiss = () => {
    this.isOpen = false
    this.currentFile = undefined
    this.otherFiles = []
    this.pdfTarget = undefined
  }
}
