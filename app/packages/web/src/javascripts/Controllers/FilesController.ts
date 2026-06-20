import {
  FileDownloadProgress,
  fileProgressToHumanReadableString,
  FilesClientInterface,
  OnChunkCallbackNoProgress,
} from '@standardnotes/files'
import { FilePreviewModalController } from './FilePreviewModalController'
import { FileItemAction, FileItemActionType } from '@/Components/AttachedFilesPopover/PopoverFileItemAction'
import { parsePdfDeepLink } from '@/Components/FilePreview/PdfDeepLink'
import { BYTES_IN_ONE_MEGABYTE, LARGE_FILE_THRESHOLD, MAX_LOCAL_FILE_SIZE } from '@/Constants/Constants'
import {
  ArchiveManager,
  confirmDialog,
  IsNativeMobileWeb,
  VaultDisplayServiceInterface,
} from '@standardnotes/ui-services'
import { Strings, StringUtils } from '@/Constants/Strings'
import { concatenateUint8Arrays } from '@/Utils/ConcatenateUint8Arrays'
import { ClassicFileReader, StreamingFileReader, StreamingFileSaver, ClassicFileSaver } from '@standardnotes/filepicker'
import { parseAndCreateZippableFileName, parseFileName } from '@standardnotes/utils'
import {
  AlertService,
  ChallengeReason,
  ClientDisplayableError,
  ContentType,
  FileItem,
  InternalEventBusInterface,
  isFile,
  ItemManagerInterface,
  MobileDeviceInterface,
  MutatorClientInterface,
  Platform,
  ProtectionsClientInterface,
  SNNote,
  SyncServiceInterface,
  UuidGenerator,
  VaultServiceInterface,
} from '@standardnotes/snjs'
import { addToast, dismissToast, ToastType, updateToast } from '@standardnotes/toast'
import { action, makeObservable, observable, reaction } from 'mobx'
import { AbstractViewController } from './Abstract/AbstractViewController'
import { NotesController } from './NotesController/NotesController'
import { downloadOrShareBlobBasedOnPlatform } from '@/Utils/DownloadOrShareBasedOnPlatform'
import { truncateString } from '@/Components/SuperEditor/Utils'
import { RecentActionsState } from '../Application/Recents'

const UnprotectedFileActions = [FileItemActionType.ToggleFileProtection]
const NonMutatingFileActions = [FileItemActionType.DownloadFile, FileItemActionType.PreviewFile]

type FileContextMenuLocation = { x: number; y: number }

export enum FilesControllerEvent {
  FileUploadedToNote = 'FileUploadedToNote',
  FileUploadFinished = 'FileUploadFinished',
  UploadAndInsertFile = 'UploadAndInsertFile',
}

export type FilesControllerEventData = {
  [FilesControllerEvent.FileUploadedToNote]?: {
    uuid: string
  }
  [FilesControllerEvent.FileUploadFinished]?: {
    uploadedFile: FileItem
  }
  [FilesControllerEvent.UploadAndInsertFile]?: {
    fileOrHandle: File | FileSystemFileHandle
  }
}

export class FilesController extends AbstractViewController<FilesControllerEvent, FilesControllerEventData> {
  allFiles: FileItem[] = []
  attachedFiles: FileItem[] = []
  showFileContextMenu = false
  showProtectedOverlay = false
  fileContextMenuLocation: FileContextMenuLocation = { x: 0, y: 0 }

  shouldUseStreamingAPI = StreamingFileSaver.available()
  reader = this.shouldUseStreamingAPI ? StreamingFileReader : ClassicFileReader
  maxFileSize = this.reader.maximumFileSize()

  uploadProgressMap: Map<
    string,
    {
      file: File
      progress: number
    }
  > = new Map()

  override deinit(): void {
    super.deinit()
    ;(this.notesController as unknown) = undefined
    ;(this.filePreviewModalController as unknown) = undefined
  }

