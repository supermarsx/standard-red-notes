import { NativeFeatureIdentifier } from '@standardnotes/features'
import { CollectionSort } from '../../Runtime/Collection/CollectionSort'
import { EditorFontSize } from './EditorFontSize'
import { SuperToolbarIconSize } from './SuperToolbarIconSize'
import { EditorLineHeight } from './EditorLineHeight'
import { EditorLineWidth } from './EditorLineWidth'
import { CurrentUserAppearancePreferenceVersion, PrefKey, PrefValue } from './PrefKey'
import { NewNoteTitleFormat } from './NewNoteTitleFormat'
import { DEFAULT_TYPOGRAPHY_PROFILE, DEFAULT_TYPOGRAPHY_PROFILE_ID } from './TypographyProfile'

export const PrefDefaults = {
  [PrefKey.TagsPanelWidth]: 220,
  [PrefKey.NotesPanelWidth]: 350,
  [PrefKey.AssistantPanelWidth]: 400,
  [PrefKey.ConstellationPosition]: 'right',
  [PrefKey.EditorWidth]: null,
  [PrefKey.EditorLeft]: null,
  [PrefKey.DEPRECATED_EditorMonospaceEnabled]: false,
  [PrefKey.EditorSpellcheck]: true,
  [PrefKey.EditorResizersEnabled]: false,
  [PrefKey.DEPRECATED_EditorLineHeight]: EditorLineHeight.Normal,
  [PrefKey.DEPRECATED_EditorLineWidth]: EditorLineWidth.FullWidth,
  [PrefKey.DEPRECATED_EditorFontSize]: EditorFontSize.Normal,
  [PrefKey.SortNotesBy]: CollectionSort.CreatedAt,
  [PrefKey.SortNotesReverse]: false,
  [PrefKey.NotesShowArchived]: false,
  [PrefKey.NotesShowTrashed]: false,
  [PrefKey.NotesHidePinned]: false,
  [PrefKey.NotesHideProtected]: false,
  [PrefKey.NotesHideNotePreview]: false,
  [PrefKey.NotesHideDate]: false,
  [PrefKey.NotesHideTags]: false,
  [PrefKey.NotesHideEditorIcon]: false,
  [PrefKey.DEPRECATED_UseSystemColorScheme]: false,
  [PrefKey.DEPRECATED_UseTranslucentUI]: true,
  [PrefKey.DEPRECATED_AutoLightThemeIdentifier]: 'Default',
  [PrefKey.DEPRECATED_AutoDarkThemeIdentifier]: NativeFeatureIdentifier.TYPES.DarkTheme,
  [PrefKey.NoteAddToParentFolders]: true,
  [PrefKey.NewNoteTitleFormat]: NewNoteTitleFormat.CurrentDateAndTime,
  [PrefKey.CustomNoteTitleFormat]: 'YYYY-MM-DD [at] hh:mm A',
  [PrefKey.UpdateSavingStatusIndicator]: true,
  [PrefKey.PaneGesturesEnabled]: true,
  [PrefKey.UserAppearance]: {
    version: CurrentUserAppearancePreferenceVersion,
    colorSchemeMode: 'dark',
    activeThemes: [],
  },
  [PrefKey.MomentsDefaultTagUuid]: undefined,
  [PrefKey.ClipperDefaultTagUuid]: undefined,
  [PrefKey.DefaultEditorIdentifier]: NativeFeatureIdentifier.TYPES.PlainEditor,
  [PrefKey.SuperNoteExportFormat]: 'json',
  [PrefKey.SuperNoteExportEmbedBehavior]: 'reference',
  [PrefKey.SuperNoteExportUseMDFrontmatter]: true,
  [PrefKey.SuperNoteExportPDFPageSize]: 'A4',
  [PrefKey.SuperNoteImageAlignment]: 'left',
  [PrefKey.EditorFontFamily]: '',
  [PrefKey.SystemViewPreferences]: {},
  [PrefKey.AuthenticatorNames]: '',
  [PrefKey.ComponentPreferences]: {},
  [PrefKey.DEPRECATED_ActiveThemes]: [],
  [PrefKey.ActiveComponents]: [],
  [PrefKey.AlwaysShowSuperToolbar]: true,
  // Standard Red Notes: default to the slightly smaller Small toolbar icons;
  // users can bump this to Medium (previous size) or Large.
  [PrefKey.SuperToolbarIconSize]: SuperToolbarIconSize.Small,
  [PrefKey.AssistantProvider]: '',
  [PrefKey.AssistantModel]: '',
  [PrefKey.AssistantConfirmBeforeWrite]: true,
  [PrefKey.AssistantConnectionMode]: 'direct',
  [PrefKey.AssistantBaseUrl]: 'http://localhost:1234/v1',
  [PrefKey.AssistantApiKey]: '',
  [PrefKey.AssistantAuthMode]: 'api-key',
  [PrefKey.AssistantSubscriptionToken]: '',
  [PrefKey.AssistantExtraHeaders]: '',
  [PrefKey.AssistantSelectionActions]: '',
  [PrefKey.AiPoweredSearchEnabled]: false,
  [PrefKey.AddImportsToTag]: true,
  [PrefKey.AlwaysCreateNewTagForImports]: true,
  [PrefKey.ExistingTagForImports]: undefined,
  // Standard Red Notes: default to surfacing conflicts for manual review, with
  // auto-resolution off. The server may override the strategy default via the
  // CONFLICT_RESOLUTION_STRATEGY setting; the client pref always wins when set.
  [PrefKey.ConflictResolutionStrategy]: 'ask',
  [PrefKey.ConflictResolutionAutoResolve]: false,
  // Standard Red Notes: the client-side search index is on by default and falls
  // back to substring search for queries shorter than SearchMinQueryLength. The
  // query-result LRU is capped at SearchQueryCacheSize entries.
  [PrefKey.SearchIndexEnabled]: true,
  [PrefKey.SearchQueryCacheSize]: 50,
  [PrefKey.SearchMinQueryLength]: 2,
  // MaxIndexedBodyLength caps indexed characters per note (matches SearchIndex's
  // internal default). MaxIndexedNotes is the displayable-note ceiling above which
  // the full Tier-2 index build is skipped to avoid OOM on very large accounts.
  [PrefKey.MaxIndexedBodyLength]: 50000,
  [PrefKey.MaxIndexedNotes]: 50000,
  // Standard Red Notes: 0 == "auto" — the decryption pool derives its ceiling from
  // hardwareConcurrency - 1 and spawns workers lazily, so the default never spins
  // more workers than a load actually needs.
  [PrefKey.MaxDecryptionWorkers]: 0,
  // Standard Red Notes: the recently-opened-notes history starts empty and is
  // populated as the user opens notes.
  [PrefKey.RecentNotesHistory]: [],
  // Standard Red Notes: custom manual orderings start empty; until the user
  // drags to reorder, the Custom sort falls back to its stable secondary sort.
  [PrefKey.CustomNotesOrder]: [],
  [PrefKey.CustomFoldersOrder]: [],
  [PrefKey.CustomTagsOrder]: [],
  // Standard Red Notes: 0 == Unlimited — no user cap on local storage usage; the
  // Storage pane measures against the browser quota estimate instead. Any value
  // > 0 is an advisory (soft) cap in bytes; it never blocks saving or syncing.
  [PrefKey.StorageMaxUsageBytes]: 0,
  // Standard Red Notes: automatic update checks default ON, once a week. The
  // toggle and the 'never' interval overlap deliberately — either disables
  // automatic checks. Last-checked time is device-local, not a synced pref.
  [PrefKey.UpdateCheckAutoEnabled]: true,
  [PrefKey.UpdateCheckInterval]: 'every-week',
  // Standard Red Notes: the "What's New" section in Preferences is hidden by
  // default; users opt in via Preferences → General → Updates. Hiding it also
  // suppresses the unread-changelog dot and the open-to-What's-New behavior.
  [PrefKey.ShowWhatsNewSection]: false,
  // Standard Red Notes: ship with only the built-in Default profile active. Its
  // per-block styles reproduce editor.scss, so the default active state is a
  // zero-visual-change no-op for existing notes.
  [PrefKey.TypographyProfiles]: [DEFAULT_TYPOGRAPHY_PROFILE],
  [PrefKey.ActiveTypographyProfileId]: DEFAULT_TYPOGRAPHY_PROFILE_ID,
  // Standard Red Notes: empty = "no customization → use the code default gallery
  // order" (GALLERY_BLOCKS). Storing the full default here instead would fossilize
  // the order and force sync migrations whenever the block-style set changes.
  [PrefKey.BlockStyleGalleryOrder]: [],
} satisfies {
  [key in PrefKey]: PrefValue[key]
}
