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
 *
 * Surface namespaces (filled incrementally by the app-wide i18n sweep; each is
 * OPTIONAL in non-English locales, which fall back to English until translated):
 *   editor, notes, files, search, dialogs, auth, sharing, settings, errors,
 *   onboarding.
 */
import editor from './en/editor'
import notes from './en/notes'
import files from './en/files'
import search from './en/search'
import dialogs from './en/dialogs'
import auth from './en/auth'
import sharing from './en/sharing'
import settings from './en/settings'
import errors from './en/errors'
import onboarding from './en/onboarding'

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
    untagged: 'Without topics',
    conflicts: 'Conflicts',
    views: 'Views',
    smartViews: 'Smart Views',
    tags: 'Topics',
    folders: 'Folders',
    favorites: 'Favorites',
    dashboard: 'Dashboard',
    createNewNote: 'Create a new note',
    createNewTag: 'Create a new topic',
    createNewFolder: 'Create a new folder',
    createNewSmartView: 'Create a new smart view',
    searchTags: 'Search topics…',
    noTagsFound: 'No topics found. Try a different search.',
    noSmartViewsFound: 'No smart views found. Try a different search.',
    collapseTagsPanel: 'Collapse topics panel',
    expandTagsPanel: 'Expand topics panel',
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
  editor,
  notes,
  files,
  search,
  dialogs,
  auth,
  sharing,
  settings,
  errors,
  onboarding,
}

/**
 * The original four namespaces are REQUIRED in every locale and strictly keyed:
 * they are fully translated everywhere, and `tsc` must keep catching any
 * missing/misspelled key so existing translations never silently regress.
 */
type CoreNamespace = 'common' | 'navigation' | 'account' | 'preferences'

/**
 * The shape every locale must satisfy.
 *  - Core namespaces: required, every key required (strict parity).
 *  - Surface namespaces (editor, notes, …): OPTIONAL, and their keys optional,
 *    so a locale may translate them incrementally while i18next falls back to
 *    English for anything not yet provided. Object-literal excess-property
 *    checks still flag misspelled keys, so typo protection is preserved.
 */
export type LocaleResource = {
  [Namespace in CoreNamespace]: {
    [Key in keyof (typeof en)[Namespace]]: string
  }
} & {
  [Namespace in Exclude<keyof typeof en, CoreNamespace>]?: {
    [Key in keyof (typeof en)[Namespace]]?: string
  }
}

export default en