  constructor(
    private notesController: NotesController,
    private filePreviewModalController: FilePreviewModalController,
    private archiveService: ArchiveManager,
    private vaultDisplayService: VaultDisplayServiceInterface,
    private vaults: VaultServiceInterface,
    private items: ItemManagerInterface,
    private files: FilesClientInterface,
    private mutator: MutatorClientInterface,
    private sync: SyncServiceInterface,
    private protections: ProtectionsClientInterface,
    private alerts: AlertService,
    private platform: Platform,
    private mobileDevice: MobileDeviceInterface | undefined,
    private _isNativeMobileWeb: IsNativeMobileWeb,
    private recents: RecentActionsState,
    eventBus: InternalEventBusInterface,
  ) {
    super(eventBus)

    makeObservable(this, {
      allFiles: observable,
      attachedFiles: observable,
      showFileContextMenu: observable,
      fileContextMenuLocation: observable,

      showProtectedOverlay: observable,

      reloadAllFiles: action,
      reloadAttachedFiles: action,
      setShowFileContextMenu: action,
      setShowProtectedOverlay: action,
      setFileContextMenuLocation: action,

      uploadProgressMap: observable,
    })

    this.disposers.push(
      items.streamItems(ContentType.TYPES.File, () => {
        this.reloadAllFiles()
        this.reloadAttachedFiles()
      }),
    )

    this.disposers.push(
      reaction(
        () => notesController.selectedNotes,
        () => {
          this.reloadAttachedFiles()
        },
      ),
    )
  }

  setShowFileContextMenu = (enabled: boolean) => {
    this.showFileContextMenu = enabled
  }

  setShowProtectedOverlay = (enabled: boolean) => {
    this.showProtectedOverlay = enabled
  }

  setFileContextMenuLocation = (location: FileContextMenuLocation) => {
    this.fileContextMenuLocation = location
  }

  reloadAllFiles = () => {
    this.allFiles = this.items.getDisplayableFiles()
  }

  reloadAttachedFiles = () => {
    const note = this.notesController.firstSelectedNote
    if (note) {
      this.attachedFiles = this.items.itemsReferencingItem(note).filter(isFile)
    }
  }

  deleteFile = async (file: FileItem) => {
    const shouldDelete = await confirmDialog({
      text: StringUtils.deleteFile(file.name),
      confirmButtonStyle: 'danger',
    })
    if (shouldDelete) {
      const deletingToastId = addToast({
        type: ToastType.Loading,
        message: `Deleting file "${file.name}"...`,
      })
      await this.files.deleteFile(file)
      addToast({
        type: ToastType.Success,
        message: `Deleted file "${file.name}"`,
      })
      dismissToast(deletingToastId)
    }
  }

  attachFileToSelectedNote = async (file: FileItem) => {
    const note = this.notesController.firstSelectedNote
    if (!note) {
      addToast({
        type: ToastType.Error,
        message: 'Could not attach file because selected note was deleted',
      })
      return
    }

    await this.mutator.associateFileWithNote(file, note)
    void this.sync.sync()
  }

  detachFileFromNote = async (file: FileItem) => {
    const note = this.notesController.firstSelectedNote
    if (!note) {
      addToast({
        type: ToastType.Error,
        message: 'Could not attach file because selected note was deleted',
      })
      return
    }
    await this.mutator.disassociateFileWithNote(file, note)
    void this.sync.sync()
  }

  toggleFileProtection = async (file: FileItem) => {
    let result: FileItem | undefined
    if (file.protected) {
      result = await this.protections.unprotectFile(file)
    } else {
      result = await this.protections.protectFile(file)
    }
    void this.sync.sync()
    const isProtected = result ? result.protected : file.protected
    return isProtected
  }

  authorizeProtectedActionForFile = async (file: FileItem, challengeReason: ChallengeReason) => {
    const authorizedFiles = await this.protections.authorizeProtectedActionForItems([file], challengeReason)
    const isAuthorized = authorizedFiles.length > 0 && authorizedFiles.includes(file)
    return isAuthorized
  }

  renameFile = async (file: FileItem, fileName: string) => {
    await this.mutator.renameFile(file, fileName)
    void this.sync.sync()
  }

  /**
   * Open a PDF (or any) file from an `sn-file://<uuid>#page=N[&quote=...]` deep
   * link, jumping the viewer to the encoded page/quote. This is the entry point
   * a note's link system can call when a deep link is clicked.
   */
  openFileDeepLink = async (link: string): Promise<boolean> => {
    const parsed = parsePdfDeepLink(link)
    if (!parsed) {
      return false
    }

    const file = this.items.findItem(parsed.fileUuid)
    if (!file || !isFile(file)) {
      return false
    }

    if (file.protected) {
      const authorized = await this.authorizeProtectedActionForFile(file, ChallengeReason.AccessProtectedFile)
      if (!authorized) {
        return false
      }
    }

    this.filePreviewModalController.activate(file, undefined, { page: parsed.page, quote: parsed.quote })
    this.recents.add(file.uuid)
    return true
  }

