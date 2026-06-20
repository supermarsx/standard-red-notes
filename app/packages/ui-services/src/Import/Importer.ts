import { parseFileName } from '@standardnotes/utils'
import {
  FeatureStatus,
  FeaturesClientInterface,
  GenerateUuid,
  ItemManagerInterface,
  MutatorClientInterface,
} from '@standardnotes/services'
import { NativeFeatureIdentifier, NoteType } from '@standardnotes/features'
import { AegisToAuthenticatorConverter } from './AegisConverter/AegisToAuthenticatorConverter'
import { EvernoteConverter } from './EvernoteConverter/EvernoteConverter'
import { GoogleKeepConverter } from './GoogleKeepConverter/GoogleKeepConverter'
import { PlaintextConverter } from './PlaintextConverter/PlaintextConverter'
import { SimplenoteConverter } from './SimplenoteConverter/SimplenoteConverter'
import { assertImportFileWithinSizeLimit, MaxImportFileSizeBytes } from './ImportLimits'
import { readFileAsText } from './Utils'
import {
  DecryptedItemInterface,
  FileItem,
  ItemContent,
  NoteContent,
  SNNote,
  SNTag,
  TagContent,
  isFile,
} from '@standardnotes/models'
import { HTMLConverter } from './HTMLConverter/HTMLConverter'
import { OneNoteConverter } from './OneNoteConverter/OneNoteConverter'
import { ZohoNotebookConverter } from './ZohoNotebookConverter/ZohoNotebookConverter'
import { SuperConverter } from './SuperConverter/SuperConverter'
import { CSVMarkdownConverter } from './CSVConverter/CSVMarkdownConverter'
import { CSVSpreadsheetConverter } from './CSVConverter/CSVSpreadsheetConverter'
import { CleanupItemsFn, Converter, InsertNoteFn, InsertTagFn, LinkItemsFn, UploadFileFn } from './Converter'
import { ConversionResult } from './ConversionResult'
import { FilesClientInterface, SuperConverterHTMLOptions, SuperConverterServiceInterface } from '@standardnotes/files'
import { ContentType } from '@standardnotes/domain-core'

const BytesInOneMegabyte = 1_000_000
const NoteSizeThreshold = 3 * BytesInOneMegabyte

/** Import-type id for a native Standard Notes backup file (decrypted or encrypted). */
export const StandardNotesBackupImportType = 'standard-notes-backup'

/** True if the text content is a native Standard Notes backup file (has an items array). */
export function isStandardNotesBackupContent(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as { items?: unknown }
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      Array.isArray(parsed.items) &&
      (parsed.items.length === 0 ||
        (typeof parsed.items[0] === 'object' && parsed.items[0] !== null && 'content_type' in (parsed.items[0] as object)))
    )
  } catch {
    return false
  }
}

export class Importer {
  converters: Set<Converter> = new Set()

  constructor(
    private features: FeaturesClientInterface,
    private mutator: MutatorClientInterface,
    private items: ItemManagerInterface,
    private superConverterService: SuperConverterServiceInterface,
    private filesController: {
      uploadNewFile(
        fileOrHandle: File | FileSystemFileHandle,
        options?: {
          showToast?: boolean
          note?: SNNote
        },
      ): Promise<FileItem | undefined>
    },
    private linkingController: {
      linkItems(
        item: DecryptedItemInterface<ItemContent>,
        itemToLink: DecryptedItemInterface<ItemContent>,
        sync: boolean,
      ): Promise<void>
    },
    private _generateUuid: GenerateUuid,
    private files: FilesClientInterface,
    /**
     * Imports a native Standard Notes backup file via the app's ImportData use
     * case (handles decrypted + encrypted backups, prompting for the password
     * when needed). Injected by the host app since it needs the full application.
     */
    private importStandardNotesBackup?: (file: File) => Promise<ConversionResult>,
  ) {
    this.registerNativeConverters()
  }

  registerNativeConverters() {
    this.converters.add(new AegisToAuthenticatorConverter())
    this.converters.add(new GoogleKeepConverter())
    this.converters.add(new SimplenoteConverter())
    this.converters.add(new PlaintextConverter())
    this.converters.add(new EvernoteConverter(this._generateUuid))
    // OneNote/Zoho must be registered before the generic HTMLConverter: the
    // HTML converter matches any `text/html` file (isContentValid always true),
    // so these stricter converters need to be checked first during detection.
    this.converters.add(new OneNoteConverter())
    this.converters.add(new ZohoNotebookConverter())
    this.converters.add(new HTMLConverter())
    this.converters.add(new SuperConverter(this.superConverterService))
    this.converters.add(new CSVMarkdownConverter())
    this.converters.add(new CSVSpreadsheetConverter())
  }

  detectService = async (file: File): Promise<string | null> => {
    if (file.size > MaxImportFileSizeBytes) {
      return null
    }
    const content = await readFileAsText(file)

    // A native Standard Notes backup takes priority over the generic converters
    // (a .txt/.json backup could otherwise be mistaken for plaintext).
    if (this.importStandardNotesBackup && isStandardNotesBackupContent(content)) {
      return StandardNotesBackupImportType
    }

    const { ext } = parseFileName(file.name)

    for (const converter of this.converters) {
      const isCorrectType = converter.getSupportedFileTypes && converter.getSupportedFileTypes().includes(file.type)
      const isCorrectExtension = converter.getFileExtension && converter.getFileExtension() === ext

      if (!isCorrectType && !isCorrectExtension) {
        continue
      }

      if (converter.isContentValid(content)) {
        return converter.getImportType()
      }
    }

    return null
  }

