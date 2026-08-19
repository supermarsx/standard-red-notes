import { CollectionSortProperty } from '../../Runtime/Collection/CollectionSort'
import { SystemViewId } from '../SmartView'
import { TagPreferences } from '../Tag'
import { NewNoteTitleFormat } from './NewNoteTitleFormat'
import { EditorLineHeight } from './EditorLineHeight'
import { EditorLineWidth } from './EditorLineWidth'
import { EditorFontSize } from './EditorFontSize'
import { SuperToolbarIconSize } from './SuperToolbarIconSize'
import { AllComponentPreferences } from './ComponentPreferences'
import { BlockTypeKey, TypographyProfile } from './TypographyProfile'

/**
 * Versioned, encrypted account preference for the base appearance selection.
 * Device-local appearance keys remain the launch/offline cache; this aggregate
 * is the sync authority once UserPrefs has loaded.
 */
export const CurrentUserAppearancePreferenceVersion = 1

export type UserAppearanceColorSchemeMode = 'manual' | 'auto' | 'light' | 'dark'

export type UserAppearancePreference = {
  version: typeof CurrentUserAppearancePreferenceVersion
  colorSchemeMode: UserAppearanceColorSchemeMode
  activeThemes: string[]
}

const MaximumUserAppearanceThemeCount = 32
const MaximumUserAppearanceThemeIdentifierLength = 256

export function isFutureUserAppearancePreference(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const version = (value as { version?: unknown }).version
  return (
    typeof version === 'number' && Number.isSafeInteger(version) && version > CurrentUserAppearancePreferenceVersion
  )
}

/**
 * Normalize the current schema into a bounded, safe value. Future schemas are
 * deliberately left untouched so an older client can never downgrade them.
 * A malformed v1 value is repaired to the dark-first defaults instead of
 * permanently wedging appearance reconciliation.
 */
export function normalizeUserAppearancePreference(value: unknown): UserAppearancePreference | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }

  const candidate = value as Partial<UserAppearancePreference>
  if (candidate.version !== CurrentUserAppearancePreferenceVersion) {
    return undefined
  }

  const colorSchemeMode = candidate.colorSchemeMode
  const isColorSchemeMode =
    colorSchemeMode === 'manual' ||
    colorSchemeMode === 'auto' ||
    colorSchemeMode === 'light' ||
    colorSchemeMode === 'dark'

  const activeThemes: string[] = []
  if (Array.isArray(candidate.activeThemes)) {
    const seen = new Set<string>()
    for (const rawIdentifier of candidate.activeThemes) {
      if (typeof rawIdentifier !== 'string') {
        continue
      }

      const identifier = rawIdentifier.trim()
      if (
        identifier.length === 0 ||
        identifier.length > MaximumUserAppearanceThemeIdentifierLength ||
        seen.has(identifier)
      ) {
        continue
      }

      seen.add(identifier)
      activeThemes.push(identifier)
      if (activeThemes.length === MaximumUserAppearanceThemeCount) {
        break
      }
    }
  }

  return {
    version: CurrentUserAppearancePreferenceVersion,
    colorSchemeMode: isColorSchemeMode ? colorSchemeMode : 'dark',
    activeThemes,
  }
}

