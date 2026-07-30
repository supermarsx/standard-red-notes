// Pure, React-free name resolution for the Storage pane's "Largest items" list.
//
// The largest-items list is computed OFF the main thread by storageUsage.worker.ts
// over the ENCRYPTED IndexedDB payloads, so each row only carries what's derivable
// WITHOUT decrypting: { uuid, contentType, bytes } (plus a best-effort `title` that
// usually falls back to the uuid). Turning a uuid into a human-readable NAME needs
// the DECRYPTED, in-memory item, which only the main thread has. This helper does
// that mapping given an already-looked-up item (application.items.findItem(uuid)),
// falling back to a friendly content-type label and finally the raw uuid so the row
// always renders something and the uuid stays available for its actions.

import {
  ContentType,
  DecryptedItemInterface,
  IconType,
  ItemInterface,
  isContentTypeExportable,
  isFile,
  isNote,
  isTag,
} from '@standardnotes/snjs'

export interface StorageItemLabel {
  /** Human-readable primary label for the row. Never empty. */
  primary: string
  /**
   * Subtle secondary line — the uuid when we resolved a real name (so it stays
   * visible/copyable), otherwise undefined (the uuid is already the primary).
   */
  secondary?: string
}

const UNTITLED_NOTE = 'Untitled note'

/**
 * Friendly SINGULAR labels for known content types that don't carry a user-facing
 * title, so a title-less row still reads as something ("Items key") rather than a
 * raw content_type string ("SN|ItemsKey") or a bare uuid.
 */
const CONTENT_TYPE_FRIENDLY: Record<string, string> = {
  [ContentType.TYPES.Note]: 'Note',
  [ContentType.TYPES.Tag]: 'Tag',
  [ContentType.TYPES.File]: 'File',
  [ContentType.TYPES.SmartView]: 'Smart view',
  [ContentType.TYPES.Component]: 'Component',
  [ContentType.TYPES.Editor]: 'Editor component',
  [ContentType.TYPES.Theme]: 'Theme',
  [ContentType.TYPES.ItemsKey]: 'Items key',
  [ContentType.TYPES.UserPrefs]: 'User preferences',
  [ContentType.TYPES.ExtensionRepo]: 'Plugin repo',
  [ContentType.TYPES.ActionsExtension]: 'Extension',
  [ContentType.TYPES.HistorySession]: 'History session',
  [ContentType.TYPES.FilesafeFileMetadata]: 'File metadata',
  [ContentType.TYPES.TrustedContact]: 'Trusted contact',
  [ContentType.TYPES.VaultListing]: 'Vault',
}

/** Friendly label for a content type, or undefined if it's not one we recognize. */
export function friendlyContentTypeLabel(contentType: string | undefined): string | undefined {
  if (!contentType) {
    return undefined
  }
  return CONTENT_TYPE_FRIENDLY[contentType]
}

/**
 * A content-type -> app `IconType` fallback, so a compact row can show a type icon
 * even when the item isn't in memory (or is a type getIconForItem doesn't handle).
 * Names are real IconType values (see @standardnotes/models IconType). For the common
 * Note/File/Tag/SmartView case the caller PREFERS the richer getIconForItem mapping
 * (editor-specific note icon, file mime-type icon, custom tag/smart-view icon) and
 * only falls back to this when that lookup isn't possible.
 */
const CONTENT_TYPE_ICON: Record<string, IconType> = {
  [ContentType.TYPES.Note]: 'notes',
  [ContentType.TYPES.Tag]: 'hashtag',
  [ContentType.TYPES.File]: 'file',
  [ContentType.TYPES.SmartView]: 'tune',
  [ContentType.TYPES.Component]: 'window',
  [ContentType.TYPES.Editor]: 'editor',
  [ContentType.TYPES.Theme]: 'themes',
  [ContentType.TYPES.ItemsKey]: 'lock',
  [ContentType.TYPES.UserPrefs]: 'settings',
  [ContentType.TYPES.ExtensionRepo]: 'link',
  [ContentType.TYPES.ActionsExtension]: 'window',
  [ContentType.TYPES.HistorySession]: 'history',
  [ContentType.TYPES.FilesafeFileMetadata]: 'file',
  [ContentType.TYPES.TrustedContact]: 'user',
  [ContentType.TYPES.VaultListing]: 'safe-square',
}