  insertNote: InsertNoteFn = async ({
    createdAt,
    updatedAt,
    title,
    text,
    noteType,
    editorIdentifier,
    trashed = false,
    archived = false,
    pinned = false,
    useSuperIfPossible,
  }) => {
    if (noteType === NoteType.Super && !this.canUseSuper()) {
      noteType = undefined
    }

    if (
      editorIdentifier &&
      this.features.getFeatureStatus(NativeFeatureIdentifier.create(editorIdentifier).getValue()) !==
        FeatureStatus.Entitled
    ) {
      editorIdentifier = undefined
    }

    const shouldUseSuper = useSuperIfPossible && this.canUseSuper()

    const noteSize = new Blob([text]).size

    if (noteSize > NoteSizeThreshold) {
      throw new Error('Note is too large to import')
    }

    const note = this.items.createTemplateItem<NoteContent, SNNote>(
      ContentType.TYPES.Note,
      {
        title,
        text,
        references: [],
        noteType: shouldUseSuper ? NoteType.Super : noteType,
        trashed,
        archived,
        pinned,
        editorIdentifier: shouldUseSuper ? NativeFeatureIdentifier.TYPES.SuperEditor : editorIdentifier,
      },
      {
        created_at: createdAt,
        updated_at: updatedAt,
      },
    )

    return await this.mutator.insertItem(note)
  }

  insertTag: InsertTagFn = async ({ createdAt, updatedAt, title, references }) => {
    const tag = this.items.createTemplateItem<TagContent, SNTag>(
      ContentType.TYPES.Tag,
      {
        title,
        expanded: false,
        iconString: '',
        references,
      },
      {
        created_at: createdAt,
        updated_at: updatedAt,
      },
    )

    return await this.mutator.insertItem(tag)
  }

  canUploadFiles = (): boolean => {
    const status = this.features.getFeatureStatus(
      NativeFeatureIdentifier.create(NativeFeatureIdentifier.TYPES.Files).getValue(),
    )

    return status === FeatureStatus.Entitled
  }

  uploadFile: UploadFileFn = async (file) => {
    if (!this.canUploadFiles()) {
      return undefined
    }

    try {
      return await this.filesController.uploadNewFile(file, { showToast: true })
    } catch (error) {
      console.error(error)
      return undefined
    }
  }

  linkItems: LinkItemsFn = async (item, itemToLink) => {
    await this.linkingController.linkItems(item, itemToLink, false)
  }

  cleanupItems: CleanupItemsFn = async (items) => {
    for (const item of items) {
      if (isFile(item)) {
        await this.files.deleteFile(item)
      }
      await this.mutator.deleteItems([item])
    }
  }

  canUseSuper = (): boolean => {
    return (
      this.features.getFeatureStatus(
        NativeFeatureIdentifier.create(NativeFeatureIdentifier.TYPES.SuperEditor).getValue(),
      ) === FeatureStatus.Entitled
    )
  }

  convertHTMLToSuper = (html: string, options?: SuperConverterHTMLOptions): string => {
    if (!this.canUseSuper()) {
      return html
    }

    return this.superConverterService.convertOtherFormatToSuperString(html, 'html', {
      html: options,
    })
  }

  convertMarkdownToSuper = (markdown: string): string => {
    if (!this.canUseSuper()) {
      return markdown
    }

    return this.superConverterService.convertOtherFormatToSuperString(markdown, 'md')
  }

  async importFromFile(file: File, type: string): Promise<ConversionResult> {
    const canUseSuper = this.canUseSuper()

    if (type === StandardNotesBackupImportType) {
      if (!this.importStandardNotesBackup) {
        throw new Error('Standard Notes backup import is not available')
      }
      assertImportFileWithinSizeLimit(file)
      return this.importStandardNotesBackup(file)
    }

    if (type === 'super' && !canUseSuper) {
      throw new Error('Importing Super notes requires a subscription')
    }

    assertImportFileWithinSizeLimit(file)

    const successful: ConversionResult['successful'] = []
    const errored: ConversionResult['errored'] = []

    for (const converter of this.converters) {
      const isCorrectType = converter.getImportType() === type

      if (!isCorrectType) {
        continue
      }

      const content = await readFileAsText(file)

      if (!converter.isContentValid(content)) {
        throw new Error('Content is not valid')
      }

      const result = await converter.convert(file, {
        insertNote: this.insertNote,
        insertTag: this.insertTag,
        canUploadFiles: this.canUploadFiles(),
        uploadFile: this.uploadFile,
        canUseSuper,
        convertHTMLToSuper: this.convertHTMLToSuper,
        convertMarkdownToSuper: this.convertMarkdownToSuper,
        readFileAsText,
        linkItems: this.linkItems,
        cleanupItems: this.cleanupItems,
      })

      successful.push(...result.successful)
      errored.push(...result.errored)

      break
    }

    return {
      successful,
      errored,
    }
  }
}