export enum PrefKey {
  TagsPanelWidth = 'tagsPanelWidth',
  NotesPanelWidth = 'notesPanelWidth',
  EditorWidth = 'editorWidth',
  EditorLeft = 'editorLeft',
  EditorSpellcheck = 'spellcheck',
  EditorResizersEnabled = 'marginResizersEnabled',
  SortNotesBy = 'sortBy',
  SortNotesReverse = 'sortReverse',
  NotesShowArchived = 'showArchived',
  NotesShowTrashed = 'showTrashed',
  NotesHideProtected = 'hideProtected',
  NotesHidePinned = 'hidePinned',
  NotesHideNotePreview = 'hideNotePreview',
  NotesHideDate = 'hideDate',
  NotesHideTags = 'hideTags',
  NotesHideEditorIcon = 'hideEditorIcon',
  NoteAddToParentFolders = 'noteAddToParentFolders',
  NewNoteTitleFormat = 'newNoteTitleFormat',
  CustomNoteTitleFormat = 'customNoteTitleFormat',
  UpdateSavingStatusIndicator = 'updateSavingStatusIndicator',
  DefaultEditorIdentifier = 'defaultEditorIdentifier',
  MomentsDefaultTagUuid = 'momentsDefaultTagUuid',
  ClipperDefaultTagUuid = 'clipperDefaultTagUuid',
  SystemViewPreferences = 'systemViewPreferences',
  SuperNoteExportFormat = 'superNoteExportFormat',
  SuperNoteExportEmbedBehavior = 'superNoteExportEmbedBehavior',
  SuperNoteExportUseMDFrontmatter = 'superNoteExportUseMDFrontmatter',
  SuperNoteExportPDFPageSize = 'superNoteExportPDFPageSize',
  SuperNoteImageAlignment = 'superNoteImageAlignment',
  EditorFontFamily = 'editorFontFamily',
  AuthenticatorNames = 'authenticatorNames',
  PaneGesturesEnabled = 'paneGesturesEnabled',
  UserAppearance = 'userAppearance',
  ComponentPreferences = 'componentPreferences',
  ActiveComponents = 'activeComponents',
  AlwaysShowSuperToolbar = 'alwaysShowSuperToolbar',
  // Standard Red Notes: size of the Super (Lexical) editor ribbon toolbar icons.
  // Defaults to the (slightly smaller) Small; Medium restores the previous size
  // and Large makes them bigger for easier tap targets.
  SuperToolbarIconSize = 'superToolbarIconSize',
  AssistantProvider = 'assistantProvider',
  AssistantModel = 'assistantModel',
  AssistantConfirmBeforeWrite = 'assistantConfirmBeforeWrite',
  /**
   * Controls which assistant tool calls may run without an inline approval.
   * `allow-read` preserves the historical default: reads run immediately while
   * every write waits for the user. `bypass` skips assistant confirmation UI,
   * but does not weaken account, context, vault, or tool validation boundaries.
   */
  AssistantToolPermissionMode = 'assistantToolPermissionMode',
  AssistantConnectionMode = 'assistantConnectionMode',
  AssistantBaseUrl = 'assistantBaseUrl',
  AssistantApiKey = 'assistantApiKey',
  // OpenAI Codex / ChatGPT subscription auth mode (Direct connection).
  AssistantAuthMode = 'assistantAuthMode',
  AssistantSubscriptionToken = 'assistantSubscriptionToken',
  AssistantExtraHeaders = 'assistantExtraHeaders',
  AssistantSelectionActions = 'assistantSelectionActions',
  AssistantPanelWidth = 'assistantPanelWidth',
  AiPoweredSearchEnabled = 'aiPoweredSearchEnabled',
  ConstellationPosition = 'constellationPosition',
  AddImportsToTag = 'addImportsToTag',
  AlwaysCreateNewTagForImports = 'alwaysCreateNewTagForImports',
  ExistingTagForImports = 'existingTagForImports',
  // Standard Red Notes: how sync conflicts (conflicted copies) should be resolved.
  // 'ask' surfaces them in the Conflicts pane; the others auto-resolve when
  // ConflictResolutionAutoResolve is enabled. The client pref takes precedence over
  // the server-provided CONFLICT_RESOLUTION_STRATEGY default.
  ConflictResolutionStrategy = 'conflictResolutionStrategy',
  ConflictResolutionAutoResolve = 'conflictResolutionAutoResolve',
  // Standard Red Notes: client-side full-text search index configuration.
  // SearchIndexEnabled toggles the fast inverted-index search path (with substring
  // fallback when off). SearchQueryCacheSize bounds the LRU of recent query
  // results. SearchMinQueryLength is the minimum query length before the index is
  // consulted (shorter queries fall back to substring search). The client prefs
  // take precedence over the server-provided SEARCH_INDEX_ENABLED default.
  SearchIndexEnabled = 'searchIndexEnabled',
  SearchQueryCacheSize = 'searchQueryCacheSize',
  SearchMinQueryLength = 'searchMinQueryLength',
  // MaxIndexedBodyLength caps how many characters of each note's body are fed into
  // the Tier-2 BM25 index (wired to SearchIndex's maxTextLengthPerNote) so a huge
  // 500KB note can't dump enormous token/text into the index. MaxIndexedNotes is a
  // ceiling on the displayable-note count above which the full Tier-2 index build
  // is skipped entirely (Tier-1 substring/preview search still works), so a very
  // large account never triggers the OOM-prone full build.
  MaxIndexedBodyLength = 'maxIndexedBodyLength',
  MaxIndexedNotes = 'maxIndexedNotes',
  // Standard Red Notes: ceiling on the off-main-thread decryption worker pool.
  // 0 == "auto" (the pool picks hardwareConcurrency - 1, spawning lazily so small
  // vaults never pay the per-worker libsodium-WASM init tax). A value > 0 caps the
  // pool at min(value, hardwareConcurrency), letting power users dedicate the full
  // thread count to cold-loading a large vault.
  MaxDecryptionWorkers = 'maxDecryptionWorkers',
  // Standard Red Notes: a capped, most-recent-first history of notes the user has
  // opened, persisted as a JSON array of { uuid, openedAt } entries. Surfaced in
  // the "Recent Notes" preferences pane. Stored as a pref so it follows the user
  // across reloads and devices.
  RecentNotesHistory = 'recentNotesHistory',
  // Standard Red Notes: explicit user-defined ("custom") manual orderings, each
  // stored as an array of item uuids. These drive ordering when the Custom sort
  // mode is selected, and are rewritten when the user drags to reorder.
  // CustomNotesOrder is a single global notes order (v1 scope — not per
  // folder/tag context). CustomFoldersOrder / CustomTagsOrder order the
  // navigation sidebar's root-level folders and tags respectively.
  CustomNotesOrder = 'customNotesOrder',
  CustomFoldersOrder = 'customFoldersOrder',
  CustomTagsOrder = 'customTagsOrder',
  // Standard Red Notes: user-configured maximum local storage usage in BYTES.
  // 0 == Unlimited (usage is measured against the browser's quota estimate
  // instead). This is a SOFT, advisory limit surfaced in the Storage preferences
  // pane and via a warning toast — saving and syncing are never blocked by it.
  StorageMaxUsageBytes = 'storageMaxUsageBytes',
  // Standard Red Notes: self-hosted "Check for updates". UpdateCheckAutoEnabled
  // gates ALL automatic checks; UpdateCheckInterval selects how often they run
  // ('never' has the same effect as the toggle being off). These two prefs sync
  // across devices; the LAST-CHECKED timestamp deliberately does NOT — it lives
  // in device-local storage so each device checks independently.
  UpdateCheckAutoEnabled = 'updateCheckAutoEnabled',
  UpdateCheckInterval = 'updateCheckInterval',
  // Standard Red Notes: whether the "What's New" entry (release notes/changelog)
  // is shown in the Preferences menu. Defaults OFF — the section stays hidden
  // (including its unread-changelog badge and auto-open behavior) until the user
  // enables it via Preferences → General → Updates.
  ShowWhatsNewSection = 'showWhatsNewSection',
  // Standard Red Notes: per-account typography profiles for the Super editor.
  // TypographyProfiles is the full set of named profiles (always includes the
  // built-in Default). ActiveTypographyProfileId selects which one is compiled to
  // the injected <style> and applied to the editor / read-only / preview views.
  // Both are synced (per-account, not per-note); the active profile's contents
  // are the *defaults* for block spacing/indent — a per-block manual override
  // (#77 inline style) always wins by the cascade.
  TypographyProfiles = 'typographyProfiles',
  ActiveTypographyProfileId = 'activeTypographyProfileId',
  // Standard Red Notes: the user's custom display order for the Super editor's
  // block-style gallery squares, as an ordered list of gallery block-type keys.
  // An empty array (the default) means "use the built-in code default order"
  // (GALLERY_BLOCKS). Unknown/stale keys are ignored on read and any block styles
  // added after the user last reordered are appended at the end, so the stored
  // value is forward/backward compatible and never needs migrating.
  BlockStyleGalleryOrder = 'blockStyleGalleryOrder',
  // Standard Red Notes: the Todos general view's filter bar state (search text,
  // folder/tag selection, source, due bucket, hide-completed, and sort order).
  // Stored as a pref so filters follow the user across reloads AND devices,
  // matching how the notes list persists its own display filters
  // (NotesShowArchived / NotesHidePinned / SortNotesBy).
  TodoFilters = 'todoFilters',
  DEPRECATED_ActiveThemes = 'activeThemes',
  DEPRECATED_UseSystemColorScheme = 'useSystemColorScheme',
  DEPRECATED_UseTranslucentUI = 'useTranslucentUI',
  DEPRECATED_AutoLightThemeIdentifier = 'autoLightThemeIdentifier',
  DEPRECATED_AutoDarkThemeIdentifier = 'autoDarkThemeIdentifier',
  DEPRECATED_EditorMonospaceEnabled = 'monospaceFont',
  DEPRECATED_EditorLineHeight = 'editorLineHeight',
  DEPRECATED_EditorLineWidth = 'editorLineWidth',
  DEPRECATED_EditorFontSize = 'editorFontSize',
}

