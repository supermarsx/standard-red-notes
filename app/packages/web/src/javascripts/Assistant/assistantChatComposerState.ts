import type { AssistantContextSelection } from './assistantContextSource'
import type { AssistantToolPermissionMode } from './assistantActionReview'
import { normalizeAssistantAttachments, type AssistantAttachment } from './attachments'

export type AssistantChatDraft = { text: string; attachments?: AssistantAttachment[] }
export type AssistantChatComposerPatch = {
  draft?: AssistantChatDraft | null
  context?: AssistantContextSelection
  toolPermissionMode?: AssistantToolPermissionMode
}
export type AssistantChatComposerState = {
  [K in keyof AssistantChatComposerPatch]?: {
    value: NonNullable<AssistantChatComposerPatch[K]> | (K extends 'draft' ? null : never)
    updatedAt: number
  }
}
export const ASSISTANT_COMPOSER_FIELDS = ['draft', 'context', 'toolPermissionMode'] as const
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)
function contextValue(value: unknown): AssistantContextSelection | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const raw = value as AssistantContextSelection
  if (!['current-note', 'selection', 'open-notes', 'all-notes', 'topic', 'collection'].includes(raw.scope)) {
    return undefined
  }
  if (raw.scope === 'selection') {
    if (raw.excerpt === undefined) {
      return { scope: raw.scope }
    }
    if (!identifier(raw.excerpt?.noteUuid) || typeof raw.excerpt?.text !== 'string' || raw.excerpt.text.length > 8000) {
      return undefined
    }
    return { scope: raw.scope, excerpt: { noteUuid: raw.excerpt.noteUuid, text: raw.excerpt.text } }
  }
  if (raw.scope === 'topic') {
    if (raw.topicQuery !== undefined && (typeof raw.topicQuery !== 'string' || raw.topicQuery.length > 2000)) {
      return undefined
    }
    return { scope: raw.scope, topicQuery: raw.topicQuery ?? '' }
  }
  if (raw.scope === 'collection' && raw.collection !== undefined) {
    const collection = raw.collection
    if (!collection || typeof collection !== 'object') {
      return undefined
    }
    if (collection.type === 'notes') {
      if (!Array.isArray(collection.uuids) || collection.uuids.length > 1000 || !collection.uuids.every(identifier)) {
        return undefined
      }
      return { scope: raw.scope, collection: { type: 'notes', uuids: [...new Set(collection.uuids)] } }
    }
    if (!['tag', 'folder'].includes(collection.type) || !identifier(collection.uuid)) {
      return undefined
    }
    return { scope: raw.scope, collection: { type: collection.type, uuid: collection.uuid } }
  }
  return { scope: raw.scope }
}

/** Closed encrypted schema: persist user-authored drafts/context only, never provider configuration. */
export function normalizeAssistantChatComposerState(value: unknown): AssistantChatComposerState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const result: AssistantChatComposerState = {}
  const raw = value as Record<string, { value: unknown; updatedAt: number }>
  for (const field of ASSISTANT_COMPOSER_FIELDS) {
    if (raw[field] === undefined) {
      continue
    }
    const item = raw[field]
    if (!item || !Number.isSafeInteger(item.updatedAt) || item.updatedAt < 0) {
      return undefined
    }
    if (field === 'draft') {
      if (item.value === null) {
        result.draft = { value: null, updatedAt: item.updatedAt }
        continue
      }
      if (!item.value || typeof item.value !== 'object') {
        return undefined
      }
      const draft = item.value as AssistantChatDraft
      if (typeof draft.text !== 'string' || draft.text.length > 32_000) {
        return undefined
      }
      const attachments = normalizeAssistantAttachments(draft.attachments ?? [])
      if (!attachments) {
        return undefined
      }
      result.draft = { value: { text: draft.text, attachments }, updatedAt: item.updatedAt }
    } else if (field === 'context') {
      const context = contextValue(item.value)
      if (!context) {
        return undefined
      }
      result.context = { value: context, updatedAt: item.updatedAt }
    } else {
      if (!['ask', 'allow-read', 'allow-safe', 'allow-all', 'bypass'].includes(item.value as string)) {
        return undefined
      }
      result.toolPermissionMode = { value: item.value as AssistantToolPermissionMode, updatedAt: item.updatedAt }
    }
  }
  return result
}
