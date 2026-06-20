import { ContentType, FileItem, ItemManagerInterface } from '@standardnotes/snjs'
import { action, makeObservable, observable } from 'mobx'
import { PdfDeepLinkTarget } from '@/Components/FilePreview/PdfDeepLink'

export class FilePreviewModalController {
  isOpen = false
  currentFile: FileItem | undefined = undefined
  otherFiles: FileItem[] = []
  /** Optional deep-link location (page/quote) to open a PDF at. */
  pdfTarget: PdfDeepLinkTarget | undefined = undefined

  eventObservers: (() => void)[] = []

  constructor(items: ItemManagerInterface) {
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
        const changedCurrentFile = changed.find((f) => f.uuid === this.currentFile?.uuid) as FileItem | undefined
        if (changedCurrentFile) {
          this.setCurrentFile(changedCurrentFile)
        }
        if (removed.find((f) => f.uuid === this.currentFile?.uuid)) {
          if (!this.otherFiles.length) {
            this.dismiss()
            this.currentFile = undefined
            return
          }

          const currentFileIndex = this.otherFiles.findIndex((file) => file.uuid === this.currentFile?.uuid)
          const nextFileIndex = currentFileIndex + 1 < this.otherFiles.length ? currentFileIndex + 1 : 0
          this.setCurrentFile(this.otherFiles[nextFileIndex])
          this.otherFiles = this.otherFiles.filter((file) => file.uuid !== this.currentFile?.uuid)
        }
      }),
    )
  }

  deinit = () => {
    this.eventObservers.forEach((observer) => observer())
    ;(this.currentFile as unknown) = undefined
    ;(this.otherFiles as unknown) = undefined
  }

  setCurrentFile = (currentFile: FileItem) => {
    this.currentFile = currentFile
  }

  activate = (currentFile: FileItem, otherFiles?: FileItem[], pdfTarget?: PdfDeepLinkTarget) => {
    this.currentFile = currentFile
    if (otherFiles) {
      this.otherFiles = otherFiles
    }
    this.pdfTarget = pdfTarget
    this.isOpen = true
  }

  dismiss = () => {
    this.isOpen = false
    this.pdfTarget = undefined
  }
}
