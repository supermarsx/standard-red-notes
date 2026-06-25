/**
 * English strings for the files surface (files view, attachments, upload/
 * download, file context menus). Source of truth: other locales fall back to
 * these until translated.
 */
const files = {
  // FileViewWithoutProtection
  dropToUploadTooltip: 'Drop your files to upload and link them to the current file',
  fileAriaLabel: 'File',
  fileReadonly: 'This file is readonly',
  fileInformationPanel: 'File information panel',
  details: 'Details',

  // MultipleSelectedFiles
  selectedFilesCount: '{{count}} selected files',
  actionsPerformedOnSelected: 'Actions will be performed on all selected files.',
  cancelMultipleSelection: 'Cancel multiple selection',

  // FileContextMenu / FileOptionsPanel
  fileOptions: 'File options',
  fileContextMenu: 'File context menu',
  fileOptionsMenu: 'File options menu',
  fileOptionsPanel: 'File options panel',

  // FileMenuOptions
  noFilesSelected: 'No files selected',
  detachFromNote: 'Detach from note',
  attachToNote: 'Attach to note',
  passwordProtect: 'Password protect',
  downloadSeparately: 'Download separately',
  downloadAsArchive: 'Download as archive',
  failedToDownloadArchive: 'Failed to download files as archive',
  fileId: 'File ID:',
  size: 'Size:',
  totalSize: 'Total Size:',

  // FileContextMenuBackupOption
  backedUpOn: 'Backed up on {{date}}',
  configureFileBackups: 'Configure file backups',
  fileNotBackedUpLocally: 'File not backed up locally',

  // MoveFileToFolderOption
  noFoldersYet: 'No folders yet',
  moveToFolder: 'Move to folder',
  folderSelectionMenu: 'Folder selection menu',
  noFolder: 'No folder',

  // FilePreview
  fileProtected: 'This file is protected.',
  authenticateToView: 'Authenticate to view this file.',
  addPasscodeToView: 'Add a passcode or create an account to require authentication to view this file.',
  openAccountMenu: 'Open account menu',
  authenticate: 'Authenticate',
  viewFile: 'View file',
  loading: 'Loading...',

  // FilePreviewError
  fileCannotBePreviewed: "This file can't be previewed.",
  errorLoadingFile: 'There was an error loading the file. Try again, or download the file and open it using another application.',
  tryAgain: 'Try again',
  downloadToView: 'To view this file, download it and open it using another application.',

  // FilePreviewInfoPanel
  fileInformation: 'File information',
  type: 'Type:',
  decryptedSize: 'Decrypted Size:',
  encryptedSize: 'Encrypted Size:',
  created: 'Created:',
  lastModified: 'Last Modified:',

  // FilePreviewModal
  done: 'Done',
  showFileOptions: 'Show file options',
  showFileInfo: 'Show file info',
  hideFileInfo: 'Hide file info',
  showLinksSection: 'Show links section',
  hideLinksSection: 'Hide links section',
  submit: 'Submit',
  renameFile: 'Rename file',
  showLinkedItems: 'Show linked items',
  closeModal: 'Close modal',
  filePreviewModal: 'File preview modal',

  // ImageAlignmentOptions
  leftAlign: 'Left align',
  centerAlign: 'Center align',
  rightAlign: 'Right align',

  // VideoPreview
  videoCannotBePreviewed: "This video can't be previewed.",

  // AudioPreview
  audioCannotBePlayed: "This audio can't be played.",
  downloadToListen: 'To listen to this file, download it and open it using another application.',

  // PreviewComponent
  externalAppOnly: 'This file can only be previewed in an external app',
  openFilePreview: 'Open file preview',
  loadingPdfViewer: 'Loading PDF viewer...',

  // ZoomableImage
  zoomOut: 'Zoom out',
  zoomIn: 'Zoom in',
  resetToActualSize: 'Reset to actual size',
  resetTo100: 'Reset to 100%',
  fitToScreen: 'Fit to screen',

  // PdfPreview
  unableToRenderPdf: 'Unable to render this PDF.',
  pdfCorruptedOrProtected: 'The file may be corrupted or password-protected.',
  loadingPdf: 'Loading PDF...',
  previousPage: 'Previous page',
  pageNumber: 'Page number',
  nextPage: 'Next page',
  fitWidth: 'Fit width',
  searchInDocumentShortcut: 'Search in document (Ctrl/Cmd+F)',
  searchInDocument: 'Search in document',
  copyLinkToPage: 'Copy link to page {{page}}',
  copyLinkToThisPage: 'Copy link to this page',
  copyLinkToSelectedText: 'Copy link to selected text',
  cancelOcr: 'Cancel OCR',
  preparingOcr: 'Preparing OCR...',
  ocrProgress: 'OCR page {{current}} / {{total}} ({{percent}}%)',
  ocrCachedReRunTooltip: 'Text already extracted (cached). Re-run OCR in your browser (stays on your device).',
  ocrExtractedReRunTooltip: 'Text extracted. Re-run OCR in your browser (stays on your device).',
  ocrExtractTooltip: 'Extract text from scanned pages with OCR. Runs in your browser; nothing leaves your device (slow; downloads language data).',
  extractTextWithOcrBrowser: 'Extract text with OCR in your browser',
  reRunOcrBrowser: 'Re-run OCR (browser)',
  extractTextOcr: 'Extract text (OCR)',
  serverOcrTooltip:
    "Run OCR on the SERVER. This sends this PDF's page images to the server and LEAVES end-to-end encryption — the server can read that content. Browser OCR keeps everything on your device.",
  runOcrOnServerAria: 'Run OCR on the server (sends page images to the server; leaves end-to-end encryption)',
  runOcrOnServer: 'Run OCR on server',
  copyAllExtractedText: 'Copy all extracted text',
  copyExtractedTextAria: 'Copy extracted text',
  findInDocument: 'Find in document',
  matchCase: 'Match case',
  noResults: 'No results',
  matchOfTotal: '{{current}} of {{total}}',
  previousMatch: 'Previous match',
  nextMatch: 'Next match',
  closeSearch: 'Close search',
  serverOcrDisclosurePrefix: 'Server OCR is available for your account. It sends this PDF’s page images to the server and',
  serverOcrDisclosureBold: 'leaves end-to-end encryption',
  serverOcrDisclosureSuffix:
    ' — the server (and anyone who controls it) can read that content. Browser OCR keeps everything on your device. Default is browser OCR.',
  ocrRunningServer:
    'Server OCR: this PDF’s page images are being uploaded to the server, which LEAVES end-to-end encryption — the server can read that content. (Browser OCR keeps everything on your device.)',
  ocrRunningBrowser:
    'OCR runs in your browser on this device (your files stay end-to-end encrypted). It is slow and downloads language data on first use.',
  ocrDoneServer:
    'Server OCR finished. The page images were sent to the server (this left end-to-end encryption). Accuracy varies with scan quality; extracted text is now searchable and copyable, and is cached on this device.',
  ocrDoneBrowser:
    'OCR finished. Accuracy varies with scan quality; extracted text is now searchable and copyable, and is cached on this device.',

  // PdfPreview toasts (call-time)
  copiedExtractedText: 'Copied extracted text',
  copiedLinkToPage: 'Copied link to page {{page}}',
  copiedLinkToSelectedText: 'Copied link to selected text',

  // PdfPreview OCR errors (call-time)
  serverOcrFailed: 'Server OCR failed: {{message}}',
  ocrUnknownError: 'unknown error',
  ocrFailed: 'OCR failed. The language data may have failed to download.',
}

export default files
