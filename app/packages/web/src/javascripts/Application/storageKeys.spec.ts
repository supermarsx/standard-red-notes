import { AvatarStorageKey } from '@/Avatar/avatarCore'
import { DiaryLastPromptedKey, DiarySettingsKey } from '@/Diary/diaryService'
import { TimeZoneSettingKey } from '@/Timezone/timezoneService'
import { AppLockPasskeyStorageKey } from '@/AppLockPasskey/appLockPasskey'
import { LANGUAGE_STORAGE_KEY } from '@/Internationalization/i18n'
import { ASSISTANT_CHAT_TABS_LEGACY_KEY_PREFIX, ASSISTANT_CHAT_TABS_STORAGE_KEY_PREFIX } from '@/Assistant/chatTabs'
import {
  ASSISTANT_CHAT_HISTORY_DELETION_KEY_PREFIX,
  ASSISTANT_CHAT_HISTORY_LEGACY_KEY_PREFIX,
  ASSISTANT_CHAT_HISTORY_STORAGE_KEY_PREFIX,
} from '@/Assistant/assistantChatHistory'
import { ASSISTANT_CONTEXT_SCOPE_KEY, ASSISTANT_DATA_EXPOSURE_NOTICE_KEY } from '@/Assistant/assistantLocalSettings'
import { LEGACY_CUSTOM_THEMES_STORAGE_KEY } from '@/Components/Preferences/Panes/Appearance/CustomThemes/CustomThemeManager'

/**
 * Standard Red Notes: storage-key registry & uniqueness guard.
 *
 * The fork stores a lot of web-local settings under two mechanisms:
 *
 *  - APP-KV via `application.getValue` / `application.setValue` — device-local,
 *    and (critically) these THROW "before loading local storage" if read during
 *    the launch sequence. Each such getter must defend itself (see the
 *    safe-read specs in each service's *.spec.ts).
 *
 *  - `window.localStorage` — device-local, never throws on read but can return
 *    junk; every reader normalizes / try-catches.
 *
 * This spec is the single place that enumerates EVERY fork-owned key string so a
 * collision (two unrelated features writing the same key, clobbering each other)
 * or an accidental rename can never slip in silently. It also cross-checks the
 * exported key CONSTANTS against the literal registry, so renaming a constant
 * without updating the registry (or vice versa) fails loudly here.
 */

/**
 * APP-KV keys (read/written via `application.getValue`/`setValue`). DEVICE-LOCAL,
 * NOT synced. These are the keys whose early read can throw the "before loading
 * local storage" error — the dangerous class this audit targets.
 */
const APP_KV_KEYS = {
  Diary: 'DiaryMode',
  Avatar: 'ProfileAvatar',
  Timezone: 'PreferredTimeZone',
  AppLockPasskey: 'AppLockPasskey',
  AssistantChatTabs: 'AssistantChatTabs:v1',
  AssistantChatHistory: 'AssistantChatHistory:v1',
} as const

/**
 * `window.localStorage` keys owned by the fork's web-local features. DEVICE-LOCAL,
 * NOT synced. (Upstream snjs-managed raw storage keys like `keychain` are out of
 * scope — those are not fork settings.)
 */
const LOCAL_STORAGE_KEYS = {
  DiaryLastPrompted: 'DiaryMode.lastPromptedDate',
  LegacyCustomThemes: 'sn-custom-themes',
  StripImageMetadata: 'sn_strip_image_metadata_on_upload',
  ManualSyncMode: 'sn_manual_sync_mode',
  AutoEmptyTrashInterval: 'sn-auto-empty-trash-interval-ms',
  Language: 'sn-language',
  HomeConfig: 'standardnotes.homeConfig.v1',
  QuickActions: 'standardnotes.quickActions.v1',
  ContextualSearch: 'standardnotes.contextualSearch.settings.v1',
  Narration: 'standardnotes.narration.settings.v1',
  Dictation: 'standardnotes.dictation.settings.v1',
  DeepResearch: 'standardnotes.deepResearch.settings.v1',
  ConflictsAi: 'standardnotes.conflicts.ai.settings.v1',
  GithubPublishSettings: 'standardnotes.github.publish.settings.v1',
  GithubPublishToken: 'standardnotes.github.publish.token.v1',
  AssistantUsage: 'sn-assistant-usage',
  LegacyAssistantChatTabs: 'assistant-chat-tabs:v1',
  LegacyAssistantChatHistory: 'assistant-chat-history:v1',
  AssistantChatHistoryDeletion: 'assistant-chat-history-deleted:v1',
  AssistantContextScope: 'assistant-context-scope',
  AssistantDataExposureDismissed: 'assistant-data-exposure-notice-dismissed',
  TrustedDeviceToken: 'sn_trusted_device_token',
  SuperChecklistAutoMove: 'sn_super_checklist_auto_move_completed',
  TradingViewNoteDismissed: 'sn-super-tradingview-note-dismissed',
  FoldersMigratedFlag: 'srn_folders_migrated_v1',
  PdfOcrCachePrefix: 'sn-pdf-ocr-cache',
} as const