  handleFileAction = async (
    action: FileItemAction,
  ): Promise<{
    didHandleAction: boolean
  }> => {
    const file = action.payload.file
    let isAuthorizedForAction = true

    const requiresAuthorization = file.protected && !UnprotectedFileActions.includes(action.type)

    if (requiresAuthorization) {
      isAuthorizedForAction = await this.authorizeProtectedActionForFile(file, ChallengeReason.AccessProtectedFile)
    }

    if (!isAuthorizedForAction) {
      return {
        didHandleAction: false,
      }
    }

    switch (action.type) {
      case FileItemActionType.AttachFileToNote:
        await this.attachFileToSelectedNote(file)
        break
      case FileItemActionType.DetachFileToNote:
        await this.detachFileFromNote(file)
        break
      case FileItemActionType.DeleteFile:
        await this.deleteFile(file)
        break
      case FileItemActionType.DownloadFile:
        await this.downloadFile(file, action.payload.directoryHandle)
        break
      case FileItemActionType.ToggleFileProtection: {
        const isProtected = await this.toggleFileProtection(file)
        action.callback(isProtected)
        break
      }
      case FileItemActionType.RenameFile:
        await this.renameFile(file, action.payload.name)
        break
      case FileItemActionType.PreviewFile:
        this.filePreviewModalController.activate(file, action.payload.otherFiles)
        this.recents.add(file.uuid)
        break
    }

    if (!NonMutatingFileActions.includes(action.type)) {
      this.sync.sync().catch(console.error)
    }

    return {
      didHandleAction: true,
    }
  }

  getFileBlob = async (file: FileItem): Promise<Blob | undefined> => {
    const chunks: Uint8Array[] = []
    const error = await this.files.downloadFile(file, async (decryptedChunk) => {
      chunks.push(decryptedChunk)
    })
    if (error) {
      return
    }
    const finalDecryptedBytes = concatenateUint8Arrays(chunks)
    return new Blob([finalDecryptedBytes], {
      type: file.mimeType,
    })
  }

