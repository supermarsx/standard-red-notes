import { ApplicationIdentifier, namespacedKey } from '@standardnotes/snjs'

/**
 * Standard Red Notes: which `localStorage` keys on this origin belong to THIS application.
 *
 * *** SAFETY BOUNDARY — the whole point of this module ***
 *
 * `WebOrDesktopDevice.removeAllRawStorageValues()` was a bare `localStorage.clear()`.
 * `localStorage` is per-ORIGIN, not per-application: on a shared origin — this app served
 * under a path alongside anything else on the same host, or a desktop renderer that also
 * loads another page — a last-workspace sign-out erased EVERY other application's
 * localStorage as well. That is the same defect `Database.deleteAll` had for IndexedDB
 * (see Database.isOwnDatabaseName), in a different storage area.
 *
 * So the clear is scoped by this app's own naming schemes, enumerated below. The lists are
 * deliberately exhaustive rather than clever: a prefix broad enough to cover a key we have
 * not thought of is also broad enough to delete a key we do not own.
 *
 * BOTH directions are failures, and the second is worse:
 *   - too broad  -> another application's data is destroyed (the bug being fixed);
 *   - too narrow -> a credential survives a sign-out (a security regression).
 * `OwnedStorageKeys.spec.ts` sweeps the source tree and fails if any key written by this
 * app's production code is not classified here, which is what keeps the second direction
 * from rotting as keys are added.
 */

/**
 * Keys under a namespace of this app's own. Each entry includes its separator, so a prefix
 * can never match a foreign key that merely starts with the same letters
 * (`snowflake-…` is not `sn-…`, `standardnotesclone` is not `standardnotes.`).
 */
export const OWN_STORAGE_KEY_PREFIXES: readonly string[] = [
  /** sn-language, sn-custom-themes, sn-assistant-usage, sn-auto-empty-trash-interval-ms:*, sn-pdf-ocr-cache:*, sn-super-* */
  'sn-',
  /** sn_achievements_*, sn_trusted_device_token, sn_shared_server_access_key, sn_item_restore_counts, sn_app_active_minutes, sn_manual_sync_mode, sn_strip_image_metadata_on_upload, sn_super_* */
  'sn_',
  /** srn-update-check-*, srn-storage-usage-snapshot-<workspace> */
  'srn-',
  /** srn_editor_tile_layout, srn_new_tab_behavior, srn_tab_custom_names, srn_folders_migrated_v1 */
  'srn_',
  /** __srn_diagnostics_storage_probe__ (the Admin storage probe writes and removes it) */
  '__srn_',
  /** standardnotes.<feature>.v<n> — the local, unsynced settings namespace */
  'standardnotes.',
  /** standard-red-notes:invite-realtime:v1:<session scope> */
  'standard-red-notes:',
  /** assistant-chat-history:v1:*, assistant-chat-tabs*, assistant-workspace-*, assistant-context-scope, assistant-data-exposure-notice-dismissed, assistant-browsing-context-id:v1 */
  'assistant-',
  /** AssistantChatHistory:v1:<scope> */
  'AssistantChatHistory:',
  /** AssistantChatTabs:v1:<scope> */
  'AssistantChatTabs:',
  /** super-editor:recent-symbols */
  'super-editor:',
  /** DiaryMode.lastPromptedDate */
  'DiaryMode.',
]

/**
 * Keys this app writes under no namespace at all. Exact matches only: these names are
 * generic enough that a prefix or substring test would reach other applications' keys.
 */
export const OWN_STORAGE_KEYS: readonly string[] = [
  /** WebDevice's device keychain — root key material for every workspace on this origin. */
  'keychain',
  /** RawStorageKey.DescriptorRecord — the workspace list ApplicationGroup boots from. */
  'descriptors',
  /** RawStorageKey.HomeServerEnabled / HomeServerDataLocation (desktop home server). */
  'home_server_enabled',
  'home_serve_data_location',
  /** The un-namespaced snjs 2.0.0 migration marker (Migrations/Base.ts). */
  'last_migration_timestamp',
  /** ui-services KeyboardShortcutOverrides. */
  'keyboardShortcutOverrides',
  /** ui-services Storage/LocalStorage.ts `StorageKey`. */
  'AnonymousUserId',
  'ShowBetaWarning',
  'ShowNoAccountWarning',
  'FilesNavigationEnabled',
  'master-persistence-key',
  /**
   * snjs 1.x raw keys. Migrations/Base.ts probes exactly these to detect a 1.x install and
   * nothing ever deletes them, so a long-lived profile can still be holding them — and
   * `user`, `syncToken`, `encryptedStorage`, `auth_params` and `offlineParams` are account
   * material. The old `localStorage.clear()` took them; leaving them behind would be a
   * sign-out that does not sign out. They are matched exactly for that reason: `user` is a
   * plausible key for another application too, and only an identical bare key is taken.
   */
  'migrations',
  'ephemeral',
  'user',
  'cachedThemes',
  'syncToken',
  'encryptedStorage',
  'offlineParams',
  'auth_params',
]

