export const ElementIds = {
  ContentList: 'notes-scrollable',
  EditorColumn: 'editor-column',
  AssistantColumn: 'assistant-column',
  ConstellationColumn: 'constellation-column',
  DashboardColumn: 'dashboard-column',
  HomeColumn: 'home-column',
  RemindersColumn: 'reminders-column',
  CalendarColumn: 'calendar-aggregate-column',
  TodosColumn: 'todos-column',
  ResearchColumn: 'research-column',
  BookmarksColumn: 'bookmarks-column',
  TemplatesColumn: 'templates-column',
  NotificationsColumn: 'notifications-column',
  FilesColumn: 'files-column',
  WorkflowsColumn: 'workflows-column',
  EditorContent: 'editor-content',
  FileTextPreview: 'file-text-preview',
  FileTitleEditor: 'file-title-editor',
  ItemsColumn: 'items-column',
  NavigationColumn: 'navigation',
  /**
   * Standard Red Notes (t112): NOT unique. The tiled editor mounts one NoteView per
   * open note (NoteGroupView keeps every open tab mounted and hides the inactive
   * ones), so each of the ids below that lives inside a NoteView is rendered once per
   * open note. `document.getElementById` then answers "the note that happens to be
   * first in the document", which is not "the note the user is looking at".
   *
   * The ids are kept because `#note-title-editor` / `#editor-content` / `#note-text-editor`
   * are addressed as the app's print surface by _print.scss and by an e2e selector, and
   * a per-note id would silently kill that styling. What must NOT come back is
   * resolving a specific note THROUGH one of them:
   *   - from inside a NoteView, use a ref (see NoteView#focusTitle), and
   *   - from outside, narrow by `data-srn-note-uuid` (the title input) or
   *     `data-srn-note-view` (a whole tile) first — see Print/PrintNote.ts.
   */
  NoteTextEditor: 'note-text-editor',
  NoteTitleEditor: 'note-title-editor',
  NoteOptionsButton: 'note-options-button',
  RootId: 'app-group-root',
  NoteStatusTooltip: 'note-status-tooltip',
  ItemLinkAutocompleteInput: 'item-link-autocomplete-input',
  SearchBar: 'search-bar',
  ConflictResolutionButton: 'conflict-resolution-button',
  SuperEditor: 'super-editor',
  SuperEditorContent: 'super-editor-content',
} as const
