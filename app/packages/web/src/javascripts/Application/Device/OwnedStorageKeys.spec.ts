/**
 * @jest-environment jsdom
 *
 * Standard Red Notes: which `localStorage` keys belong to THIS application.
 *
 * `isOwnStorageKey` is the whole safety boundary of the remove-all-data sweep, and it can
 * fail in two directions:
 *   - too broad  -> another application's localStorage on the same origin is destroyed
 *                   (the `localStorage.clear()` bug, twin of the `Database.deleteAll` one);
 *   - too narrow -> a credential survives a sign-out.
 *
 * So both tables below are load-bearing. OWN is every key family this app's production code
 * actually writes, taken from the declarations themselves (the comment on each gives the
 * writer). FOREIGN is what a real shared origin holds, including near misses that share an
 * opening with one of our namespaces — those are the cases a lazy `startsWith('sn')` or a
 * substring test would get wrong.
 */
import { readdirSync, readFileSync } from 'fs'
import { join, relative } from 'path'

import {
  isOwnStorageKey,
  isWorkspaceNamespacedStorageKey,
  ownStorageKeysIn,
  OWN_STORAGE_KEYS,
  OWN_STORAGE_KEY_PREFIXES,
  WORKSPACE_NAMESPACED_RAW_KEY_SUFFIXES,
} from './OwnedStorageKeys'