/**
 * Standard Red Notes: the configurable default strategy for resolving sync
 * conflicts. `ask` always defers to the user via the Conflicts pane. The others
 * describe what to do when auto-resolution is enabled.
 */
export type ConflictResolutionStrategyValue = 'ask' | 'keepBoth' | 'keepLocal' | 'keepRemote'

/**
 * Standard Red Notes: a single entry in the recently-opened-notes history. `uuid`
 * references the opened note; `openedAt` is the epoch-millisecond timestamp of the
 * most recent open. Entries are stored most-recent-first and capped client-side.
 */
export type RecentNoteEntry = {
  uuid: string
  openedAt: number
}

export const CurrentTodoFiltersPreferenceVersion = 1

/**
 * Standard Red Notes: the persisted filter state of the Todos general view.
 *
 * A todo carries no topic/category/folder of its own, so the taxonomy dimension
 * is `tagUuids` — the SOURCE NOTE's tags, which nest and which this app's UI
 * calls Folders. `source` selects Super checklists vs Advanced Checklist notes,
 * and `due` buckets by deadline independently of completion so `hideCompleted`
 * composes with it rather than overlapping.
 *
 * This value SYNCS, so a client can meet a value written by an older or newer
 * version of itself. Consumers must treat every field as untrusted and
 * normalize before use rather than reading it straight.
 */
