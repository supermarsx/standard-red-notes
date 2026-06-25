/**
 * English strings for the notes surface (note list, note view chrome, note
 * context menus, status indicators, item actions). Source of truth: other
 * locales fall back to these until translated.
 */
const notes = {
  // ContentListView
  notesAndFiles: 'Notes & Files',
  selectAllItems: 'Select all items',
  selectedCount: '{{count}} selected',
  cancelMultipleSelection: 'Cancel multiple selection',
  noFilesInFolder: 'No files in this folder.',
  noItems: 'No items.',
  loading: 'Loading...',
  uploadFileWithShortcut: 'Upload file {{shortcut}}',
  createNoteInTopicWithShortcut: 'Create a new note in the selected topic {{shortcut}}',
  dropFilesToUpload: 'Drop your files to upload and link them to topic "{{title}}"',

  // EmptyFilesView
  noFilesYet: "You don't have any files yet",
  filesAttachedAppearHere:
    'Files attached to your notes appear here. You can also upload files directly from this page.',
  uploadFiles: 'Upload files',

  // ContentListHeader
  syncing: 'Syncing...',
  loadingItemsProgress: 'Loading {{current}}/{{total}} items...',
  potentiallyOutOfSync: 'Potentially Out of Sync',
  openDisplayOptionsMenu: 'Open display options menu',
  displayOptionsMenu: 'Display options menu',
  displayOptions: 'Display options',
  expandTopicsPanel: 'Expand topics panel',
  collapseNotesPanel: 'Collapse notes panel',

  // AddItemMenuButton
  addItem: 'Add item',
  uploadFolder: 'Upload folder',
  takePhoto: 'Take photo',
  recordVideo: 'Record video',

  // SearchButton
  searchPlaceholder: 'Search...',

  // DisplayOptionsMenu
  notesListOptionsMenu: 'Notes list options menu',
  preferencesFor: 'Preferences for',
  global: 'Global',
  reset: 'Reset',
  upgradeForPerTopicPreferences: 'Upgrade for per-topic preferences',
  perTopicPreferencesMessageWithDaily:
    'Create powerful workflows and organizational layouts with per-topic display preferences and the all-new Daily Notebook calendar layout.',
  perTopicPreferencesMessage:
    'Create powerful workflows and organizational layouts with per-topic display preferences.',
  sortBy: 'Sort by',
  relevanceBestMatch: 'Relevance (best match)',
  dateModified: 'Date modified',
  creationDate: 'Creation date',
  title: 'Title',
  customDragToReorder: 'Custom (drag to reorder)',
  view: 'View',
  showNotePreview: 'Show note preview',
  showDate: 'Show date',
  showTags: 'Show tags',
  showIcon: 'Show icon',
  other: 'Other',
  showPinned: 'Show pinned',
  showProtected: 'Show protected',
  showArchived: 'Show archived',
  showTrashed: 'Show trashed',
  dailyNotebook: 'Daily Notebook',
  labs: 'Labs',
  dailyNotebookDescription: 'Capture new notes daily with a calendar-based layout',
  tableView: 'Table view',
  tableViewDescription: 'Display the notes and files in the current tag in a table layout',
  newNoteDefaults: 'New note defaults',

  // NewNotePreferences
  noteType: 'Note Type',
  selectDefaultNoteType: 'Select the default note type',
  titleFormat: 'Title Format',
  selectTitleFormat: 'Select the format for the note title',
  customFormatPlaceholder: 'e.g. YYYY-MM-DD',
  preview: 'Preview: ',
  useBracketsToEscape: '. Use ',
  toEscapeFormatting: ' to escape formatting.',

  // ListItemMetadata
  protected: 'Protected',
  modified: 'Modified',
  now: 'Now',

  // ListItemFlagIcons
  editingDisabled: 'Editing Disabled',
  trashed: 'Trashed',
  archived: 'Archived',
  files: 'Files',
  starred: 'Starred',
  fileBackedUpLocally: 'File is backed up locally',

  // ListItemConflictIndicator
  conflictedCopy: 'Conflicted Copy',

  // FilesFolderBar
  allFiles: 'All Files',
  noFolder: 'No folder',
  folderNamePlaceholder: 'Folder name',
  createNewFolder: 'Create a new folder',
  newFolder: 'New folder',

  // DailyContentList
  currentStreak: 'Current Streak',
  dayWithCount_one: 'Day',
  dayWithCount_other: 'Days',
}

export default notes
