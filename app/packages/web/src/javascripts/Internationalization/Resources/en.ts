/**
 * English base resource. This is the SOURCE OF TRUTH for translation keys: its
 * shape (`LocaleResource`) is inferred from this object, and every other locale
 * must satisfy the same shape. English is also the fallback language, so any
 * missing key in another locale renders the English string here.
 *
 * Namespaces:
 *   - common:      reusable actions/labels (Save, Cancel, Delete, Search, ...)
 *   - navigation:  sidebar / smart views / sections
 *   - account:     account menu + sign in/out
 *   - preferences: preferences window labels, incl. the language switcher
 */
const en = {
  common: {
    save: 'Save',
    cancel: 'Cancel',
    delete: 'Delete',
    confirm: 'Confirm',
    close: 'Close',
    edit: 'Edit',
    rename: 'Rename',
    duplicate: 'Duplicate',
    remove: 'Remove',
    open: 'Open',
    create: 'Create',
    add: 'Add',
    done: 'Done',
    back: 'Back',
    next: 'Next',
    search: 'Search',
    clear: 'Clear',
    loading: 'Loading…',
    copy: 'Copy',
    copied: 'Copied',
    download: 'Download',
    upload: 'Upload',
    export: 'Export',
    import: 'Import',
    yes: 'Yes',
    no: 'No',
    enabled: 'Enabled',
    disabled: 'Disabled',
    on: 'On',
    off: 'Off',
    learnMore: 'Learn more',
    options: 'Options',
    settings: 'Settings',
    preferences: 'Preferences',
    help: 'Help',
    pin: 'Pin',
    unpin: 'Unpin',
    star: 'Star',
    unstar: 'Unstar',
    archive: 'Archive',
    unarchive: 'Unarchive',
    restore: 'Restore',
    moveToTrash: 'Move to Trash',
    deletePermanently: 'Delete permanently',
    protect: 'Protect',
    unprotect: 'Unprotect',
  },
  navigation: {
    notes: 'Notes',
    allNotes: 'All notes',
    files: 'Files',
    starred: 'Starred',
    archived: 'Archived',
    trash: 'Trash',
    untagged: 'Untagged',
    conflicts: 'Conflicts',
    views: 'Views',
    smartViews: 'Smart Views',
    tags: 'Tags',
    folders: 'Folders',
    favorites: 'Favorites',
    dashboard: 'Dashboard',
    createNewNote: 'Create a new note',
    createNewTag: 'Create a new tag',
    createNewFolder: 'Create a new folder',
    createNewSmartView: 'Create a new smart view',
    searchTags: 'Search tags…',
    noTagsFound: 'No tags found. Try a different search.',
    noSmartViewsFound: 'No smart views found. Try a different search.',
    collapseTagsPanel: 'Collapse tags panel',
    expandTagsPanel: 'Expand tags panel',
    goToItemsList: 'Go to items list',
    goToAccountMenu: 'Go to account menu',
    openPreferences: 'Open preferences',
  },
  account: {
    account: 'Account',
    signIn: 'Sign in',
    signOut: 'Sign out',
    signUp: 'Register',
    register: 'Register',
    you: 'You',
    encryptionOn: 'End-to-end encryption on',
    notSignedIn: 'You are not signed in',
    signInOrRegister: 'Sign in or register to sync your notes',
    email: 'Email',
    password: 'Password',
    confirmPassword: 'Confirm password',
    syncNow: 'Sync now',
    lastSynced: 'Last synced',
    importData: 'Import',
    switchWorkspace: 'Switch workspace',
    lockApplication: 'Lock application',
    helpAndFeedback: 'Help & feedback',
  },
  preferences: {
    title: 'Preferences',
    general: 'General',
    account: 'Account',
    security: 'Security',
    appearance: 'Appearance',
    backups: 'Backups',
    listed: 'Listed',
    plugins: 'Plugins',
    whatsNew: "What's New",
    helpAndFeedback: 'Help & feedback',
    language: 'Language',
    languageTitle: 'Language',
    languageDescription:
      'Choose the language used throughout the app interface. The app falls back to English for anything not yet translated.',
    languageChanged: 'Language updated',
    defaults: 'Defaults',
    tools: 'Tools',
    spellcheck: 'Spellcheck',
    labs: 'Labs',
  },
}

/**
 * The shape every locale must satisfy. Values are typed as `string` (not the
 * English string literals), so translations only have to match the KEY
 * structure of `en`, while `tsc` still catches missing or misspelled keys.
 */
export type LocaleResource = {
  [Namespace in keyof typeof en]: {
    [Key in keyof (typeof en)[Namespace]]: string
  }
}

export default en