export type TodoFiltersPreference = {
  version: typeof CurrentTodoFiltersPreferenceVersion
  query: string
  tagUuids: string[]
  source: 'all' | 'super' | 'advanced-checklist'
  due: 'all' | 'overdue' | 'due-soon' | 'scheduled' | 'unscheduled'
  hideCompleted: boolean
  sortBy: 'due' | 'todo' | 'note' | 'status'
  sortReverse: boolean
}

/** Show everything, nearest deadline first — a first run never opens filtered. */
export const DefaultTodoFiltersPreference: TodoFiltersPreference = {
  version: CurrentTodoFiltersPreferenceVersion,
  query: '',
  tagUuids: [],
  source: 'all',
  due: 'all',
  hideCompleted: false,
  sortBy: 'due',
  sortReverse: false,
}

/**
 * Standard Red Notes: how often the client automatically checks the
 * self-hosted server's /v1/updates/status endpoint. 'every-load' checks on
 * every app launch; 'never' disables automatic checks (equivalent to turning
 * the UpdateCheckAutoEnabled toggle off — both are honored).
 */
export type UpdateCheckIntervalValue =
  | 'every-load'
  | 'every-hour'
  | 'every-6-hours'
  | 'every-12-hours'
  | 'every-day'
  | 'every-3-days'
  | 'every-week'
  | 'every-2-weeks'
  | 'every-month'
  | 'every-3-months'
  | 'every-6-months'
  | 'every-year'
  | 'never'