/** Every key family this app writes, with the module that writes it. */
const OWN = [
  // --- the device keychain and the workspace registry -----------------------------------
  'keychain', //                                   WebDevice KEYCHAIN_STORAGE_KEY
  'descriptors', //                                RawStorageKey.DescriptorRecord
  'home_server_enabled', //                        RawStorageKey.HomeServerEnabled
  'home_serve_data_location', //                   RawStorageKey.HomeServerDataLocation
  // --- per-workspace raw keys, namespacedKey(identifier, suffix) ------------------------
  'standardnotes-storage', //                      DiskStorageService.getPersistenceKey
  'standardnotes-snjs_version', //                 MigrationService.stampStoredVersion
  'standardnotes-storage_object_generation', //    DiskStorageService.getGenerationPersistenceKey
  'standardnotes-last_migration_timestamp', //     Migrations/Base.ts
  '018f3d2c-9a41-7b55-8e0d-6f2a1b3c4d5e-storage',
  '018f3d2c-9a41-7b55-8e0d-6f2a1b3c4d5e-snjs_version',
  'A1B2C3D4-1234-4321-ABCD-0123456789AB-storage_object_generation',
  // --- the sn- / sn_ families -----------------------------------------------------------
  'sn-language', //                                i18n LANGUAGE_STORAGE_KEY
  'sn-custom-themes', //                           CustomThemeManager LEGACY_CUSTOM_THEMES_STORAGE_KEY
  'sn-assistant-usage', //                         AssistantUsageService
  'sn-auto-empty-trash-interval-ms', //            AutoEmptyTrashService (legacy unscoped)
  'sn-auto-empty-trash-interval-ms:account-a', //  AutoEmptyTrashService (scoped)
  'sn-pdf-ocr-cache:v1:file-uuid', //              pdfOcr storageKeyFor
  'sn-super-tradingview-note-dismissed', //        TradingViewNode
  'sn_achievements_state', //                      AchievementsService
  'sn_achievements_config', //                     AchievementsService
  'sn_trusted_device_token', //                    trustedDeviceStorage + snjs ApiService
  'sn_shared_server_access_key', //                api SharedServerAccessKey
  'sn_item_restore_counts', //                     restoreCounter
  'sn_app_active_minutes', //                      AppUsageTimeTracker
  'sn_manual_sync_mode', //                        ManualSyncSetting
  'sn_strip_image_metadata_on_upload', //          StripImageMetadataSetting
  'sn_super_checklist_auto_move_completed', //     autoMoveSetting
  'sn_super_show_formatting_marks', //             formattingMarksSetting
  // --- the srn- / srn_ / __srn_ families ------------------------------------------------
  'srn-update-check-last-checked-at', //           UpdateCheckService
  'srn-update-check-last-status', //               UpdateCheckService
  'srn-storage-usage-snapshot-standardnotes', //   storageDisplay cacheKeyFor
  'srn_editor_tile_layout', //                     NoteGroupView
  'srn_new_tab_behavior', //                       newTabSettings
  'srn_tab_custom_names', //                       tabCustomNames
  'srn_folders_migrated_v1', //                    NavigationController folder migration flag
  '__srn_diagnostics_storage_probe__', //          Admin browserSection storage probe
  // --- the standardnotes. local-settings namespace (a DOT, not a hyphen) ----------------
  'standardnotes.sync-device-id.v1', //            WebApplication
  'standardnotes.contextualSearch.settings.v1',
  'standardnotes.deepResearch.settings.v1',
  'standardnotes.dictation.settings.v1',
  'standardnotes.narration.settings.v1',
  'standardnotes.narration.audio.v1',
  'standardnotes.assistantPersona.settings.v1',
  'standardnotes.assistantPersona.settings.v1.account-a', //  scopedStorageKey
  'standardnotes.assistantPersonaProfiles.settings.v1',
  'standardnotes.assistantSampling.settings.v2',
  'standardnotes.researchMode.settings.v1',
  'standardnotes.homeConfig.v1',
  'standardnotes.quickActions.v1',
  'standardnotes.note.layout.v1',
  'standardnotes.conflicts.ai.settings.v1',
  'standardnotes.notifications.read.v1',
  'standardnotes.notifications.settings.v1',
  'standardnotes.notifications.achievements.v1',
  'standardnotes.github.publish.settings.v1',
  'standardnotes.github.publish.token.v1',
  // --- the invite-realtime checkpoint store ---------------------------------------------
  'standard-red-notes:invite-realtime:v1:session-digest', // InviteRealtimeRawStorageCheckpointStore
  // --- the assistant families -----------------------------------------------------------
  'assistant-chat-tabs', //                        chatTabs legacy unscoped
  'assistant-chat-tabs:v1:account-a', //           chatTabs legacy scoped
  'assistant-chat-history:v1:account-a:tab-1', //  assistantChatHistory legacy
  'assistant-chat-history-deleted:v1:account-a:tab-1',
  'assistant-workspace-registry:v1:account-a', //  assistantWorkspaceRetention
  'assistant-workspace-retired:v1:workspace-a',
  'assistant-browsing-context-id:v1', //           chatTabs
  'assistant-context-scope', //                    assistantLocalSettings
  'assistant-data-exposure-notice-dismissed',
  'AssistantChatHistory:v1:account-a:tab-1', //    assistantChatHistory
  'AssistantChatTabs:v1:account-a', //             chatTabs
  // --- super editor + diary -------------------------------------------------------------
  'super-editor:recent-symbols', //                insertSymbol
  'DiaryMode.lastPromptedDate', //                 diaryService
  // --- ui-services' unprefixed keys -----------------------------------------------------
  'AnonymousUserId', //                            ui-services Storage/LocalStorage StorageKey
  'ShowBetaWarning',
  'ShowNoAccountWarning',
  'FilesNavigationEnabled',
  'master-persistence-key',
  'keyboardShortcutOverrides', //                  ui-services KeyboardShortcutOverrides
  // --- snjs 1.x leftovers (probed by Migrations/Base.ts, never deleted) -----------------
  'migrations',
  'ephemeral',
  'user',
  'cachedThemes',
  'syncToken',
  'encryptedStorage',
  'offlineParams',
  'auth_params',
  'last_migration_timestamp',
]

/**
 * What a real shared origin holds next to this app. The second half are NEAR MISSES: they
 * share an opening with one of this app's namespaces without being in it, so they are what
 * separates a namespace test from a substring test.
 */
