import { ContentType } from '@standardnotes/domain-core'

/**
 * Content types that must NEVER ride along in a human-consumable / DECRYPTED export:
 *
 *  - ItemsKey (`SN|ItemsKey`): a decrypted items key is KEY MATERIAL. Emitting it in the
 *    clear (in a decrypted backup, a note/markdown export, or a per-item Storage export) is
 *    a key-material leak.
 *  - UserPrefs (`SN|UserPreferences`): private per-account settings that are noise in a
 *    notes/data export and shouldn't leave with it.
 *
 * This is the exclusion for DECRYPTED / consumable exports only. An ENCRYPTED full-account
 * backup deliberately stays COMPLETE (it keeps the encrypted items key and preferences) so a
 * round-trip restore works — do NOT apply this predicate to the encrypted backup path.
 */
const NON_EXPORTABLE_CONTENT_TYPES: ReadonlySet<string> = new Set<string>([
  ContentType.TYPES.ItemsKey,
  ContentType.TYPES.UserPrefs,
])

/**
 * Whether a content_type may appear in a decrypted / consumable export. Everything is
 * exportable EXCEPT an items key or user preferences. An empty/absent content_type is treated
 * as non-exportable (safe default — we never emit something we can't classify).
 */
export function isContentTypeExportable(contentType: string | undefined | null): boolean {
  if (contentType === undefined || contentType === null || contentType.length === 0) {
    return false
  }
  return !NON_EXPORTABLE_CONTENT_TYPES.has(contentType)
}

/**
 * Whether an item OR payload (anything carrying a `content_type`) may be included in a
 * decrypted / consumable export. Shared by the bulk export paths (decrypted backup, markdown /
 * note exports) and the Storage pane so both agree on exactly one rule.
 */
export function isItemExportable(item: { content_type: string } | undefined | null): boolean {
  if (!item) {
    return false
  }
  return isContentTypeExportable(item.content_type)
}
