// Pure, React-free helpers for the Storage pane: friendly content-type labels and
// the localStorage snapshot cache that lets the pane render the last result
// instantly on reopen while a fresh background scan runs.

import { StorageUsageSnapshot } from '@/Utils/Storage/storageUsageWorkerProtocol'

/** Map raw content_type strings to friendly display labels. Unknowns pass through. */
const CONTENT_TYPE_LABELS: Record<string, string> = {
  Note: 'Notes',
  Tag: 'Tags',
  'SN|File': 'Files',
  'SN|FileSafe|FileMetadata': 'File metadata',
  'SN|Component': 'Components',
  'SN|Theme': 'Themes',
  'SN|ItemsKey': 'Encryption keys',
  'SN|UserPreferences': 'Preferences',
  'SN|SmartTag': 'Smart views',
  SmartView: 'Smart views',
  'SN|Privileges': 'Privileges',
  'SN|ExtensionRepo': 'Plugin repos',
  Unknown: 'Other',
  Folder: 'Folders',
  'SN|AssistantChat': 'Assistant conversations',
  'SN|PrivateComment': 'Private comments',
  'SN|TrustedContact': 'Trusted contacts',
  'SN|KeySystemRootKey': 'Vault root keys',
  'SN|KeySystemItemsKey': 'Vault item keys',
  'SN|VaultListing': 'Vault information',
  'SN|RootKey|NoSync': 'Local root key',
  'SN|EncryptedStorage': 'Encrypted app storage',
  'SN|Editor': 'Editors',
  Extension: 'Action extensions',
  'SN|HistorySession': 'History sessions',
  'SN|FileSafe|Credentials': 'FileSafe credentials',
  'SN|FileSafe|Integration': 'FileSafe integrations',
  'SF|Item': 'Plugin data',
}

const CONTENT_TYPE_DESCRIPTIONS: Record<string, string> = {
  Note: 'Your note content, titles and saved note settings.',
  Tag: 'Labels used to organize notes and their associations.',
  Folder: 'Folders and their hierarchy for organizing notes.',
  'SN|AssistantChat': 'Saved AI conversations and their conversation data. This is separate from your notes.',
  'SN|PrivateComment': 'Comments saved privately for your own account.',
  'SN|TrustedContact': 'Contact identities and public-key information used for secure sharing.',
  'SN|KeySystemRootKey': 'Root encryption-key records for vaults and shared key systems.',
  'SN|KeySystemItemsKey': 'Encryption-key records used to protect items within a vault.',
  'SN|VaultListing': 'Vault names, membership references and other vault information.',
  'SN|ItemsKey': 'Encryption keys used to protect your saved items.',
  'SN|RootKey|NoSync': 'A local root-key record that is not synced as a regular item.',
  'SN|EncryptedStorage': 'Encrypted internal app data and saved state.',
  'SN|UserPreferences': 'Your synced account preferences and app settings.',
  'SN|File': 'Attachment records, including file names and metadata. File bytes can be stored separately.',
  'SN|FileSafe|FileMetadata': 'Metadata for files managed through the older FileSafe system.',
  'SN|FileSafe|Credentials': 'Protected credentials for FileSafe storage connections.',
  'SN|FileSafe|Integration': 'Configuration for connected FileSafe storage services.',
  'SN|SmartTag': 'Saved filters and rules that build smart views of your notes.',
  SmartView: 'Saved filters and rules that build smart views of your notes.',
  'SN|Component': 'Installed plugin and component configuration.',
  'SN|Editor': 'Installed editor definitions and configuration.',
  'SN|Theme': 'Installed theme definitions and appearance configuration.',
  Extension: 'Configuration for extensions that act on your notes.',
  'SN|ExtensionRepo': 'Sources used to discover and install plugins.',
  'SN|Privileges': 'Stored access permissions and application privileges.',
  'SN|HistorySession': 'Records that group saved note changes into history sessions.',
  'SF|Item': 'Data saved by a plugin or integration.',
  Unknown: 'Stored items whose original type could not be identified.',
}

export function contentTypeLabel(contentType: string): string {
  return CONTENT_TYPE_LABELS[contentType] ?? contentType
}

export function contentTypeDescription(contentType: string): string {
  return (
    CONTENT_TYPE_DESCRIPTIONS[contentType] ??
    'Data saved by the app or an installed extension. The stored type is shown for reference.'
  )
}

/** Raw content_type strings, so the pane can match without importing snjs enums. */
export const NOTE_CONTENT_TYPE = 'Note'
export const FILE_CONTENT_TYPE = 'SN|File'

/** Percent (0–100) of `bytes` out of `total`, 0 when total is 0. */
export function percentOf(bytes: number, total: number): number {
  if (total <= 0) {
    return 0
  }
  return (bytes / total) * 100
}

// Cache key is namespaced by the workspace identifier so multiple workspaces on the
// same origin don't clobber each other's last snapshot.
const CACHE_PREFIX = 'srn-storage-usage-snapshot-'

export function cacheKeyFor(databaseName: string): string {
  return `${CACHE_PREFIX}${databaseName}`
}

/** Persist the last completed snapshot so reopening the pane is instant. */
export function saveCachedSnapshot(databaseName: string, snapshot: StorageUsageSnapshot): void {
  try {
    localStorage.setItem(cacheKeyFor(databaseName), JSON.stringify(snapshot))
  } catch {
    /* storage full / unavailable — caching is best-effort */
  }
}

/** Read the last cached snapshot, or undefined if none / unreadable. */
export function loadCachedSnapshot(databaseName: string): StorageUsageSnapshot | undefined {
  try {
    const raw = localStorage.getItem(cacheKeyFor(databaseName))
    if (!raw) {
      return undefined
    }
    const parsed = JSON.parse(raw) as StorageUsageSnapshot
    if (parsed && typeof parsed.totalBytes === 'number' && Array.isArray(parsed.buckets)) {
      // Backfill `sources` for snapshots cached by an older pane version so the
      // breakdown still renders something rather than throwing.
      if (!Array.isArray(parsed.sources)) {
        parsed.sources = []
      }
      return parsed
    }
    return undefined
  } catch {
    return undefined
  }
}