const collectDuplicates = (values: string[]): string[] => {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) {
      dupes.add(value)
    }
    seen.add(value)
  }
  return [...dupes]
}

describe('storage key registry — uniqueness', () => {
  it('has no duplicate app-KV keys', () => {
    expect(collectDuplicates(Object.values(APP_KV_KEYS))).toEqual([])
  })

  it('has no duplicate localStorage keys', () => {
    expect(collectDuplicates(Object.values(LOCAL_STORAGE_KEYS))).toEqual([])
  })

  it('does not collide an app-KV key with a localStorage key', () => {
    const all = [...Object.values(APP_KV_KEYS), ...Object.values(LOCAL_STORAGE_KEYS)]
    expect(collectDuplicates(all)).toEqual([])
  })

  it('keeps the Diary settings key (app-KV) distinct from its localStorage dedupe marker', () => {
    // Same feature, two different stores: the enable flag/time lives in app-KV;
    // the once-a-day dedupe marker lives in localStorage. They must NOT share a key.
    expect(APP_KV_KEYS.Diary).not.toBe(LOCAL_STORAGE_KEYS.DiaryLastPrompted)
  })
})

describe('storage key registry — exported constants match the registry', () => {
  it('app-KV key constants equal their registry values', () => {
    expect(DiarySettingsKey).toBe(APP_KV_KEYS.Diary)
    expect(AvatarStorageKey).toBe(APP_KV_KEYS.Avatar)
    expect(TimeZoneSettingKey).toBe(APP_KV_KEYS.Timezone)
    expect(AppLockPasskeyStorageKey).toBe(APP_KV_KEYS.AppLockPasskey)
    expect(ASSISTANT_CHAT_TABS_STORAGE_KEY_PREFIX).toBe(APP_KV_KEYS.AssistantChatTabs)
    expect(ASSISTANT_CHAT_HISTORY_STORAGE_KEY_PREFIX).toBe(APP_KV_KEYS.AssistantChatHistory)
  })

  it('localStorage key constants equal their registry values', () => {
    expect(DiaryLastPromptedKey).toBe(LOCAL_STORAGE_KEYS.DiaryLastPrompted)
    expect(LANGUAGE_STORAGE_KEY).toBe(LOCAL_STORAGE_KEYS.Language)
    expect(ASSISTANT_CHAT_TABS_LEGACY_KEY_PREFIX).toBe(LOCAL_STORAGE_KEYS.LegacyAssistantChatTabs)
    expect(ASSISTANT_CHAT_HISTORY_LEGACY_KEY_PREFIX).toBe(LOCAL_STORAGE_KEYS.LegacyAssistantChatHistory)
    expect(ASSISTANT_CHAT_HISTORY_DELETION_KEY_PREFIX).toBe(LOCAL_STORAGE_KEYS.AssistantChatHistoryDeletion)
    expect(ASSISTANT_CONTEXT_SCOPE_KEY).toBe(LOCAL_STORAGE_KEYS.AssistantContextScope)
    expect(ASSISTANT_DATA_EXPOSURE_NOTICE_KEY).toBe(LOCAL_STORAGE_KEYS.AssistantDataExposureDismissed)
    expect(LEGACY_CUSTOM_THEMES_STORAGE_KEY).toBe(LOCAL_STORAGE_KEYS.LegacyCustomThemes)
  })

  it('the diary localStorage marker is namespaced under the diary app-KV key', () => {
    // Documents the intentional prefix relationship without it being a collision.
    expect(DiaryLastPromptedKey.startsWith(`${DiarySettingsKey}.`)).toBe(true)
  })
})

export { APP_KV_KEYS, LOCAL_STORAGE_KEYS }