  private async downloadFile(file: FileItem, directoryHandle?: FileSystemDirectoryHandle): Promise<void> {
    let downloadingToastId = ''
    let canShowProgressNotification = false

    if (this.mobileDevice && this.platform === Platform.Android) {
      canShowProgressNotification = await this.mobileDevice.canDisplayNotifications()
    }

    try {
      let saver = this.shouldUseStreamingAPI ? new StreamingFileSaver(file.name) : new ClassicFileSaver()
      let didSelectFileToStreamTo = false

      if (isUsingStreamingSaver(saver)) {
        const fileHandle = directoryHandle
          ? await directoryHandle.getFileHandle(file.name, { create: true })
          : undefined
        didSelectFileToStreamTo = await saver.selectFileToSaveTo(fileHandle)
      }

      if (isUsingStreamingSaver(saver) && !didSelectFileToStreamTo) {
        saver = new ClassicFileSaver()
      }

      if (this.mobileDevice && canShowProgressNotification) {
        downloadingToastId = await this.mobileDevice.displayNotification({
          title: `Downloading file "${file.name}"`,
          android: {
            progress: { max: 100, current: 0, indeterminate: true },
            onlyAlertOnce: true,
          },
        })
      } else {
        downloadingToastId = addToast({
          type: ToastType.Progress,
          message: `Downloading file "${file.name}" (0%)`,
          progress: 0,
        })
      }

      const decryptedBytesArray: Uint8Array[] = []

      let lastProgress: FileDownloadProgress | undefined

      const result = await this.files.downloadFile(file, async (decryptedBytes, progress) => {
        if (isUsingStreamingSaver(saver)) {
          await saver.pushBytes(decryptedBytes)
        } else {
          decryptedBytesArray.push(decryptedBytes)
        }

        const progressPercent = Math.floor(progress.percentComplete)

        if (this.mobileDevice && canShowProgressNotification) {
          this.mobileDevice
            .displayNotification({
              id: downloadingToastId,
              title: `Downloading file "${file.name}"`,
              android: {
                progress: { max: 100, current: progressPercent, indeterminate: false },
                onlyAlertOnce: true,
              },
            })
            .catch(console.error)
        } else {
          updateToast(downloadingToastId, {
            message: fileProgressToHumanReadableString(progress, file.name, { showPercent: true }),
            progress: progressPercent,
          })
        }

        lastProgress = progress
      })

      if (result instanceof ClientDisplayableError) {
        throw new Error(result.text)
      }

      if (isUsingStreamingSaver(saver)) {
        await saver.finish()
      } else {
        const finalBytes = concatenateUint8Arrays(decryptedBytesArray)
        const blob = new Blob([finalBytes], {
          type: file.mimeType,
        })
        await downloadOrShareBlobBasedOnPlatform({
          archiveService: this.archiveService,
          platform: this.platform,
          mobileDevice: this.mobileDevice,
          blob,
          filename: file.name,
          isNativeMobileWeb: this._isNativeMobileWeb.execute().getValue(),
          showToastOnAndroid: false,
        })
      }

      if (this.mobileDevice && canShowProgressNotification) {
        await this.mobileDevice.displayNotification({
          title: `Successfully downloaded file "${file.name}"`,
        })
      } else {
        addToast({
          type: ToastType.Success,
          message: `Successfully downloaded file${
            lastProgress && lastProgress.source === 'local' ? ' from local backup' : ''
          }`,
        })
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return
      }

      console.error(error)

      addToast({
        type: ToastType.Error,
        message: 'There was an error while downloading the file',
      })
    }

    if (downloadingToastId) {
      if (this.mobileDevice && canShowProgressNotification) {
        this.mobileDevice.cancelNotification(downloadingToastId).catch(console.error)
      } else {
        dismissToast(downloadingToastId)
      }
    }
  }

  alertIfFileExceedsSizeLimit = (file: File): boolean => {
    if (!this.shouldUseStreamingAPI && this.maxFileSize && file.size >= this.maxFileSize) {
      this.alerts
        .alert(
          `This file exceeds the limits supported in this browser. To upload files greater than ${
            this.maxFileSize / BYTES_IN_ONE_MEGABYTE
          }MB, please use the desktop application or the Chrome browser.`,
          StringUtils.cannotUploadFile(file.name),
        )
        .catch(console.error)
      return true
    }
    return false
  }

  /**
   * Rejects files above the absolute max (500 MB). Large local-only files are persisted
   * encrypted in IndexedDB and held in memory while encrypting, so we hard-cap the size to
   * avoid quota errors and tab crashes.
   */
  private alertIfFileExceedsLocalMax = (file: File): boolean => {
    if (file.size > MAX_LOCAL_FILE_SIZE) {
      addToast({
        type: ToastType.Error,
        message: `File too large — "${file.name}" is ${Math.round(
          file.size / BYTES_IN_ONE_MEGABYTE,
        )}MB. The maximum is ${MAX_LOCAL_FILE_SIZE / BYTES_IN_ONE_MEGABYTE}MB.`,
      })
      return true
    }
    return false
  }

  /**
   * Asks the user to confirm keeping a large file on this device only (not synced). Returns
   * true if the user confirms.
   */
  private async confirmLargeLocalOnlyFile(file: File): Promise<boolean> {
    return confirmDialog({
      title: 'Keep large file on this device only?',
      text:
        `"${file.name}" is ${Math.round(file.size / BYTES_IN_ONE_MEGABYTE)}MB, which is over the ` +
        `${LARGE_FILE_THRESHOLD / BYTES_IN_ONE_MEGABYTE}MB large-file limit. It will be kept on this ` +
        'device only — it will NOT sync to the server, appear on your other devices, or be backed up. ' +
        'If you clear this app’s data or switch devices, the file will be lost.',
      confirmButtonText: 'Keep on this device',
      confirmButtonStyle: 'info',
    })
  }

