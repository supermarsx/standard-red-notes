import { ContentType } from '@standardnotes/domain-core'
import { DecryptedItem } from '../../Abstract/Item/Implementations/DecryptedItem'
import { ItemContent } from '../../Abstract/Content/ItemContent'
import { DecryptedPayloadInterface } from '../../Abstract/Payload/Interfaces/DecryptedPayload'
import { FileMetadata } from './FileMetadata'
import { FileProtocolV1 } from './FileProtocolV1'
import { SortableItem } from '../../Runtime/Collection/CollectionSort'
import { ConflictStrategy, ItemInterface } from '../../Abstract/Item'

type EncryptedBytesLength = number
type DecryptedBytesLength = number

interface SizesDeprecatedDueToAmbiguousNaming {
  size?: DecryptedBytesLength
  chunkSizes?: EncryptedBytesLength[]
}

interface Sizes {
  decryptedSize: DecryptedBytesLength
  encryptedChunkSizes: EncryptedBytesLength[]
}

/**
 * File descriptions are encrypted as part of the File item's content. Keep the
 * field bounded so a metadata edit cannot unexpectedly inflate every sync
 * payload that carries the item.
 */
export const MAX_FILE_DESCRIPTION_LENGTH = 4_096

function stripUnsupportedFileDescriptionCharacters(description: string): string {
  let result = ''

  for (const character of description) {
    const codePoint = character.codePointAt(0) as number
    const isUnsupportedControl =
      (codePoint >= 0 && codePoint <= 8) ||
      codePoint === 11 ||
      codePoint === 12 ||
      (codePoint >= 14 && codePoint <= 31) ||
      (codePoint >= 127 && codePoint <= 159) ||
      // A valid surrogate pair is yielded by `for...of` as one code point above
      // U+FFFF. Values in this range are therefore unpaired surrogate halves.
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    const isBidirectionalFormattingControl =
      codePoint === 0x061c ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)

    if (!isUnsupportedControl && !isBidirectionalFormattingControl) {
      result += character
    }
  }

  return result
}

export function normalizeFileDescription(description: string | undefined): string | undefined {
  if (typeof description !== 'string') {
    return undefined
  }

  const displaySafeDescription = stripUnsupportedFileDescriptionCharacters(description.replace(/\r\n?/gu, '\n'))
    .trim()
    .slice(0, MAX_FILE_DESCRIPTION_LENGTH)

  // MAX_FILE_DESCRIPTION_LENGTH is intentionally a UTF-16 code-unit bound so it
  // matches textarea.maxLength and the serialized JavaScript string length. If
  // slicing lands between a valid surrogate pair, drop the dangling high half.
  const finalCodeUnit = displaySafeDescription.charCodeAt(displaySafeDescription.length - 1)
  const boundedDescription =
    finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff ? displaySafeDescription.slice(0, -1) : displaySafeDescription
  const normalized = boundedDescription.trimEnd()

  return normalized.length > 0 ? normalized : undefined
}

interface FileContentWithoutSize {
  remoteIdentifier: string
  name: string
  description?: string
  key: string
  encryptionHeader: string
  mimeType: string
}

export type FileContentSpecialized = FileContentWithoutSize & FileMetadata & SizesDeprecatedDueToAmbiguousNaming & Sizes

export type FileContent = FileContentSpecialized & ItemContent

export const isFile = (x: ItemInterface): x is FileItem => x.content_type === ContentType.TYPES.File

export class FileItem
  extends DecryptedItem<FileContent>
  implements FileContentWithoutSize, Sizes, FileProtocolV1, FileMetadata, SortableItem
{
  public readonly remoteIdentifier: string
  public readonly name: string
  public readonly description?: string
  public readonly key: string
  public readonly encryptionHeader: string
  public readonly mimeType: string

  public readonly decryptedSize: DecryptedBytesLength
  public readonly encryptedChunkSizes: EncryptedBytesLength[]

  constructor(payload: DecryptedPayloadInterface<FileContent>) {
    super(payload)
    this.remoteIdentifier = this.content.remoteIdentifier
    this.name = this.content.name
    this.description = normalizeFileDescription(this.content.description)
    this.key = this.content.key

    if (this.content.size && this.content.chunkSizes) {
      this.decryptedSize = this.content.size
      this.encryptedChunkSizes = this.content.chunkSizes
    } else {
      this.decryptedSize = this.content.decryptedSize
      this.encryptedChunkSizes = this.content.encryptedChunkSizes
    }

    this.encryptionHeader = this.content.encryptionHeader
    this.mimeType = this.content.mimeType
  }

  public override strategyWhenConflictingWithItem(item: FileItem): ConflictStrategy {
    if (
      item.key !== this.key ||
      item.encryptionHeader !== this.encryptionHeader ||
      item.remoteIdentifier !== this.remoteIdentifier ||
      JSON.stringify(item.encryptedChunkSizes) !== JSON.stringify(this.encryptedChunkSizes)
    ) {
      return ConflictStrategy.KeepBaseDuplicateApply
    }

    return ConflictStrategy.KeepBase
  }

  public get encryptedSize(): number {
    return this.encryptedChunkSizes.reduce((total, chunk) => total + chunk, 0)
  }

  public get title(): string {
    return this.name
  }
}