export type PrefValue = {
  [PrefKey.TagsPanelWidth]: number
  [PrefKey.NotesPanelWidth]: number
  [PrefKey.AssistantPanelWidth]: number
  [PrefKey.ConstellationPosition]: 'right' | 'left' | 'bottom'
  [PrefKey.EditorWidth]: number | null
  [PrefKey.EditorLeft]: number | null
  [PrefKey.EditorSpellcheck]: boolean
  [PrefKey.EditorResizersEnabled]: boolean
  [PrefKey.SortNotesBy]: CollectionSortProperty
  [PrefKey.SortNotesReverse]: boolean
  [PrefKey.NotesShowArchived]: boolean
  [PrefKey.NotesShowTrashed]: boolean
  [PrefKey.NotesHidePinned]: boolean
  [PrefKey.NotesHideProtected]: boolean
  [PrefKey.NotesHideNotePreview]: boolean
  [PrefKey.NotesHideDate]: boolean
  [PrefKey.NotesHideTags]: boolean
  [PrefKey.NotesHideEditorIcon]: boolean
  [PrefKey.DEPRECATED_ActiveThemes]: string[]
  [PrefKey.DEPRECATED_UseSystemColorScheme]: boolean
  [PrefKey.DEPRECATED_UseTranslucentUI]: boolean
  [PrefKey.DEPRECATED_AutoLightThemeIdentifier]: string
  [PrefKey.DEPRECATED_AutoDarkThemeIdentifier]: string
  [PrefKey.NoteAddToParentFolders]: boolean
  [PrefKey.NewNoteTitleFormat]: NewNoteTitleFormat
  [PrefKey.CustomNoteTitleFormat]: string
  [PrefKey.DEPRECATED_EditorMonospaceEnabled]: boolean
  [PrefKey.DEPRECATED_EditorLineHeight]: EditorLineHeight
  [PrefKey.DEPRECATED_EditorLineWidth]: EditorLineWidth
  [PrefKey.DEPRECATED_EditorFontSize]: EditorFontSize
  [PrefKey.UpdateSavingStatusIndicator]: boolean
  [PrefKey.DefaultEditorIdentifier]: string
  [PrefKey.MomentsDefaultTagUuid]: string | undefined
  [PrefKey.ClipperDefaultTagUuid]: string | undefined
  [PrefKey.SystemViewPreferences]: Partial<Record<SystemViewId, TagPreferences>>
  [PrefKey.SuperNoteExportFormat]: 'json' | 'md' | 'html' | 'pdf' | 'docx' | 'odt'
  [PrefKey.SuperNoteExportEmbedBehavior]: 'reference' | 'inline' | 'separate'
  [PrefKey.SuperNoteExportUseMDFrontmatter]: boolean
  [PrefKey.SuperNoteExportPDFPageSize]: 'A3' | 'A4' | 'LETTER' | 'LEGAL' | 'TABLOID'
  [PrefKey.AuthenticatorNames]: string
  [PrefKey.PaneGesturesEnabled]: boolean
  [PrefKey.UserAppearance]: UserAppearancePreference
  [PrefKey.ComponentPreferences]: AllComponentPreferences
  [PrefKey.ActiveComponents]: string[]
  [PrefKey.AlwaysShowSuperToolbar]: boolean
  [PrefKey.SuperToolbarIconSize]: SuperToolbarIconSize
  [PrefKey.AssistantProvider]: string
  [PrefKey.AssistantModel]: string
  [PrefKey.AssistantConfirmBeforeWrite]: boolean
  [PrefKey.AssistantToolPermissionMode]: 'ask' | 'allow-read' | 'allow-safe' | 'allow-all' | 'bypass'
  [PrefKey.AssistantConnectionMode]: 'direct' | 'proxy'
  [PrefKey.AssistantBaseUrl]: string
  [PrefKey.AssistantApiKey]: string
  [PrefKey.AssistantAuthMode]: 'api-key' | 'subscription'
  [PrefKey.AssistantSubscriptionToken]: string
  [PrefKey.AssistantExtraHeaders]: string
  [PrefKey.AssistantSelectionActions]: string
  [PrefKey.AiPoweredSearchEnabled]: boolean
  [PrefKey.AddImportsToTag]: boolean
  [PrefKey.AlwaysCreateNewTagForImports]: boolean
  [PrefKey.ExistingTagForImports]: string | undefined
  [PrefKey.ConflictResolutionStrategy]: ConflictResolutionStrategyValue
  [PrefKey.ConflictResolutionAutoResolve]: boolean
  [PrefKey.SearchIndexEnabled]: boolean
  [PrefKey.SearchQueryCacheSize]: number
  [PrefKey.SearchMinQueryLength]: number
  [PrefKey.MaxIndexedBodyLength]: number
  [PrefKey.MaxIndexedNotes]: number
  [PrefKey.MaxDecryptionWorkers]: number
  [PrefKey.RecentNotesHistory]: RecentNoteEntry[]
  [PrefKey.CustomNotesOrder]: string[]
  [PrefKey.CustomFoldersOrder]: string[]
  [PrefKey.CustomTagsOrder]: string[]
  [PrefKey.StorageMaxUsageBytes]: number
  [PrefKey.UpdateCheckAutoEnabled]: boolean
  [PrefKey.UpdateCheckInterval]: UpdateCheckIntervalValue
  [PrefKey.ShowWhatsNewSection]: boolean
  [PrefKey.SuperNoteImageAlignment]: 'left' | 'center' | 'right'
  /**
   * The editor font family. Empty string means the theme/system default.
   * A value prefixed with `google:` denotes a Google Font that must be loaded
   * dynamically (e.g. `google:Inter`). Any other value is treated as a literal
   * CSS font-family stack / installed local font name.
   */
  [PrefKey.EditorFontFamily]: string
  /**
   * The full set of per-account typography profiles. Always contains at least
   * the built-in Default profile.
   */
  [PrefKey.TypographyProfiles]: TypographyProfile[]
  /**
   * The id of the currently active typography profile (a member of
   * `TypographyProfiles`). Falls back to the Default profile when unset/missing.
   */
  [PrefKey.ActiveTypographyProfileId]: string
  /**
   * The user's custom block-style gallery order — an ordered list of gallery
   * block-type keys. Empty = use the built-in default order. Unknown keys are
   * ignored and newly-added block styles append at the end (forward/backward
   * compatible), so the stored value never needs migrating.
   */
  [PrefKey.BlockStyleGalleryOrder]: BlockTypeKey[]
  /** The Todos general view's filter bar state. See {@link TodoFiltersPreference}. */
  [PrefKey.TodoFilters]: TodoFiltersPreference
}
