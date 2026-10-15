export interface RevisionMetadata {
  automatic_checkpoint?: boolean
  coalesced_changes?: number
  uuid: string
  content_type: string
  created_at: string
  updated_at: string
  required_role: string
  edited_by_uuid?: string | null
}
