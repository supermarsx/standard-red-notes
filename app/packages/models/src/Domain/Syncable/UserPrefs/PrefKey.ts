import { CollectionSortProperty } from '../../Runtime/Collection/CollectionSort'
import { SystemViewId } from '../SmartView'
import { TagPreferences } from '../Tag'
import { NewNoteTitleFormat } from './NewNoteTitleFormat'
import { EditorLineHeight } from './EditorLineHeight'
import { EditorLineWidth } from './EditorLineWidth'
import { EditorFontSize } from './EditorFontSize'
import { AllComponentPreferences } from './ComponentPreferences'

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
  ComponentPreferences = 'componentPreferences',
  ActiveComponents = 'activeComponents',
  AlwaysShowSuperToolbar = 'alwaysShowSuperToolbar',
  AssistantProvider = 'assistantProvider',
  AssistantModel = 'assistantModel',
  AssistantConfirmBeforeWrite = 'assistantConfirmBeforeWrite',
  AssistantConnectionMode = 'assistantConnectionMode',
  AssistantBaseUrl = 'assistantBaseUrl',
  AssistantApiKey = 'assistantApiKey',
  AssistantSelectionActions = 'assistantSelectionActions',
  AssistantPanelWidth = 'assistantPanelWidth',
  AiPoweredSearchEnabled = 'aiPoweredSearchEnabled',
  ConstellationPosition = 'constellationPosition',
  AddImportsToTag = 'addImportsToTag',
  AlwaysCreateNewTagForImports = 'alwaysCreateNewTagForImports',
  ExistingTagForImports = 'existingTagForImports',
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
  [PrefKey.SuperNoteExportFormat]: 'json' | 'md' | 'html' | 'pdf'
  [PrefKey.SuperNoteExportEmbedBehavior]: 'reference' | 'inline' | 'separate'
  [PrefKey.SuperNoteExportUseMDFrontmatter]: boolean
  [PrefKey.SuperNoteExportPDFPageSize]: 'A3' | 'A4' | 'LETTER' | 'LEGAL' | 'TABLOID'
  [PrefKey.AuthenticatorNames]: string
  [PrefKey.PaneGesturesEnabled]: boolean
  [PrefKey.ComponentPreferences]: AllComponentPreferences
  [PrefKey.ActiveComponents]: string[]
  [PrefKey.AlwaysShowSuperToolbar]: boolean
  [PrefKey.AssistantProvider]: string
  [PrefKey.AssistantModel]: string
  [PrefKey.AssistantConfirmBeforeWrite]: boolean
  [PrefKey.AssistantConnectionMode]: 'direct' | 'proxy'
  [PrefKey.AssistantBaseUrl]: string
  [PrefKey.AssistantApiKey]: string
  [PrefKey.AssistantSelectionActions]: string
  [PrefKey.AiPoweredSearchEnabled]: boolean
  [PrefKey.AddImportsToTag]: boolean
  [PrefKey.AlwaysCreateNewTagForImports]: boolean
  [PrefKey.ExistingTagForImports]: string | undefined
  [PrefKey.SuperNoteImageAlignment]: 'left' | 'center' | 'right'
  /**
   * The editor font family. Empty string means the theme/system default.
   * A value prefixed with `google:` denotes a Google Font that must be loaded
   * dynamically (e.g. `google:Inter`). Any other value is treated as a literal
   * CSS font-family stack / installed local font name.
   */
  [PrefKey.EditorFontFamily]: string
}
