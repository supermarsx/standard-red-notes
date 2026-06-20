import { AnonymousReference } from './AnonymousReference'
import { ContentReferenceType } from './ContenteReferenceType'

export interface FolderToParentFolderReference extends AnonymousReference {
  content_type: string
  reference_type: ContentReferenceType.FolderToParentFolder
}