  /**
   * Encrypts the file locally and stores it in local (IndexedDB) storage, then creates a
   * `localOnly`-flagged file item (excluded from sync). Mirrors the chunked read loop used for
   * server uploads but pushes encrypted bytes into local storage instead of the network.
   */
  private async uploadLocalOnlyFile(
    fileToUpload: File,
    uuid: string,
    options: {
      showToast: boolean
      onUploadStart?: (fileUuid: string) => void
      onUploadFinish?: () => void
    },
  ): Promise<FileItem | undefined> {
    const { showToast, onUploadStart, onUploadFinish } = options
    const minimumChunkSize = this.files.minimumChunkSize()

    let toastId: string | undefined
    if (showToast) {
      toastId = addToast({
        type: ToastType.Progress,
        message: `Saving file "${fileToUpload.name}" to this device (0%)`,
        progress: 0,
      })
    }

    if (onUploadStart) {
      onUploadStart(uuid)
    }

    this.uploadProgressMap.set(uuid, { file: fileToUpload, progress: 0 })

    const operation = this.files.beginNewLocalOnlyFileUpload(fileToUpload.size)

    const onChunk: OnChunkCallbackNoProgress = async ({ data, isLast }) => {
      this.files.pushBytesForLocalOnlyUpload(operation, data, isLast)

      const percentComplete = Math.round((operation.decryptedSize / Math.max(fileToUpload.size, 1)) * 100)
      this.uploadProgressMap.set(uuid, { file: fileToUpload, progress: percentComplete })
      if (toastId) {
        updateToast(toastId, {
          message: `Saving file "${fileToUpload.name}" to this device (${percentComplete}%)`,
          progress: percentComplete,
        })
      }
    }

    const fileResult = await this.reader.readFile(fileToUpload, minimumChunkSize, onChunk)

    if (!fileResult.mimeType) {
      const { ext } = parseFileName(fileToUpload.name)
      fileResult.mimeType = await this.archiveService.getMimeType(ext)
    }

    const savedFile = await this.files.finishLocalOnlyUpload(operation, fileResult, uuid)

    if (toastId) {
      dismissToast(toastId)
    }

    if (savedFile instanceof ClientDisplayableError) {
      addToast({ type: ToastType.Error, message: savedFile.text })
      return undefined
    }

    if (onUploadFinish) {
      onUploadFinish()
    }

    this.notifyEvent(FilesControllerEvent.FileUploadFinished, {
      [FilesControllerEvent.FileUploadFinished]: { uploadedFile: savedFile },
    })

    if (showToast) {
      addToast({
        type: ToastType.Success,
        message: `Saved file "${savedFile.name}" to this device only (not synced)`,
        autoClose: true,
      })
    }

    return savedFile
  }

  public async selectAndUploadNewFiles(note?: SNNote, callback?: (file: FileItem) => void) {
    const selectedFiles = await this.reader.selectFiles()

    await this.uploadFiles(
      selectedFiles.map((file) => ({ file, path: file.name })),
      {
        note,
        onFileUploaded: callback ? (file) => callback(file) : undefined,
      },
    )
  }