/**
 * The per-workspace raw keys, written as `namespacedKey(identifier, suffix)` — i.e.
 * `<identifier>-<suffix>`. Every `namespacedKey` call site in snjs/services uses one of
 * these four suffixes:
 *   storage                    RawStorageKey.StorageObject    (session, user, wrapped root key)
 *   snjs_version               RawStorageKey.SnjsVersion
 *   storage_object_generation  DiskStorageService.getGenerationPersistenceKey
 *   last_migration_timestamp   Migrations/Base.ts (snjs 2.0.0 marker)
 */
export const WORKSPACE_NAMESPACED_RAW_KEY_SUFFIXES: readonly string[] = [
  'storage',
  'snjs_version',
  'storage_object_generation',
  'last_migration_timestamp',
]

/**
 * The database/workspace name of Standard Notes web/desktop before workspaces existed,
 * still used by the first workspace of every install
 * (ApplicationGroup.createNewDescriptorRecord). Mirrors Database.LEGACY_DATABASE_NAME.
 */
const LEGACY_WORKSPACE_IDENTIFIER = 'standardnotes'

/**
 * Every workspace created since then is named by its ApplicationIdentifier, a canonical
 * 8-4-4-4-12 uuid from ApplicationGroup.createNewApplicationDescriptor. Version-agnostic on
 * purpose: the installed generator emits uuid v7 while the platform-crypto fallback and
 * older installs emit v4. Mirrors Database.WORKSPACE_DATABASE_NAME.
 */
const WORKSPACE_IDENTIFIER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Whether `key` is `<workspace identifier>-<known raw suffix>`. Scoped to the identifier
 * shapes this app generates, so `standardnotes-analytics` (a plausible foreign key in the
 * same letters) is NOT ours, exactly as `Database.isOwnDatabaseName` treats it.
 */
export function isWorkspaceNamespacedStorageKey(key: string): boolean {
  for (const suffix of WORKSPACE_NAMESPACED_RAW_KEY_SUFFIXES) {
    if (!key.endsWith(`-${suffix}`)) {
      continue
    }

    const identifier = key.slice(0, key.length - suffix.length - 1)
    if (identifier === LEGACY_WORKSPACE_IDENTIFIER || WORKSPACE_IDENTIFIER.test(identifier)) {
      return true
    }
  }

  return false
}

/**
 * Whether a `localStorage` key on this origin belongs to this application, by its own
 * naming schemes. Used to scope the remove-all-data sweep.
 */
export function isOwnStorageKey(key: string): boolean {
  if (OWN_STORAGE_KEYS.includes(key)) {
    return true
  }

  for (const prefix of OWN_STORAGE_KEY_PREFIXES) {
    if (key.startsWith(prefix) && key.length > prefix.length) {
      return true
    }
  }

  return isWorkspaceNamespacedStorageKey(key)
}

/** The read-only slice of the Web Storage API needed to enumerate keys. */
export type EnumerableStorage = Pick<Storage, 'length' | 'key'>

/**
 * Every key currently in `storage` that this application owns, plus the namespaced raw keys
 * of each `workspaceIdentifiers` entry.
 *
 * The caller's identifier list is AUTHORITATIVE and ADDITIVE, never restrictive: it comes
 * from the descriptor record, so an identifier that does not look like a uuid (a hand-edited
 * or very old descriptor) is still this app's workspace and its session blob must go. That
 * mirrors `Database.deleteAll`, which deletes every name the caller passed whatever its
 * shape. The listing sweep is what catches workspaces whose descriptor was already lost —
 * and it is the only thing that catches anything at all on the last-workspace sign-out,
 * where ApplicationGroup passes an EMPTY list (ApplicationGroup.onApplicationDeinit).
 */
export function ownStorageKeysIn(
  storage: EnumerableStorage,
  workspaceIdentifiers: ApplicationIdentifier[] = [],
): string[] {
  const callerKeys = new Set<string>()
  for (const identifier of workspaceIdentifiers) {
    for (const suffix of WORKSPACE_NAMESPACED_RAW_KEY_SUFFIXES) {
      callerKeys.add(namespacedKey(identifier, suffix))
    }
  }

  const keys = new Set<string>()
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)
    if (key != undefined && (isOwnStorageKey(key) || callerKeys.has(key))) {
      keys.add(key)
    }
  }

  return [...keys]
}