const FOREIGN = [
  'vogue-homes-crm', //                 the operator's own separate application
  'vogue-homes-crm:auth',
  'firebaseLocalStorageDb',
  'keyval-store',
  'workbox-expiration',
  'i18nextLng',
  'ally-supports-cache',
  'loglevel:webpack-dev-server',
  'debug',
  // near misses
  'snowflake-config', //                'sn' but not 'sn-' / 'sn_'
  'sn', //                              the prefix letters with nothing after them
  'srn',
  'standardnotesclone', //              'standardnotes' but no separator
  'standardnotes-analytics', //         the 'standardnotes-' namespace WITHOUT a known suffix
  'standardnotes', //                   the workspace identifier is not itself a storage key
  'supercalendar:v1', //                'super' but not 'super-editor:'
  'assistantly-app', //                 'assistant' but not 'assistant-'
  'descriptorsOfSomethingElse', //      'descriptors' is an exact match only
  'userSettings', //                    so is 'user'
  'DiaryModeX', //                       'DiaryMode' needs its dot
  '018f3d2c-9a41-7b55-8e0d-6f2a1b3c4d5e-settings', // uuid, but not a suffix we write
  'redux-persist-storage', //           ends in '-storage', identifier is not ours
  // namespacedKey's separator is a HYPHEN, and the suffix must be at the END. These two sit
  // exactly where a `key.includes(suffix)` test would wrongly accept them: drop the hyphen
  // and the remainder in front of 'storage' is still the legacy name / a real uuid.
  'standardnotes_storage',
  '018f3d2c-9a41-7b55-8e0d-6f2a1b3c4d5e_storage',
  'vogue-homes-crm-sn-cache', //        CONTAINS 'sn-'; a prefix is not a substring test
  'prefix-018f3d2c-9a41-7b55-8e0d-6f2a1b3c4d5e-storage', // uuid embedded, not the identifier
  '018f3d2c-9a41-7b55-8e0d-6f2a1b3c4d5-storage', //  near-miss uuid (one hex short)
  '018f3d2c9a417b558e0d6f2a1b3c4d5e-storage', //     uuid without hyphens
  'zzzzzzzz-9a41-7b55-8e0d-6f2a1b3c4d5e-storage', // not hex
  '-storage', //                        empty identifier
  '',
]

describe('isOwnStorageKey', () => {
  it.each(OWN)('claims %p', (key) => {
    expect(isOwnStorageKey(key)).toBe(true)
  })

  it.each(FOREIGN)('leaves %p alone', (key) => {
    expect(isOwnStorageKey(key)).toBe(false)
  })

  it('has no key in both tables', () => {
    expect(OWN.filter((key) => FOREIGN.includes(key))).toEqual([])
  })

  it('declares every prefix with its separator, so no prefix can match a bare word', () => {
    for (const prefix of OWN_STORAGE_KEY_PREFIXES) {
      expect(prefix).toMatch(/[-_.:]$/)
      // A prefix on its own is not a key: there has to be something after the separator.
      expect(isOwnStorageKey(prefix)).toBe(false)
    }
  })

  it('matches an exact key only as the whole key', () => {
    const extended = OWN_STORAGE_KEYS.filter((key) => isOwnStorageKey(`${key}-of-another-app`))

    expect(OWN_STORAGE_KEYS.every((key) => isOwnStorageKey(key))).toBe(true)
    expect(extended).toEqual([])
  })
})

describe('isWorkspaceNamespacedStorageKey', () => {
  it.each(WORKSPACE_NAMESPACED_RAW_KEY_SUFFIXES)('accepts the legacy identifier with -%s', (suffix) => {
    expect(isWorkspaceNamespacedStorageKey(`standardnotes-${suffix}`)).toBe(true)
  })

  it.each(WORKSPACE_NAMESPACED_RAW_KEY_SUFFIXES)('accepts a generated uuid identifier with -%s', (suffix) => {
    expect(isWorkspaceNamespacedStorageKey(`018f3d2c-9a41-7b55-8e0d-6f2a1b3c4d5e-${suffix}`)).toBe(true)
  })

  it('rejects a suffix this app does not write', () => {
    expect(isWorkspaceNamespacedStorageKey('018f3d2c-9a41-7b55-8e0d-6f2a1b3c4d5e-settings')).toBe(false)
    expect(isWorkspaceNamespacedStorageKey('standardnotes-analytics')).toBe(false)
  })

  it('rejects an identifier that is neither the legacy name nor a uuid', () => {
    expect(isWorkspaceNamespacedStorageKey('a-legacy-custom-identifier-storage')).toBe(false)
    expect(isWorkspaceNamespacedStorageKey('my-standardnotes-storage')).toBe(false)
  })
})