  /**
   * Upload a batch of files (optionally carrying a relative `path` for folder
   * recreation) with overall "n of m" progress and per-file error isolation.
   *
   * Uploads run with bounded concurrency rather than one-at-a-time prompts. Each
   * file is routed through {@link uploadNewFile} with `showToast: false`, so the
   * existing per-file size, large-file/local-only confirmation and local-max
   * logic is fully preserved — we never bypass it. A single failed file does not
   * abort the batch; failures are counted and surfaced in the final toast.
   */
  public async uploadFiles(
    files: { file: File | FileSystemFileHandle; path?: string }[],
    options: {
      note?: SNNote
      concurrency?: number
      /** Called after each successful upload with the resulting item and its source relative path. */
      onFileUploaded?: (file: FileItem, path?: string) => void | Promise<void>
    } = {},
  ): Promise<{ uploaded: FileItem[]; failed: number }> {
    const { note, onFileUploaded } = options
    const concurrency = Math.max(1, options.concurrency ?? 3)

    const total = files.length
    if (total === 0) {
      return { uploaded: [], failed: 0 }
    }

    if (total === 1) {
      // Single file: defer to the rich single-file toast/flow.
      const uploaded = await this.uploadNewFile(files[0].file, { note })
      if (uploaded) {
        await onFileUploaded?.(uploaded, files[0].path)
        return { uploaded: [uploaded], failed: 0 }
      }
      return { uploaded: [], failed: 1 }
    }

    let completed = 0
    let failed = 0
    const uploaded: FileItem[] = []

    const batchToastId = addToast({
      type: ToastType.Progress,
      message: `Uploading ${total} files (0 of ${total})`,
      progress: 0,
    })

    const updateBatchToast = () => {
      const done = completed + failed
      updateToast(batchToastId, {
        message: `Uploading ${total} files (${done} of ${total})`,
        progress: Math.round((done / total) * 100),
      })
    }

    const queue = [...files]

    const worker = async () => {
      for (;;) {
        const next = queue.shift()
        if (!next) {
          return
        }
        try {
          const result = await this.uploadNewFile(next.file, { note, showToast: false })
          if (result) {
            completed += 1
            uploaded.push(result)
            await onFileUploaded?.(result, next.path)
          } else {
            // uploadNewFile returns undefined when the user declines a large
            // local-only file or the file is rejected by size limits — count it
            // as a (non-fatal) skip/failure so the batch keeps going.
            failed += 1
          }
        } catch (error) {
          console.error(error)
          failed += 1
        }
        updateBatchToast()
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()))

    dismissToast(batchToastId)

    if (failed === 0) {
      addToast({
        type: ToastType.Success,
        message: `Uploaded ${completed} files`,
        autoClose: true,
      })
    } else {
      addToast({
        type: completed > 0 ? ToastType.Success : ToastType.Error,
        message: `Uploaded ${completed} of ${total} files${failed > 0 ? ` (${failed} skipped or failed)` : ''}`,
        autoClose: true,
      })
    }

    return { uploaded, failed }
  }