/** Fallback type icon for a storage row; a generic box for anything unrecognized. */
export function storageItemIconType(contentType: string | undefined): IconType {
  if (!contentType) {
    return 'box'
  }
  return CONTENT_TYPE_ICON[contentType] ?? 'box'
}

/**
 * Whether a largest-items row can be OPENED in a view and meaningfully EXPORTED in a
 * native format — i.e. it's a user-facing Note or File. Every other content type
 * (items keys, user preferences, tags, components, themes, smart views, key-system
 * records, etc.) is not directly navigable. Pure — keys off content_type alone,
 * no decrypted item required.
 */
export function isOpenableStorageItem(contentType: string | undefined): boolean {
  return contentType === ContentType.TYPES.Note || contentType === ContentType.TYPES.File
}

/**
 * Whether a largest-items row may be EXPORTED. Unlike "openable" (Note/File only), a row is
 * exportable for EVERY content type EXCEPT an items key or user preferences — a decrypted items
 * key is key-material leak and user preferences are private noise. This is the single shared
 * exportability rule (`isContentTypeExportable`), so a non-openable item (tag, component, theme,
 * smart view, …) is now exportable while items key / user preferences stay non-exportable.
 */
export function isExportableStorageItem(contentType: string | undefined): boolean {
  return isContentTypeExportable(contentType)
}

/**
 * Only user content with an established deletion workflow may be removed from the
 * storage-size list. System, key, vault, preference, component, and organization
 * records must be managed by their owning feature; generic deletion can make data
 * undecryptable or bypass required relationship cleanup.
 */
export function isDeletableStorageItem(contentType: string | undefined): boolean {
  return contentType === ContentType.TYPES.Note || contentType === ContentType.TYPES.File
}

/** Best-effort read of a string `title` off any item, trimmed, or undefined. */
function readTitle(item: ItemInterface): string | undefined {
  const value = (item as { title?: unknown }).title
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim()
  }
  return undefined
}

/**
 * Resolve a human-readable label for a largest-items row.
 *
 *  - Note        -> note.title, or "Untitled note" when empty/whitespace.
 *  - File        -> file.name (friendly type label if somehow blank).
 *  - Tag         -> "# " + tag.title.
 *  - Other known -> item.title when present, else a friendly content-type label.
 *  - Not found / still encrypted -> friendly content-type label (from `contentType`)
 *    if known, otherwise the raw uuid.
 *
 * `secondary` carries the uuid whenever `primary` is a resolved name, so the uuid
 * stays visible; when we can only show the uuid it becomes the primary and
 * `secondary` is undefined. Either way the CALLER still holds row.uuid for the
 * open/delete/export actions — this function never mutates or hides it.
 */
export function resolveStorageItemLabel(
  item: DecryptedItemInterface | ItemInterface | undefined,
  uuid: string,
  contentType?: string,
): StorageItemLabel {
  if (item) {
    if (isNote(item)) {
      const title = item.title.trim()
      return { primary: title.length > 0 ? title : UNTITLED_NOTE, secondary: uuid }
    }

    if (isFile(item)) {
      const name = (item.name ?? '').trim()
      return {
        primary: name.length > 0 ? name : (friendlyContentTypeLabel(item.content_type) ?? uuid),
        secondary: uuid,
      }
    }

    if (isTag(item)) {
      const title = item.title.trim()
      return {
        primary: title.length > 0 ? `# ${title}` : (friendlyContentTypeLabel(item.content_type) ?? uuid),
        secondary: uuid,
      }
    }

    // Other known items: prefer a real title, else a friendly content-type label.
    const title = readTitle(item)
    if (title) {
      return { primary: title, secondary: uuid }
    }
    const friendly = friendlyContentTypeLabel(item.content_type)
    if (friendly) {
      return { primary: friendly, secondary: uuid }
    }
    return { primary: uuid }
  }

  // Not found in memory (never loaded, deleted, or still encrypted): show a friendly
  // type label with the uuid beneath when we know the type, else just the uuid.
  const friendly = friendlyContentTypeLabel(contentType)
  if (friendly) {
    return { primary: friendly, secondary: uuid }
  }
  return { primary: uuid }
}
