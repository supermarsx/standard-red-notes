import { VectorIconNameOrEmoji, IconType } from './../../Utilities/Icon/IconType'
import { DecryptedItem } from '../../Abstract/Item/Implementations/DecryptedItem'
import { ItemInterface } from '../../Abstract/Item/Interfaces/ItemInterface'
import { ContentReference } from '../../Abstract/Reference/ContentReference'
import { isFolderToParentFolderReference } from '../../Abstract/Reference/Functions'
import { DecryptedPayloadInterface } from '../../Abstract/Payload/Interfaces/DecryptedPayload'
import { FolderContent, FolderContentSpecialized } from './FolderContent'
import { FolderContentType } from './FolderContentType'
import { ContentType } from '@standardnotes/domain-core'

export const DefaultFolderIconName: IconType = 'folder'

export const isFolderItem = (x: ItemInterface): x is SNFolder => x.content_type === FolderContentType

export class SNFolder extends DecryptedItem<FolderContent> implements FolderContentSpecialized {
  public readonly title: string
  public readonly iconString: VectorIconNameOrEmoji
  public readonly expanded: boolean
  public readonly color?: string

  constructor(payload: DecryptedPayloadInterface<FolderContent>) {
    super(payload)
    this.title = this.payload.content.title || ''
    this.expanded = this.payload.content.expanded != undefined ? this.payload.content.expanded : true
    this.iconString = this.payload.content.iconString || DefaultFolderIconName
    this.color = this.payload.content.color || undefined
  }

  get noteReferences(): ContentReference[] {
    const references = this.payload.references
    return references.filter((ref) => ref.content_type === ContentType.TYPES.Note)
  }

  get noteCount(): number {
    return this.noteReferences.length
  }

  public get parentId(): string | undefined {
    const reference = this.references.find(isFolderToParentFolderReference)
    return reference?.uuid
  }
}
