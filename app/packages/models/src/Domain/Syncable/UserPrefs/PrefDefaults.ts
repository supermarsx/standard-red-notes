import { NativeFeatureIdentifier } from '@standardnotes/features'
import { CollectionSort } from '../../Runtime/Collection/CollectionSort'
import { EditorFontSize } from './EditorFontSize'
import { EditorLineHeight } from './EditorLineHeight'
import { EditorLineWidth } from './EditorLineWidth'
import { PrefKey, PrefValue } from './PrefKey'
import { NewNoteTitleFormat } from './NewNoteTitleFormat'

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
  // Standard Red Notes: the recently-opened-notes history starts empty and is
  // populated as the user opens notes.
  [PrefKey.RecentNotesHistory]: [],
  // Standard Red Notes: custom manual orderings start empty; until the user
  // drags to reorder, the Custom sort falls back to its stable secondary sort.
  [PrefKey.CustomNotesOrder]: [],
  [PrefKey.CustomFoldersOrder]: [],
  [PrefKey.CustomTagsOrder]: [],
} satisfies {
  [key in PrefKey]: PrefValue[key]
}
