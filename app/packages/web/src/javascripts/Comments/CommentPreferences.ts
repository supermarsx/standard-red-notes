import type { PrefKey } from '@standardnotes/snjs'

// Literal keys also work before generated SDK bundles have been rebuilt.
export const COMMENT_INDICATORS_PREF_KEY = 'showCommentIndicators' as unknown as PrefKey
export const COMMENT_NOTIFY_DEFAULT_PREF_KEY = 'commentNotifyOthersDefault' as unknown as PrefKey
export const showCommentIndicators = (value: unknown): boolean => value !== false
export const notifyOthersByDefault = (value: unknown): boolean => value === true

/** A signed recipient marker in the existing, bounded comment mentions field. */
export const ALL_NOTE_MEMBERS_RECIPIENT = 'all-note-members'