describe('ownStorageKeysIn', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('returns only the keys present in the store', () => {
    localStorage.setItem('sn-language', 'en')
    localStorage.setItem('vogue-homes-crm', '{}')

    expect(ownStorageKeysIn(localStorage)).toEqual(['sn-language'])
  })

  it('adds the namespaced keys of a caller identifier the naming schemes cannot classify', () => {
    localStorage.setItem('a-legacy-custom-identifier-storage', '{}')
    localStorage.setItem('a-legacy-custom-identifier-snjs_version', '2.0.0')
    localStorage.setItem('vogue-homes-crm', '{}')

    expect(ownStorageKeysIn(localStorage, [])).toEqual([])
    expect(ownStorageKeysIn(localStorage, ['a-legacy-custom-identifier']).sort()).toEqual([
      'a-legacy-custom-identifier-snjs_version',
      'a-legacy-custom-identifier-storage',
    ])
  })

  it('never returns a key the caller’s identifier would produce but the store does not hold', () => {
    localStorage.setItem('vogue-homes-crm', '{}')

    expect(ownStorageKeysIn(localStorage, ['standardnotes', 'never-stored'])).toEqual([])
  })

  it('tolerates a sparse store whose key(index) returns null', () => {
    const sparse = { length: 2, key: (index: number) => (index === 0 ? 'sn-language' : null) }

    expect(ownStorageKeysIn(sparse)).toEqual(['sn-language'])
  })

  it('returns each key once even when the caller list repeats it', () => {
    localStorage.setItem('standardnotes-storage', '{}')

    expect(ownStorageKeysIn(localStorage, ['standardnotes', 'standardnotes'])).toEqual(['standardnotes-storage'])
  })
})

/**
 * The regression tripwire for this whole class of defect: an unscoped Web Storage `clear()`
 * anywhere in production code. Specs legitimately call it (jsdom's store is theirs alone),
 * so only non-spec sources are swept.
 */
describe('no production code clears Web Storage wholesale', () => {
  const PACKAGES_ROOT = join(__dirname, '..', '..', '..', '..', '..')
  const SWEPT_ROOTS = [
    join(PACKAGES_ROOT, 'web', 'src'),
    join(PACKAGES_ROOT, 'ui-services', 'src'),
    join(PACKAGES_ROOT, 'api', 'src'),
  ]
  const WHOLESALE_CLEAR = /\b(?:localStorage|sessionStorage)\s*\.\s*clear\s*\(/

  const sourceFiles = (dir: string): string[] => {
    const found: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        found.push(...sourceFiles(path))
      } else if (/\.(ts|tsx|js)$/.test(entry.name) && !/\.(spec|test)\.(ts|tsx)$/.test(entry.name)) {
        found.push(path)
      }
    }
    return found
  }

  it('finds no localStorage.clear() / sessionStorage.clear() outside specs', () => {
    const offenders: string[] = []

    for (const root of SWEPT_ROOTS) {
      for (const file of sourceFiles(root)) {
        const source = readFileSync(file, 'utf8')
        for (const [index, line] of source.split('\n').entries()) {
          // Skip prose: these modules document the defect they fixed.
          if (/^\s*(?:\*|\/\/)/.test(line)) {
            continue
          }
          if (WHOLESALE_CLEAR.test(line)) {
            offenders.push(`${relative(PACKAGES_ROOT, file)}:${index + 1}`)
          }
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it('actually reads the sources it sweeps', () => {
    // A sweep over an empty file list would pass vacuously, which is the shape that makes a
    // gate look like a gate without being one.
    const counted = SWEPT_ROOTS.reduce((total, root) => total + sourceFiles(root).length, 0)
    expect(counted).toBeGreaterThan(500)
  })
})
