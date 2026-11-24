import { ConflictStrategy, isDecryptedPayload, type SyncConflictPolicy } from '@standardnotes/models'
import { ContentType } from '@standardnotes/domain-core'
import { CollaborativeDocumentRegistry } from './CollaborativeDocumentRegistry'
import {
  documentStateCovers,
  readCollaborationRevisionStamp,
  revisionStampCoversDocumentState,
  revisionStampCoversRevision,
} from './CollaborationRevisionStamp'
import { CollaborationSaverRegistry } from './CollaborationSaverElection'

/** Compare all metadata; only CRDT body, derived previews and its timestamp/stamp may differ. */
function nonBodyMetadata(content: Record<string, unknown>): string {
  const metadata = { ...content }
  delete metadata.text
  delete metadata.preview_plain
  delete metadata.preview_html
  if (metadata.appData && typeof metadata.appData === 'object' && !Array.isArray(metadata.appData)) {
    const appData = { ...(metadata.appData as Record<string, unknown>) }
    const domain = appData['org.standardnotes.sn']
    if (domain && typeof domain === 'object' && !Array.isArray(domain)) {
      const retained = { ...(domain as Record<string, unknown>) }
      delete retained.client_updated_at
      delete retained.collaborationRevision
      appData['org.standardnotes.sn'] = retained
    }
    metadata.appData = appData
  }
  const canonical = (value: unknown): string => {
    if (!value || typeof value !== 'object') {
      return JSON.stringify(value) ?? 'null'
    }
    if (Array.isArray(value)) {
      return `[${value.map(canonical).join(',')}]`
    }
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(',')}}`
  }
  return canonical(metadata)
}

/**
 * Resolve only bodies proved to belong to the same saved or authenticated retained CRDT.
 * Untyped, deleted, unstamped and metadata-divergent items keep ordinary conflict rules.
 */
export const collaborationConflictPolicy: SyncConflictPolicy = (base, incoming) => {
  if (
    base.uuid !== incoming.uuid ||
    base.content_type !== ContentType.TYPES.Note ||
    incoming.content_type !== ContentType.TYPES.Note ||
    !base.dirty ||
    !isDecryptedPayload(base) ||
    !isDecryptedPayload(incoming) ||
    base.shared_vault_uuid !== incoming.shared_vault_uuid ||
    base.key_system_identifier !== incoming.key_system_identifier
  ) {
    return undefined
  }
  const localStamp = readCollaborationRevisionStamp(base.content)
  const remoteStamp = readCollaborationRevisionStamp(incoming.content)
  if (
    !localStamp ||
    !remoteStamp ||
    localStamp.epoch !== remoteStamp.epoch ||
    nonBodyMetadata(base.content as unknown as Record<string, unknown>) !==
      nonBodyMetadata(incoming.content as unknown as Record<string, unknown>)
  ) {
    return undefined
  }
  const document = CollaborativeDocumentRegistry.get(base.uuid)
  if (!document) {
    // Reopening/rejoining sync happens before a provider exists. Valid stamps
    // can still prove one saved body contains every insertion AND deletion in
    // the other. Never infer this from timestamps or similar-looking text.
    if (revisionStampCoversRevision(remoteStamp, localStamp)) {
      return ConflictStrategy.KeepApply
    }
    if (revisionStampCoversRevision(localStamp, remoteStamp)) {
      return ConflictStrategy.KeepBase
    }
    return undefined
  }
  if (!CollaborationSaverRegistry.get(base.uuid)) {
    return undefined
  }
  const liveState = document.state()
  const state = liveState ?? document.retainedState?.()
  if (
    !state ||
    document.epoch !== localStamp.epoch ||
    !documentStateCovers(state, localStamp) ||
    !documentStateCovers(state, remoteStamp)
  ) {
    return undefined
  }
  // All retained edits are durably covered: accepting the peer's clean revision
  // releases the former saver without another full-body upload or a duplicate.
  if (liveState && revisionStampCoversDocumentState(remoteStamp, state)) {
    return ConflictStrategy.KeepApply
  }
  // The room retains every operation in both bodies. Rebase the dirty copy on
  // the new server timestamp; the elected saver will serialize the merged doc.
  // A detached retained document proves coverage, not readiness to clear dirty state.
  return ConflictStrategy.KeepBase
}
