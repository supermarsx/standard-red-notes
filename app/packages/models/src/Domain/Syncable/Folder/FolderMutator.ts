import { SNFolder } from './SNFolder'
import { FolderContent } from './FolderContent'
import { SNNote } from '../Note'
import { isFolderToParentFolderReference } from '../../Abstract/Reference/Functions'
import { FolderToParentFolderReference } from '../../Abstract/Reference/FolderToParentFolderReference'
import { ContentReferenceType } from '../../Abstract/Reference/ContenteReferenceType'
import { DecryptedItemMutator } from '../../Abstract/Item/Mutator/DecryptedItemMutator'
import { FolderContentType } from './FolderContentType'

export class FolderMutator<Content extends FolderContent = FolderContent> extends DecryptedItemMutator<Content> {
  set title(title: string) {
    this.mutableContent.title = title
  }

  set expanded(expanded: boolean) {
    this.mutableContent.expanded = expanded
  }

  set iconString(iconString: string) {
    this.mutableContent.iconString = iconString
  }

  set color(color: string | undefined) {
    if (color) {
      this.mutableContent.color = color
    } else {
      delete this.mutableContent.color
    }
  }

  public makeChildOf(folder: SNFolder): void {
    const references = this.immutableItem.references.filter((ref) => !isFolderToParentFolderReference(ref))

    const reference: FolderToParentFolderReference = {
      reference_type: ContentReferenceType.FolderToParentFolder,
      content_type: FolderContentType,
      uuid: folder.uuid,
    }

    references.push(reference)

    this.mutableContent.references = references
  }

  public unsetParent(): void {
    this.mutableContent.references = this.immutableItem.references.filter(
      (ref) => !isFolderToParentFolderReference(ref),
    )
  }

  public addNote(note: SNNote): void {
    if (this.immutableItem.isReferencingItem(note)) {
      return
    }

    this.mutableContent.references.push({
      uuid: note.uuid,
      content_type: note.content_type,
    })
  }

  public removeNote(note: SNNote): void {
    this.mutableContent.references = this.mutableContent.references.filter((r) => r.uuid !== note.uuid)
  }
}
