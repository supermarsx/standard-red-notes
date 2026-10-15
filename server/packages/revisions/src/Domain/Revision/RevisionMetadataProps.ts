import { ContentType, Dates, Uuid } from '@standardnotes/domain-core'

export interface RevisionMetadataProps {
  coalescedChanges?: number
  contentType: ContentType
  itemUuid: Uuid
  sharedVaultUuid: Uuid | null
  editedByUuid?: string | null
  dates: Dates
}