  public async uploadNewFile(
    fileOrHandle: File | FileSystemFileHandle,
    options: {
      showToast?: boolean
      note?: SNNote
      onUploadStart?: (fileUuid: string) => void
      onUploadFinish?: () => void
    } = {},
  ): Promise<FileItem | undefined> {
    const { showToast = true, note, onUploadStart, onUploadFinish } = options

    let toastId: string | undefined
    let canShowProgressNotification = false

    if (showToast && this.mobileDevice && this.platform === Platform.Android) {
      canShowProgressNotification = await this.mobileDevice.canDisplayNotifications()
    }

    try {
      const minimumChunkSize = this.files.minimumChunkSize()

      const fileToUpload =
        fileOrHandle instanceof File
          ? fileOrHandle
          : fileOrHandle instanceof FileSystemFileHandle && this.shouldUseStreamingAPI
            ? await fileOrHandle.getFile()
            : undefined

      if (!fileToUpload) {
        return
      }

      if (this.alertIfFileExceedsSizeLimit(fileToUpload)) {
        return
      }

      // Reject anything above the absolute local maximum (500 MB).
      if (this.alertIfFileExceedsLocalMax(fileToUpload)) {
        return
      }

      const uuid = UuidGenerator.GenerateUuid()

      // Large files (> 100 MB) are kept on this device only and never uploaded/synced.
      if (fileToUpload.size > LARGE_FILE_THRESHOLD) {
        const confirmed = await this.confirmLargeLocalOnlyFile(fileToUpload)
        if (!confirmed) {
          return undefined
        }
        return await this.uploadLocalOnlyFile(fileToUpload, uuid, { showToast, onUploadStart, onUploadFinish })
      }

      this.uploadProgressMap.set(uuid, {
        file: fileToUpload,
        progress: 0,
      })

      if (onUploadStart) {
        onUploadStart(uuid)
      }

      const vaultForNote = note ? this.vaults.getItemVault(note) : undefined

      const operation = await this.files.beginNewFileUpload(
        fileToUpload.size,
        vaultForNote || this.vaultDisplayService.exclusivelyShownVault,
      )

      if (operation instanceof ClientDisplayableError) {
        addToast({
          type: ToastType.Error,
          message: operation.text,
        })
        return undefined
      }

      const initialProgress = operation.getProgress().percentComplete

      this.uploadProgressMap.set(uuid, {
        file: fileToUpload,
        progress: initialProgress,
      })

      if (showToast) {
        if (this.mobileDevice && canShowProgressNotification) {
          toastId = await this.mobileDevice.displayNotification({
            title: `Uploading file "${fileToUpload.name}"`,
            android: {
              progress: { max: 100, current: initialProgress, indeterminate: true },
              onlyAlertOnce: true,
            },
          })
        } else {
          toastId = addToast({
            type: ToastType.Progress,
            message: `Uploading file "${fileToUpload.name}" (${initialProgress}%)`,
            progress: initialProgress,
          })
        }
      }

      const onChunk: OnChunkCallbackNoProgress = async ({ data, index, isLast }) => {
        await this.files.pushBytesForUpload(operation, data, index, isLast)

        const percentComplete = Math.round(operation.getProgress().percentComplete)
        this.uploadProgressMap.set(uuid, {
          file: fileToUpload,
          progress: percentComplete,
        })
        if (toastId) {
          if (this.mobileDevice && canShowProgressNotification) {
            await this.mobileDevice.displayNotification({
              id: toastId,
              title: `Uploading file "${fileToUpload.name}"`,
              android: {
                progress: { max: 100, current: percentComplete, indeterminate: false },
                onlyAlertOnce: true,
              },
            })
          } else {
            updateToast(toastId, {
              message: `Uploading file "${fileToUpload.name}" (${percentComplete}%)`,
              progress: percentComplete,
            })
          }
        }
      }

      const fileResult = await this.reader.readFile(fileToUpload, minimumChunkSize, onChunk)

      if (!fileResult.mimeType) {
        const { ext } = parseFileName(fileToUpload.name)
        fileResult.mimeType = await this.archiveService.getMimeType(ext)
      }

      const uploadedFile = await this.files.finishUpload(operation, fileResult, uuid)

      if (uploadedFile instanceof ClientDisplayableError) {
        addToast({
          type: ToastType.Error,
          message: uploadedFile.text,
        })
        return undefined
      }

      if (onUploadFinish) {
        onUploadFinish()
      }

      this.notifyEvent(FilesControllerEvent.FileUploadFinished, {
        [FilesControllerEvent.FileUploadFinished]: { uploadedFile },
      })

      if (toastId) {
        if (this.mobileDevice && canShowProgressNotification) {
          this.mobileDevice.cancelNotification(toastId).catch(console.error)
        }
        dismissToast(toastId)
      }
      if (showToast) {
        if (this.mobileDevice && canShowProgressNotification) {
          this.mobileDevice
            .displayNotification({
              id: uploadedFile.uuid,
              title: `Uploaded file "${uploadedFile.name}"`,
              android: {
                actions: [
                  {
                    title: 'Open',
                    pressAction: {
                      id: 'open-file',
                    },
                  },
                ],
              },
            })
            .catch(console.error)
        } else {
          addToast({
            type: ToastType.Success,
            message: `Uploaded file "${uploadedFile.name}"`,
            actions: [
              {
                label: 'Open',
                handler: (toastId: string) => {
                  void this.handleFileAction({
                    type: FileItemActionType.PreviewFile,
                    payload: { file: uploadedFile },
                  })
                  dismissToast(toastId)
                },
              },
            ],
            autoClose: true,
          })
        }
      }

      return uploadedFile
    } catch (error) {
      console.error(error)

      if (toastId) {
        if (this.mobileDevice && canShowProgressNotification) {
          this.mobileDevice.cancelNotification(toastId).catch(console.error)
        }
        dismissToast(toastId)
      }
      if (this.mobileDevice && canShowProgressNotification) {
        this.mobileDevice
          .displayNotification({
            title: 'There was an error while uploading the file',
          })
          .catch(console.error)
      } else {
        addToast({
          type: ToastType.Error,
          message: 'There was an error while uploading the file',
        })
      }
    }

    return undefined
  }

  notifyObserversOfUploadedFileLinkingToCurrentNote(fileUuid: string) {
    this.notifyEvent(FilesControllerEvent.FileUploadedToNote, {
      [FilesControllerEvent.FileUploadedToNote]: { uuid: fileUuid },
    })
  }

  uploadAndInsertFileToCurrentNote(fileOrHandle: File | FileSystemFileHandle) {
    this.notifyEvent(FilesControllerEvent.UploadAndInsertFile, {
      [FilesControllerEvent.UploadAndInsertFile]: { fileOrHandle },
    })
  }

  deleteFilesPermanently = async (files: FileItem[]) => {
    const title = Strings.deleteItemsPermanentlyTitle
    const text = files.length === 1 ? StringUtils.deleteFile(files[0].name) : Strings.deleteMultipleFiles

    if (
      await confirmDialog({
        title,
        text,
        confirmButtonStyle: 'danger',
      })
    ) {
      await Promise.all(files.map((file) => this.files.deleteFile(file)))
      void this.sync.sync()
    }
  }

  setProtectionForFiles = async (protect: boolean, files: FileItem[]) => {
    if (protect) {
      const protectedItems = await this.protections.protectItems(files)
      if (protectedItems) {
        this.setShowProtectedOverlay(true)
      }
    } else {
      const unprotectedItems = await this.protections.unprotectItems(files, ChallengeReason.UnprotectFile)
      if (unprotectedItems) {
        this.setShowProtectedOverlay(false)
      }
    }
    void this.sync.sync()
  }

  getDirectoryHandleForDownloads = async () => {
    if (!this.shouldUseStreamingAPI) {
      return
    }

    const directoryHandle = await window.showDirectoryPicker!({
      startIn: 'downloads',
    })

    return directoryHandle
  }

  downloadFiles = async (files: FileItem[]) => {
    // macOS doesn't allow multiple calls to the filepicker at the
    // same time, so we need to iterate one by one
    if (this.platform === Platform.MacDesktop || this.platform === Platform.MacWeb) {
      let directoryHandle: FileSystemDirectoryHandle | undefined

      if (files.length > 1) {
        try {
          directoryHandle = await this.getDirectoryHandleForDownloads()
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') {
            return
          }
          console.error(error)
        }
      }

      for (const file of files) {
        await this.handleFileAction({
          type: FileItemActionType.DownloadFile,
          payload: {
            file,
            directoryHandle,
          },
        })
      }
      return
    }

    await Promise.all(
      files.map((file) =>
        this.handleFileAction({
          type: FileItemActionType.DownloadFile,
          payload: {
            file,
          },
        }),
      ),
    )
  }

  downloadFilesAsZip = async (files: FileItem[]) => {
    if (!this.shouldUseStreamingAPI) {
      throw new Error('Device does not support streaming API')
    }

    const protectedFiles = files.filter((file) => file.protected)

    if (protectedFiles.length > 0) {
      const authorized = await this.protections.authorizeProtectedActionForItems(
        protectedFiles,
        ChallengeReason.AccessProtectedFile,
      )
      if (authorized.length === 0) {
        throw new Error('Authorization is required to download protected files')
      }
    }

    const zipFileHandle = await window.showSaveFilePicker!({
      types: [
        {
          description: 'ZIP file',
          accept: { 'application/zip': ['.zip'] },
        },
      ],
    })

    const toast = addToast({
      type: ToastType.Progress,
      title: `Downloading ${files.length} files as archive`,
      message: 'Preparing archive...',
    })

    try {
      const zip = await import('@zip.js/zip.js')

      const zipStream = await zipFileHandle.createWritable()

      const zipWriter = new zip.ZipWriter(zipStream, {
        level: 0,
      })

      const addedFilenames: string[] = []

      for (const file of files) {
        const fileStream = new TransformStream()

        let name = parseAndCreateZippableFileName(file.name)

        if (addedFilenames.includes(name)) {
          name = `${Date.now()} ${name}`
        }

        zipWriter.add(name, fileStream.readable).catch(console.error)

        addedFilenames.push(name)

        const writer = fileStream.writable.getWriter()

        await this.files
          .downloadFile(file, async (bytesChunk, progress) => {
            await writer.write(bytesChunk)
            updateToast(toast, {
              message: `Downloading "${truncateString(file.name, 25)}"`,
              progress: Math.floor(progress.percentComplete),
            })
          })
          .catch(console.error)

        await writer.close()
      }

      await zipWriter.close()
    } finally {
      dismissToast(toast)
    }

    addToast({
      type: ToastType.Success,
      message: `Successfully downloaded ${files.length} files as archive`,
    })
  }
}

function isUsingStreamingSaver(saver: StreamingFileSaver | ClassicFileSaver): saver is StreamingFileSaver {
  return saver instanceof StreamingFileSaver
}
